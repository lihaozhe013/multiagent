import type { Database } from 'bun:sqlite';
import {
  StorageEngine,
  TaskLockedError,
  TaskNotFoundError,
  QueueBusyError,
  parseTaskRow,
} from './store.ts';
import type {
  Task,
  TaskRow,
  TaskRun,
  QueueState,
  CreateTaskInput,
  UpdateTaskInput,
  SettleOutcome,
  PipelineStage,
  QueueRunState,
} from '../types/index.ts';

export class QueueController {
  private readonly db: Database;

  constructor(storage: StorageEngine | Database) {
    if (storage instanceof StorageEngine) {
      this.db = storage.db;
    } else {
      this.db = storage;
    }
  }

  public createTask(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const verifyCommandsJson = input.verify_commands ? JSON.stringify(input.verify_commands) : null;
    const maxRetries = input.max_retries ?? 3;
    const agentId = input.agent_id ?? 'pi';

    const maxRankRow = this.db
      .query<{ max_rank: number | null }, []>('SELECT MAX(rank) AS max_rank FROM tasks')
      .get();
    const rank = (maxRankRow?.max_rank ?? 0) + 10;

    const query = this.db.query<
      TaskRow,
      [string | null, string, string, string, string, number, string | null, number, string, string]
    >(`
      INSERT INTO tasks (
        batch_id, title, description, agent_id, cwd, rank,
        verify_commands, max_retries, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const row = query.get(
      input.batch_id ?? null,
      input.title,
      input.description,
      agentId,
      input.cwd,
      rank,
      verifyCommandsJson,
      maxRetries,
      now,
      now,
    );

    if (!row) {
      throw new Error('Failed to create task');
    }

    return parseTaskRow(row);
  }

  public getTask(id: number): Task | null {
    const row = this.db.query<TaskRow, [number]>('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? parseTaskRow(row) : null;
  }

  public listTasks(filter?: { status?: string; batch_id?: string }): Task[] {
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const params: (string | number)[] = [];

    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    if (filter?.batch_id) {
      sql += ' AND batch_id = ?';
      params.push(filter.batch_id);
    }

    sql += ' ORDER BY CASE status WHEN \'IN_PROGRESS\' THEN 0 WHEN \'PENDING\' THEN 1 ELSE 2 END, rank ASC, id ASC';

    const rows = this.db.query<TaskRow, (string | number)[]>(sql).all(...params);
    return rows.map(parseTaskRow);
  }

  public updateTask(id: number, input: UpdateTaskInput): Task {
    const existing = this.getTask(id);
    if (!existing) {
      throw new TaskNotFoundError(id);
    }
    if (existing.status === 'IN_PROGRESS') {
      throw new TaskLockedError(id);
    }

    const updates: string[] = ['updated_at = ?'];
    const now = new Date().toISOString();
    const params: (string | number | null)[] = [now];

    if (input.title !== undefined) {
      updates.push('title = ?');
      params.push(input.title);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }
    if (input.cwd !== undefined) {
      updates.push('cwd = ?');
      params.push(input.cwd);
    }
    if (input.agent_id !== undefined) {
      updates.push('agent_id = ?');
      params.push(input.agent_id);
    }
    if (input.verify_commands !== undefined) {
      updates.push('verify_commands = ?');
      params.push(JSON.stringify(input.verify_commands));
    }
    if (input.max_retries !== undefined) {
      updates.push('max_retries = ?');
      params.push(input.max_retries);
    }

    params.push(id);
    const sql = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ? RETURNING *`;
    const row = this.db.query<TaskRow, (string | number | null)[]>(sql).get(...params);
    if (!row) {
      throw new TaskNotFoundError(id);
    }
    return parseTaskRow(row);
  }

  public deleteTask(id: number): boolean {
    const existing = this.getTask(id);
    if (!existing) {
      throw new TaskNotFoundError(id);
    }
    if (existing.status === 'IN_PROGRESS') {
      throw new TaskLockedError(id);
    }

    const result = this.db.run('DELETE FROM tasks WHERE id = ?', [id]);
    return result.changes > 0;
  }

  public claimNext(): { task: Task; token: string } | null {
    const tx = this.db.transaction(() => {
      // 1. Guard against any currently running task
      const active = this.db
        .query<TaskRow, []>("SELECT * FROM tasks WHERE status = 'IN_PROGRESS' LIMIT 1")
        .get();
      if (active) {
        throw new QueueBusyError(`Task ${active.id} is already in progress`);
      }

      // 2. Check if queue is paused
      const qState = this.getQueueState();
      if (qState.state === 'PAUSED') {
        return null;
      }

      // 3. Select next pending task
      const nextTask = this.db
        .query<TaskRow, []>(
          "SELECT * FROM tasks WHERE status = 'PENDING' ORDER BY rank ASC, id ASC LIMIT 1"
        )
        .get();

      if (!nextTask) {
        // No pending tasks, transition queue to IDLE
        this.db.run(
          "UPDATE queue_state SET state = 'IDLE', active_task_id = NULL, active_stage = 'IDLE', updated_at = datetime('now') WHERE id = 1"
        );
        return null;
      }

      const token = crypto.randomUUID();
      const now = new Date().toISOString();

      const updatedRow = this.db
        .query<TaskRow, [string, string, number]>(
          `UPDATE tasks 
           SET status = 'IN_PROGRESS', claimed_token = ?, current_stage = 'CODER', updated_at = ?
           WHERE id = ? AND status = 'PENDING'
           RETURNING *`
        )
        .get(token, now, nextTask.id);

      if (!updatedRow) {
        return null;
      }

      this.db.run(
        "UPDATE queue_state SET state = 'RUNNING', active_task_id = ?, active_stage = 'CODER', updated_at = ? WHERE id = 1",
        [nextTask.id, now]
      );

      return {
        task: parseTaskRow(updatedRow),
        token,
      };
    });

    return tx();
  }

  public updateStage(taskId: number, token: string, stage: PipelineStage): void {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const res = this.db.run(
        "UPDATE tasks SET current_stage = ?, updated_at = ? WHERE id = ? AND claimed_token = ? AND status = 'IN_PROGRESS'",
        [stage, now, taskId, token]
      );
      if (res.changes === 0) {
        throw new Error(`Cannot update stage for task ${taskId}: invalid token or not IN_PROGRESS`);
      }

      this.db.run(
        "UPDATE queue_state SET active_stage = ?, updated_at = ? WHERE id = 1 AND active_task_id = ?",
        [stage, now, taskId]
      );
    });
    tx();
  }

  public incrementRetry(taskId: number, token: string, feedback?: string): number {
    const tx = this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!task || task.claimed_token !== token) {
        throw new Error(`Cannot increment retry: task ${taskId} token mismatch or not found`);
      }
      const newCount = task.retry_count + 1;
      const now = new Date().toISOString();

      this.db.run(
        "UPDATE tasks SET retry_count = ?, error_tail = ?, current_stage = 'CODER', updated_at = ? WHERE id = ? AND claimed_token = ?",
        [newCount, feedback ?? null, now, taskId, token]
      );

      this.db.run(
        "UPDATE queue_state SET active_stage = 'CODER', updated_at = ? WHERE id = 1 AND active_task_id = ?",
        [now, taskId]
      );

      return newCount;
    });

    return tx();
  }

  public settle(taskId: number, token: string, outcome: SettleOutcome): Task {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const res = this.db
        .query<TaskRow, [string, string | null, string | null, string, string, number, string]>(
          `UPDATE tasks
           SET status = ?, result_summary = ?, error_tail = ?, finished_at = ?, current_stage = 'IDLE', claimed_token = NULL, updated_at = ?
           WHERE id = ? AND claimed_token = ? AND status = 'IN_PROGRESS'
           RETURNING *`
        )
        .get(
          outcome.status,
          outcome.result_summary ?? null,
          outcome.error_tail ?? null,
          now,
          now,
          taskId,
          token
        );

      if (!res) {
        throw new Error(`Failed to settle task ${taskId}: token mismatch or not IN_PROGRESS`);
      }

      this.db.run(
        "UPDATE queue_state SET active_task_id = NULL, active_stage = 'IDLE', updated_at = ? WHERE id = 1",
        [now]
      );

      return parseTaskRow(res);
    });

    return tx();
  }

  public recordRun(input: {
    taskId: number;
    attempt: number;
    stage: PipelineStage;
    agentId: string;
    status: 'SUCCESS' | 'FAILED' | 'REJECTED';
    logTail?: string;
    feedback?: string;
    startedAt: string;
    finishedAt?: string;
  }): TaskRun {
    const query = this.db.query<
      TaskRun,
      [number, number, string, string, string, string | null, string | null, string, string | null]
    >(`
      INSERT INTO task_runs (
        task_id, attempt, stage, agent_id, status, log_tail, feedback, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const row = query.get(
      input.taskId,
      input.attempt,
      input.stage,
      input.agentId,
      input.status,
      input.logTail ?? null,
      input.feedback ?? null,
      input.startedAt,
      input.finishedAt ?? new Date().toISOString()
    );

    if (!row) {
      throw new Error(`Failed to record task run for task ${input.taskId}`);
    }
    return row;
  }

  public listRuns(taskId: number): TaskRun[] {
    return this.db
      .query<TaskRun, [number]>('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id ASC')
      .all(taskId);
  }

  public retryTask(id: number): Task {
    const tx = this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) {
        throw new TaskNotFoundError(id);
      }
      if (task.status === 'IN_PROGRESS') {
        throw new TaskLockedError(id);
      }

      const now = new Date().toISOString();
      const updated = this.db
        .query<TaskRow, [string, number]>(
          `UPDATE tasks
           SET status = 'PENDING', retry_count = 0, current_stage = 'IDLE',
               result_summary = NULL, error_tail = NULL, finished_at = NULL, updated_at = ?
           WHERE id = ?
           RETURNING *`
        )
        .get(now, id);

      if (!updated) {
        throw new TaskNotFoundError(id);
      }
      return parseTaskRow(updated);
    });

    return tx();
  }

  public reorderPending(orderedIds: number[]): void {
    const tx = this.db.transaction(() => {
      let rank = 10;
      for (const id of orderedIds) {
        this.db.run(
          "UPDATE tasks SET rank = ?, updated_at = datetime('now') WHERE id = ? AND status = 'PENDING'",
          [rank, id]
        );
        rank += 10;
      }
    });
    tx();
  }

  public recoverInterrupted(): number {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.run(
        `UPDATE tasks
         SET status = 'BLOCKED', current_stage = 'IDLE', claimed_token = NULL,
             result_summary = 'Process interrupted (orchestrator restarted during run)',
             finished_at = ?, updated_at = ?
         WHERE status = 'IN_PROGRESS'`,
        [now, now]
      );

      this.db.run(
        "UPDATE queue_state SET state = 'IDLE', active_task_id = NULL, active_stage = 'IDLE', updated_at = ? WHERE id = 1",
        [now]
      );

      return result.changes;
    });

    return tx();
  }

  public getQueueState(): QueueState {
    const row = this.db.query<QueueState, []>('SELECT * FROM queue_state WHERE id = 1').get();
    if (!row) {
      throw new Error('Corrupt queue_state: singleton row missing');
    }
    return row;
  }

  public setQueueState(state: QueueRunState, reason?: string): void {
    const now = new Date().toISOString();
    this.db.run(
      'UPDATE queue_state SET state = ?, paused_reason = ?, updated_at = ? WHERE id = 1',
      [state, reason ?? null, now]
    );
  }
}
