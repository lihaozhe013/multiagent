import type { Database } from 'bun:sqlite';
import type {
  BridgeNotificationRow,
  BridgeTask,
  BridgeTaskRow,
  BridgeTaskStatus,
  CreateBridgeTaskInput,
  NotificationStatus,
  SettleTaskInput
} from '../types.ts';

function parseModifiedFiles(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function mapTaskRow(row: BridgeTaskRow): BridgeTask {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    conversationId: row.conversation_id,
    userId: row.user_id,
    prompt: row.prompt,
    relativePath: row.relative_path,
    resolvedCwd: row.resolved_cwd,
    agentId: row.agent_id,
    status: row.status,
    outcome: row.outcome,
    reported: row.reported === 1,
    summary: row.summary,
    modifiedFiles: parseModifiedFiles(row.modified_files),
    verificationPassed:
      row.verification_passed === null ? null : row.verification_passed === 1,
    notes: row.notes,
    exitCode: row.exit_code,
    logTail: row.log_tail,
    notificationStatus: row.notification_status,
    recoveryNotified: row.recovery_notified === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class BridgeRepository {
  public readonly db: Database;
  private readonly dedupeWindowMs: number;

  constructor(db: Database, options: { dedupeWindowMs?: number } = {}) {
    this.db = db;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 0;
  }

  public createTask(input: CreateBridgeTaskInput): {
    task: BridgeTask;
    duplicate: boolean;
  } {
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { task: existing, duplicate: true };
    }

    if (this.dedupeWindowMs > 0) {
      const cutoff = new Date(Date.now() - this.dedupeWindowMs).toISOString();
      const duplicate = this.findRecentDuplicate(input, cutoff);
      if (duplicate) return { task: duplicate, duplicate: true };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      const row = this.db
        .query<
          BridgeTaskRow,
          [
            string,
            string | null,
            string,
            string,
            string,
            string | null,
            string,
            string,
            string,
            string
          ]
        >(`
          INSERT INTO bridge_tasks (
            id, idempotency_key, conversation_id, user_id, prompt, relative_path,
            resolved_cwd, agent_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING *
        `)
        .get(
          id,
          input.idempotencyKey ?? null,
          input.conversationId,
          input.userId,
          input.prompt,
          input.relativePath ?? null,
          input.resolvedCwd,
          input.agentId,
          now,
          now
        );

      if (!row) throw new Error('Failed to create bridge task');
      this.addEvent(id, 'task_created', {
        conversationId: input.conversationId,
        userId: input.userId,
        relativePath: input.relativePath ?? null
      });
      return { task: mapTaskRow(row), duplicate: false };
    } catch (error) {
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const existing = this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) return { task: existing, duplicate: true };
      }
      throw error;
    }
  }

  public findByIdempotencyKey(key: string): BridgeTask | null {
    const row = this.db
      .query<BridgeTaskRow, [string]>('SELECT * FROM bridge_tasks WHERE idempotency_key = ?')
      .get(key);
    return row ? mapTaskRow(row) : null;
  }

  public findRecentDuplicate(
    input: CreateBridgeTaskInput,
    cutoffIso: string
  ): BridgeTask | null {
    const row = this.db
      .query<BridgeTaskRow, [string, string, string, string, string]>(`
        SELECT * FROM bridge_tasks
        WHERE created_at >= ?
          AND conversation_id = ?
          AND user_id = ?
          AND COALESCE(relative_path, '') = ?
          AND trim(prompt) = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(
        cutoffIso,
        input.conversationId,
        input.userId,
        input.relativePath ?? '',
        input.prompt.trim()
      );
    return row ? mapTaskRow(row) : null;
  }

  public getTask(id: string): BridgeTask | null {
    const row = this.db
      .query<BridgeTaskRow, [string]>('SELECT * FROM bridge_tasks WHERE id = ?')
      .get(id);
    return row ? mapTaskRow(row) : null;
  }

  public listTasks(filter: { status?: BridgeTaskStatus; limit?: number } = {}): BridgeTask[] {
    const params: (string | number)[] = [];
    let sql = 'SELECT * FROM bridge_tasks WHERE 1=1';

    if (filter.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(filter.limit ?? 50);

    const rows = this.db
      .query<BridgeTaskRow, (string | number)[]>(sql)
      .all(...params);
    return rows.map(mapTaskRow);
  }

  public countQueued(): number {
    const row = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM bridge_tasks WHERE status = 'QUEUED'"
      )
      .get();
    return row?.count ?? 0;
  }

  public countByStatus(): Record<BridgeTaskStatus, number> {
    const rows = this.db
      .query<{ status: BridgeTaskStatus; count: number }, []>(
        'SELECT status, COUNT(*) AS count FROM bridge_tasks GROUP BY status'
      )
      .all();
    const result: Record<BridgeTaskStatus, number> = {
      QUEUED: 0,
      RUNNING: 0,
      SETTLED: 0
    };
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }

  public claimNextQueued(): BridgeTask | null {
    const transaction = this.db.transaction(() => {
      const next = this.db
        .query<BridgeTaskRow, []>(
          "SELECT * FROM bridge_tasks WHERE status = 'QUEUED' ORDER BY created_at ASC, rowid ASC LIMIT 1"
        )
        .get();
      if (!next) return null;

      const now = new Date().toISOString();
      const updated = this.db
        .query<BridgeTaskRow, [string, string, string]>(`
          UPDATE bridge_tasks
          SET status = 'RUNNING', started_at = ?, updated_at = ?
          WHERE id = ? AND status = 'QUEUED'
          RETURNING *
        `)
        .get(now, now, next.id);

      if (!updated) return null;
      this.addEvent(updated.id, 'task_started', {});
      return mapTaskRow(updated);
    });

    return transaction();
  }

  public settleTask(id: string, input: SettleTaskInput): BridgeTask | null {
    const transaction = this.db.transaction(() => {
      const now = new Date().toISOString();
      const row = this.db
        .query<
          BridgeTaskRow,
          [
            string,
            number,
            string,
            string,
            number | null,
            string | null,
            number | null,
            string | null,
            string,
            string,
            string
          ]
        >(`
          UPDATE bridge_tasks
          SET status = 'SETTLED',
              outcome = ?,
              reported = ?,
              summary = ?,
              modified_files = ?,
              verification_passed = ?,
              notes = ?,
              exit_code = ?,
              log_tail = ?,
              finished_at = ?,
              updated_at = ?
          WHERE id = ? AND status = 'RUNNING' AND reported = 0
          RETURNING *
        `)
        .get(
          input.outcome,
          input.reported ? 1 : 0,
          input.summary,
          JSON.stringify(input.modifiedFiles ?? []),
          input.verificationPassed === null || input.verificationPassed === undefined
            ? null
            : input.verificationPassed
              ? 1
              : 0,
          input.notes ?? null,
          input.exitCode ?? null,
          input.logTail ?? null,
          now,
          now,
          id
        );

      if (!row) return null;
      this.addEvent(id, 'task_settled', {
        outcome: input.outcome,
        reported: input.reported
      });
      return mapTaskRow(row);
    });

    return transaction();
  }

  public markRunningInterrupted(): BridgeTask[] {
    const transaction = this.db.transaction(() => {
      const now = new Date().toISOString();
      const rows = this.db
        .query<BridgeTaskRow, [string, string, string]>(`
          UPDATE bridge_tasks
          SET status = 'SETTLED',
              outcome = 'INTERRUPTED',
              summary = ?,
              modified_files = '[]',
              verification_passed = NULL,
              finished_at = ?,
              updated_at = ?
          WHERE status = 'RUNNING'
          RETURNING *
        `)
        .all(
          'Bridge restarted while the task was running',
          now,
          now
        );

      for (const row of rows) {
        this.addEvent(row.id, 'task_interrupted', {});
      }
      return rows.map(mapTaskRow);
    });

    return transaction();
  }

  public markRecoveryNotified(id: string): void {
    this.db.run('UPDATE bridge_tasks SET recovery_notified = 1, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id
    ]);
  }

  public setNotificationStatus(id: string, status: NotificationStatus): void {
    this.db.run(
      'UPDATE bridge_tasks SET notification_status = ?, updated_at = ? WHERE id = ?',
      [status, new Date().toISOString(), id]
    );
  }

  public upsertNotification(input: {
    taskId: string;
    channel: string;
    status: NotificationStatus;
    attempts: number;
    lastError?: string;
  }): void {
    const now = new Date().toISOString();
    this.db.run(
      `
        INSERT INTO bridge_notifications (
          task_id, channel, status, attempts, last_error, sent_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, channel) DO UPDATE SET
          status = excluded.status,
          attempts = excluded.attempts,
          last_error = excluded.last_error,
          sent_at = excluded.sent_at,
          updated_at = excluded.updated_at
      `,
      [
        input.taskId,
        input.channel,
        input.status,
        input.attempts,
        input.lastError ?? null,
        input.status === 'SENT' ? now : null,
        now,
        now
      ]
    );
  }

  public listNotifications(taskId: string): BridgeNotificationRow[] {
    return this.db
      .query<BridgeNotificationRow, [string]>(
        'SELECT * FROM bridge_notifications WHERE task_id = ? ORDER BY id ASC'
      )
      .all(taskId);
  }

  public addEvent(taskId: string, eventType: string, payload: unknown): void {
    this.db.run(
      'INSERT INTO bridge_events (task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
      [
        taskId,
        eventType,
        payload === undefined ? null : JSON.stringify(payload),
        new Date().toISOString()
      ]
    );
  }

  public cleanupOldTasks(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.run(
      "DELETE FROM bridge_tasks WHERE status = 'SETTLED' AND finished_at IS NOT NULL AND finished_at < ?",
      [cutoff]
    );
    return result.changes;
  }

  public close(): void {
    this.db.close();
  }
}
