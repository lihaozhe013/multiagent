import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const BRIDGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bridge_tasks (
    id                    TEXT PRIMARY KEY,
    idempotency_key       TEXT UNIQUE,
    conversation_id       TEXT NOT NULL,
    user_id               TEXT NOT NULL,
    prompt                TEXT NOT NULL,
    relative_path         TEXT,
    resolved_cwd          TEXT NOT NULL,
    agent_id              TEXT NOT NULL DEFAULT 'pi',
    status                TEXT NOT NULL DEFAULT 'QUEUED'
                            CHECK (status IN ('QUEUED','RUNNING','SETTLED')),
    outcome               TEXT
                            CHECK (outcome IN ('COMPLETED','BLOCKED','FAILED','TIMEOUT','INTERRUPTED')),
    reported              INTEGER NOT NULL DEFAULT 0,
    summary               TEXT,
    modified_files        TEXT,
    verification_passed   INTEGER,
    notes                 TEXT,
    exit_code             INTEGER,
    log_tail              TEXT,
    notification_status   TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (notification_status IN ('PENDING','SENT','FAILED')),
    recovery_notified     INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    updated_at            TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bridge_tasks_status
    ON bridge_tasks (status, created_at);

  CREATE INDEX IF NOT EXISTS idx_bridge_tasks_conversation
    ON bridge_tasks (conversation_id);

  CREATE TABLE IF NOT EXISTS bridge_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES bridge_tasks(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    payload     TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bridge_events_task
    ON bridge_events (task_id, id);

  CREATE TABLE IF NOT EXISTS bridge_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES bridge_tasks(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL,
    status      TEXT NOT NULL
                  CHECK (status IN ('PENDING','SENT','FAILED')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    sent_at     TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (task_id, channel)
  );

  CREATE INDEX IF NOT EXISTS idx_bridge_notifications_task
    ON bridge_notifications (task_id);
`;

export function openBridgeDatabase(dbPath: string): Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA foreign_keys = ON;');

  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
  }

  db.exec(BRIDGE_SCHEMA);
  return db;
}
