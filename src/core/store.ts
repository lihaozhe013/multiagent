import { Database } from 'bun:sqlite';
import type { Task, TaskRow } from '../types/index.ts';

export class TaskLockedError extends Error {
  constructor(taskId: number, message = `Task ${taskId} is currently in progress and cannot be modified or deleted`) {
    super(message);
    this.name = 'TaskLockedError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: number) {
    super(`Task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

export class QueueBusyError extends Error {
  constructor(message = 'Another task is already in progress') {
    super(message);
    this.name = 'QueueBusyError';
  }
}

export function parseTaskRow(row: TaskRow): Task {
  let verifyCommands: string[] = [];
  if (row.verify_commands) {
    try {
      const parsed = JSON.parse(row.verify_commands);
      if (Array.isArray(parsed)) {
        verifyCommands = parsed.map(String);
      }
    } catch {
      verifyCommands = [];
    }
  }

  return {
    ...row,
    verify_commands: verifyCommands,
    current_stage: row.current_stage ?? 'IDLE',
  };
}

export class StorageEngine {
  public readonly db: Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath, { create: true });
    this.initPragmas();
    this.initSchema();
  }

  private initPragmas(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    // If not in-memory, set WAL mode
    const isMemory = this.db.filename === '' || this.db.filename === ':memory:';
    if (!isMemory) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id           TEXT PRIMARY KEY,
        raw_input    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
        created_at   TEXT NOT NULL,
        finished_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id        TEXT REFERENCES batches(id) ON DELETE SET NULL,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL,
        agent_id        TEXT NOT NULL DEFAULT 'pi',
        cwd             TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','IN_PROGRESS','DONE','BLOCKED','FAILED')),
        rank            INTEGER NOT NULL,
        verify_commands TEXT,
        max_retries     INTEGER NOT NULL DEFAULT 3,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        current_stage   TEXT DEFAULT 'IDLE',
        claimed_token   TEXT,
        result_summary  TEXT,
        error_tail      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        finished_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks (status, rank, id);
      CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks (batch_id);

      CREATE TABLE IF NOT EXISTS task_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt     INTEGER NOT NULL,
        stage       TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILED','REJECTED')),
        log_tail    TEXT,
        feedback    TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs (task_id);

      CREATE TABLE IF NOT EXISTS queue_state (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        state          TEXT NOT NULL CHECK (state IN ('IDLE','RUNNING','PAUSED')),
        paused_reason  TEXT,
        active_task_id INTEGER REFERENCES tasks(id),
        active_stage   TEXT DEFAULT 'IDLE',
        updated_at     TEXT NOT NULL
      );

      INSERT OR IGNORE INTO queue_state (id, state, updated_at)
      VALUES (1, 'IDLE', datetime('now'));
    `);
  }

  public close(): void {
    this.db.close();
  }
}
