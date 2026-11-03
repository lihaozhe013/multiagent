# Dify Local Agent Bridge - IM Delivery Implementation Plan

Status: Implemented (MVP); live Dify and Feishu validation pending
Variant: Plan B - Dify triggers work only; results are pushed to IM, not back to Dify chat.
Related: `docs/vision-and-architecture.md`, `docs/dify-bridge-usage.md`, `docs/dify-bridge-handoff.md`

## 1. Executive Summary

This plan describes an additive bridge service that connects a Dify Chatflow to a
locally running Pi agent. Dify submits a task through `POST /trigger` and
immediately receives an acknowledgement. The bridge runs the agent asynchronously,
enforces a hard timeout, and pushes the final result to one or more IM webhooks.

The bridge deliberately does **not** call Dify's `/v1/chat-messages` endpoint.
Dify's chat API starts a new conversation turn rather than appending an assistant
message. Calling it from the bridge can re-run the Dify flow, consume another LLM
call, and potentially trigger the same local task again. Plan B avoids that class
of failure entirely.

The implementation is additive. The existing Night-Shift WebUI, SQLite queue, and
Coder/Test/Review pipeline remain unchanged. The bridge reuses the existing Pi
adapter, watchdog, and output ring buffer, but runs its own task lifecycle.

## 2. Decision Log

| Decision | Choice | Rationale |
| --- | --- | --- |
| Dify callback path | No `/v1/chat-messages` callback | Avoids re-trigger loops and Dify-side LLM cost |
| Result delivery | IM webhook | Deterministic, asynchronous, user-visible without page refresh |
| Notifier abstraction | Generic webhook adapter, Feishu default | Avoids coupling to one IM vendor; Feishu is the first built-in |
| Execution model | Independent bridge task per trigger | Matches the per-task supervisor and timeout semantics |
| Existing pipeline | Not reused for bridge tasks | Its completion signal is Test/Review, not agent self-delivery |
| Task domain | General workspace tasks, not coding-only | The bridge validates a workspace and does not assume git or code changes |
| Completion signal | Pi `deliver_result` tool, plus supervisor fallback | Agent reports structured results; bridge guarantees a terminal event |
| Persistence | New `bridge_tasks` tables in a separate SQLite database | Keeps the existing queue schema untouched |
| Deployment shape | Standalone bridge entrypoint with public and internal servers | Public trigger and local-only delivery can bind different interfaces |

## 3. Goals and Non-Goals

### 3.1 Goals

- Accept Dify tasks through an authenticated `POST /trigger`.
- Return an acknowledgement immediately; never block Dify for the full agent run.
- Run a Pi agent in a validated workspace directory. The task may be coding-related
  or a general workspace task.
- Require the agent to submit a structured delivery through a dedicated tool.
- Guarantee a terminal notification even when the agent crashes, exits without
  delivery, or exceeds the timeout.
- Push results to a generic webhook and to Feishu by default.
- Keep the implementation safe against path traversal, spoofed delivery calls,
  unbounded payloads, and duplicate notifications.
- Recover cleanly from bridge restarts without silently losing tasks.

### 3.2 Non-Goals

- No Dify `/chat-messages` callback.
- No changes to the existing `src/core/queue.ts`, `src/core/pipeline.ts`, or the
  React dashboard behavior.
- No multi-agent routing in the MVP. The bridge targets `pi` only.
- No git-specific behavior. The bridge does not inspect, stage, or commit changes,
  and it does not require the workspace to be a git repository. If a commit is part
  of the task, the task prompt must instruct the agent to do it.
- No assumption that the task modifies files. `modified_files` may be empty for
  general tasks.
- No public exposure of the internal delivery endpoint.
- No horizontal scaling. The bridge is designed for a single local host.

## 4. Architecture

### 4.1 Topology

```text
+----------+         POST /trigger          +-----------------------------+
|  Dify    | -----------------------------> | Bridge Public Server        |
| Chatflow | <----------------------------- | Hono, 0.0.0.0:4100          |
+----------+   200 accepted + task_id       +--------------+--------------+
                                                           |
                                                           | enqueue
                                                           v
                                            +-----------------------------+
                                            | Task Registry / Scheduler   |
                                            | SQLite + in-memory state    |
                                            +--------------+--------------+
                                                           |
                                                           | spawn
                                                           v
                                            +-----------------------------+
                                            | Pi Agent                    |
                                            | --mode json -p --no-approve |
                                            | --extension delivery.ts     |
                                            +--------------+--------------+
                                                           |
                                      POST /internal/delivery (127.0.0.1)
                                                           |
                                                           v
                                            +-----------------------------+
                                            | Bridge Internal Server      |
                                            | Hono, 127.0.0.1:4101        |
                                            +--------------+--------------+
                                                           |
                                                           | notify
                                                           v
                                            +-----------------------------+
                                            | IM Notifier Adapters        |
                                            | generic webhook + Feishu    |
                                            +-----------------------------+
```

### 4.2 Component Responsibilities

| Component | Responsibility |
| --- | --- |
| Public server | Authentication, trigger validation, admin task queries, health |
| Internal server | Accept delivery callbacks from the local Pi extension only |
| Task registry | Create, persist, and transition bridge task state |
| Scheduler | Enforce the concurrency limit and start queued tasks |
| Agent runner | Spawn Pi, stream logs, enforce timeout, collect exit status |
| Delivery service | Validate payloads, apply first-wins semantics, settle tasks |
| Supervisor | Detect missing delivery, timeout, crash, or shutdown and emit fallback |
| Notifier layer | Normalize events and deliver them to one or more IM channels |
| Recovery service | Detect interrupted tasks on startup and emit a notification once |

### 4.3 Module Layout

New files:

```text
src/bridge/
  config.ts                 Environment parsing and validation
  types.ts                  Trigger, delivery, task, and notification types
  server.ts                 Standalone bridge entrypoint
  public-routes.ts          /trigger and admin routes
  internal-routes.ts        /internal/delivery
  registry.ts               In-memory state plus SQLite persistence
  scheduler.ts              Concurrency-limited task scheduling
  agent-runner.ts           Pi process lifecycle wrapper
  supervisor.ts             Timeout, fallback, and recovery logic
  delivery.ts               Delivery validation and settlement
  security.ts               Bearer auth, path guard, payload limits
  logging.ts                Structured JSON logging helpers
  notifier/
    index.ts                Notifier interface and factory
    generic.ts              Generic JSON webhook notifier
    feishu.ts               Feishu custom bot notifier
    format.ts               Shared message formatting and truncation
  db/
    schema.ts               CREATE TABLE IF NOT EXISTS statements
    queries.ts              Typed SQLite queries

extensions/
  delivery.ts               Pi custom tool that calls /internal/delivery

scripts/
  bridge-e2e.ts             End-to-end test with a fake agent and webhook
  fake-agent.ts             Test agent that can deliver, crash, or hang
```

Modified files:

```text
src/adapters/types.ts       Add optional extensions[] to AgentRunOptions
src/adapters/pi.ts          Pass --extension and bridge environment variables
package.json                Add bridge start and test scripts
tsconfig.json               No change required; extensions/ is outside include
```

The bridge does not modify the existing `src/index.ts`. It runs as a separate
process on different ports.

## 5. End-to-End Flows

### 5.1 Happy Path

```text
Dify            Bridge Public        Registry/Scheduler       Pi Agent        Bridge Internal       IM Webhook
 |                    |                      |                    |                  |                   |
 | POST /trigger      |                      |                    |                  |                   |
 |------------------->|                      |                    |                  |                   |
 | 200 accepted       |                      |                    |                  |                   |
 |<-------------------|                      |                    |                  |                   |
 |                    | create task           |                    |                  |                   |
 |                    |---------------------->|                    |                  |                   |
 |                    |                      | spawn              |                  |                   |
 |                    |                      |------------------->|                  |                   |
 |                    |                      |                    | edit/test        |                   |
 |                    |                      |                    | POST delivery    |                   |
 |                    |                      |                    |----------------->|                   |
 |                    |                      |                    | 200 delivered    |                   |
 |                    |                      |                    |<-----------------|                   |
 |                    |                      | settle task        |                  |                   |
 |                    |                      |<-------------------|                  |                   |
 |                    |                      |                    |                  | POST result       |
 |                    |                      |                    |                  |------------------>|
```

1. Dify calls `POST /trigger` with a bearer token.
2. The bridge validates the token, payload, and workspace path.
3. The bridge creates a `QUEUED` task and returns `200` with a `task_id`.
4. The scheduler starts the task when a concurrency slot is available.
5. The agent runner spawns Pi with the delivery extension and task environment.
6. The agent performs the work and calls `deliver_result`.
7. The extension posts to `127.0.0.1:4101/internal/delivery`.
8. The delivery service validates the payload and applies first-wins semantics.
9. The task becomes `SETTLED` with outcome `COMPLETED` or `BLOCKED`.
10. The notifier sends the normalized event to every configured channel.

### 5.2 Agent Exits Without Delivery

1. The Pi process exits with code `0` or non-zero.
2. The supervisor sees `reported == false`.
3. The bridge collects the exit code and the last 2 KB or 50 lines of output.
4. The task settles as `FAILED` or `BLOCKED` depending on configuration.
5. The notifier sends a fallback message with the exit code and log tail.

The fallback is the dead man's switch. A clean exit code alone is never treated
as success.

### 5.3 Timeout

1. `BRIDGE_TASK_TIMEOUT_MS` elapses, default `900000` (15 minutes).
2. The supervisor sends `SIGTERM` to the Pi process tree.
3. After `BRIDGE_KILL_GRACE_MS`, default `3000`, it sends `SIGKILL`.
4. The task settles as `TIMEOUT`.
5. The notifier sends a timeout message with the log tail.

### 5.4 Bridge Restart

1. On startup, the recovery service finds tasks in `QUEUED` or `RUNNING`.
2. `QUEUED` tasks are re-enqueued.
3. `RUNNING` tasks are marked `INTERRUPTED` because their child processes are gone.
4. A notification is sent once per interrupted task if
   `BRIDGE_RECOVER_NOTIFY=true` (default `true`).
5. `recovery_notified` prevents duplicate messages across restarts.

## 6. API Contracts

### 6.1 Dify to Bridge: Trigger

`POST /trigger`

Headers:

```http
Authorization: Bearer <BRIDGE_TRIGGER_TOKEN>
Content-Type: application/json
```

Request:

```json
{
  "task_prompt": "Implement the requested change and run the relevant tests.",
  "relative_path": "projects/example-app",
  "conversation_id": "dify-conversation-id",
  "user_id": "dify-user-id",
  "idempotency_key": "optional-stable-key"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `task_prompt` | string | yes | Max 32 KiB |
| `relative_path` | string | no | Relative to `WORKSPACE_BASE`; empty means the base |
| `conversation_id` | string | yes | Max 255 characters |
| `user_id` | string | yes | Max 255 characters |
| `idempotency_key` | string | no | Max 255 characters; duplicates return the original task |

Response `200 OK`:

```json
{
  "status": "accepted",
  "task_id": "uuid-v4",
  "message": "Task queued and running in background.",
  "duplicate": false
}
```

Error responses:

| Status | Condition |
| --- | --- |
| `400` | Missing or invalid fields, path does not exist, invalid JSON |
| `401` | Missing or invalid bearer token |
| `403` | Resolved path escapes `WORKSPACE_BASE` |
| `413` | Request body exceeds the configured limit |
| `429` | Queue depth exceeds `BRIDGE_MAX_QUEUE_DEPTH` |
| `500` | Persistence or scheduling failure |

### 6.2 Pi Extension to Bridge: Delivery

`POST /internal/delivery`

This endpoint is served by the internal Bun server bound to `127.0.0.1`. It is not
reachable through the public listener or the Cloudflare Tunnel.

Headers:

```http
Authorization: Bearer <BRIDGE_INTERNAL_TOKEN>
Content-Type: application/json
```

Request:

```json
{
  "task_id": "uuid-v4",
  "status": "COMPLETED",
  "summary": "Implemented the feature and updated the related tests.",
  "modified_files": ["src/feature.ts", "src/feature.test.ts"],
  "verification_passed": true,
  "notes": "No new environment variables are required."
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `task_id` | string | yes | Must match a live task |
| `status` | string | yes | `COMPLETED` or `BLOCKED` |
| `summary` | string | yes | Max 16 KiB |
| `modified_files` | string[] | yes | Max 200 entries, each max 1024 characters; may be empty |
| `verification_passed` | boolean | yes | Self-reported by the agent; true when no automated check is applicable, with a note |
| `notes` | string | no | Max 8 KiB |

Response `200 OK`:

```json
{
  "status": "delivered"
}
```

Duplicate delivery response `200 OK`:

```json
{
  "status": "already_delivered"
}
```

The first valid delivery wins. Later deliveries do not overwrite the stored
payload and do not send another IM message.

### 6.3 Admin Task Status

`GET /api/bridge/tasks/:id`

Headers: same bearer token as `/trigger`.

Response:

```json
{
  "task": {
    "id": "uuid-v4",
    "status": "SETTLED",
    "outcome": "COMPLETED",
    "reported": true,
    "summary": "...",
    "modified_files": ["src/feature.ts"],
    "verification_passed": true,
    "notification_status": "SENT",
    "created_at": "2026-01-01T00:00:00.000Z",
    "finished_at": "2026-01-01T00:05:00.000Z"
  }
}
```

Optional admin routes:

- `GET /api/bridge/tasks?status=SETTLED&limit=50`
- `POST /api/bridge/tasks/:id/replay-notification`

Both are protected by the trigger bearer token. Replay is useful when all IM
webhooks were temporarily unavailable.

### 6.4 Health

`GET /health`

Response:

```json
{
  "status": "ok",
  "uptime_seconds": 123,
  "running_tasks": 1,
  "queued_tasks": 0,
  "notifier_channels": ["feishu"]
}
```

No secrets or workspace paths are included.

## 7. Data Model

The bridge uses a separate SQLite database. The default path is
`~/.night-shift/bridge.db`, configurable through `BRIDGE_DB_PATH`. WAL mode is
enabled for concurrent reads.

### 7.1 `bridge_tasks`

```sql
CREATE TABLE IF NOT EXISTS bridge_tasks (
  id                    TEXT PRIMARY KEY,
  idempotency_key       TEXT UNIQUE,
  conversation_id       TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  relative_path         TEXT,
  resolved_cwd          TEXT NOT NULL,
  agent_id              TEXT NOT NULL DEFAULT 'pi',
  status                TEXT NOT NULL
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
```

### 7.2 `bridge_events`

Audit trail for state transitions and delivery attempts.

```sql
CREATE TABLE IF NOT EXISTS bridge_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES bridge_tasks(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bridge_events_task
  ON bridge_events (task_id, id);
```

### 7.3 `bridge_notifications`

One row per notifier channel per task. This makes retries and replay observable.

```sql
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
```

### 7.4 Retention

`BRIDGE_RETENTION_DAYS` defaults to `30`. A startup cleanup removes settled tasks
older than the retention window. The cleanup must be a no-op when the value is
`0`, which means retain forever.

## 8. Agent Integration

### 8.1 Pi Invocation

The bridge reuses `PiAdapter` with a small extension to the adapter options.

Current adapter arguments already include:

```text
pi --mode json -p --no-approve --name <task-name> [--model <model>] [prompt]
```

The bridge adds:

```text
--extension <absolute-path-to-extensions/delivery.ts>
--append-system-prompt <bridge-system-prompt>
```

Environment variables passed to the Pi process:

| Variable | Purpose |
| --- | --- |
| `BRIDGE_TASK_ID` | Task identifier used by the delivery tool |
| `BRIDGE_DELIVERY_URL` | Usually `http://127.0.0.1:4101/internal/delivery` |
| `BRIDGE_INTERNAL_TOKEN` | Bearer token for the internal endpoint |
| `BRIDGE_CONVERSATION_ID` | Audit and message formatting only |
| `BRIDGE_USER_ID` | Audit and message formatting only |

The bridge must not pass the public trigger token to the agent.

### 8.2 System Prompt

The bridge appends a system-level instruction. The exact prompt is stored in
`src/bridge/prompts.ts` so it can be versioned and tested.

Required content:

- The agent is running unattended; do not ask the user questions.
- Perform the requested task in the current working directory. Make file changes if
  the task requires them.
- Run relevant tests or checks when applicable.
- Do not declare completion in plain terminal text only.
- Call `deliver_result` exactly once at the end of the task.
- Use `status: "COMPLETED"` only when the requested work is complete and, where
  applicable, verified. If no automated verification applies, set
  `verification_passed: true` and explain why in `notes`.
- Use `status: "BLOCKED"` when an unrecoverable dependency or environment issue
  prevents completion.
- Include a concise summary, the modified file list (empty if none), the
  verification result, and any notes that a human needs to know.
- Do not assume the workspace is a git repository.

### 8.3 Delivery Extension

The extension is a normal Pi custom tool. It must:

- Read `BRIDGE_TASK_ID`, `BRIDGE_DELIVERY_URL`, and `BRIDGE_INTERNAL_TOKEN` from
  the environment.
- Validate that all required environment variables are present.
- Post the structured payload to the internal endpoint.
- Return a model-facing success message or throw a clear error on failure.
- Never log the internal token.

Sketch:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const deliveryTool = defineTool({
  name: "deliver_result",
  label: "Deliver Result",
  description:
    "Submit the final structured result to the local bridge. Call exactly once when the task is complete or blocked.",
  parameters: Type.Object({
    status: Type.Union([Type.Literal("COMPLETED"), Type.Literal("BLOCKED")]),
    summary: Type.String(),
    modified_files: Type.Array(Type.String()),
    verification_passed: Type.Boolean(),
    notes: Type.Optional(Type.String()),
  }),
  async execute(_toolCallId, params) {
    const taskId = process.env.BRIDGE_TASK_ID;
    const url = process.env.BRIDGE_DELIVERY_URL;
    const token = process.env.BRIDGE_INTERNAL_TOKEN;

    if (!taskId || !url || !token) {
      throw new Error("Bridge delivery environment is incomplete");
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        task_id: taskId,
        status: params.status,
        summary: params.summary,
        modified_files: params.modified_files,
        verification_passed: params.verification_passed,
        notes: params.notes,
      }),
    });

    if (!response.ok) {
      throw new Error(`Bridge delivery failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { status: string };
    return {
      content: [{ type: "text", text: `Delivery accepted: ${body.status}` }],
      details: undefined,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(deliveryTool);
}
```

The extension lives outside `src/**/*`, so the existing `tsconfig.json` does not
typecheck it. Pi loads it through jiti at runtime.

### 8.4 Completion Semantics

- A delivery is final. The bridge does not wait for the process to exit before
  notifying, because the agent may spend time on cleanup after the tool call.
- If the process exits after a successful delivery, the supervisor ignores the
  exit and does not send a second message.
- If the agent calls delivery and then continues editing, those edits are outside
  the delivered snapshot. The system prompt must tell the agent to call the tool
  only after all work is complete.
- A future enhancement can add an `agent_before_settle` hook that injects a
  reminder when the agent is about to exit without delivery. The MVP relies on
  the supervisor fallback.

## 9. IM Notification Layer

### 9.1 Notifier Interface

```ts
export type NotificationOutcome =
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "TIMEOUT"
  | "INTERRUPTED";

export interface NotificationEvent {
  taskId: string;
  conversationId: string;
  userId: string;
  outcome: NotificationOutcome;
  summary: string;
  modifiedFiles: string[];
  verificationPassed: boolean;
  notes?: string;
  exitCode?: number;
  logTail?: string;
  durationMs?: number;
  createdAt: string;
}

export interface Notifier {
  readonly channel: string;
  send(event: NotificationEvent): Promise<void>;
}
```

The notifier is a pure output adapter. It must not mutate task state. The
registry records the per-channel result in `bridge_notifications`.

### 9.2 Generic Webhook

The generic webhook is the fallback integration point for any IM or automation
platform that accepts JSON.

`POST <GENERIC_WEBHOOK_URL>`

Headers:

```http
Content-Type: application/json
Authorization: Bearer <GENERIC_WEBHOOK_TOKEN>   # optional
```

Body:

```json
{
  "source": "night-shift-bridge",
  "event": "task_result",
  "task_id": "uuid-v4",
  "conversation_id": "dify-conversation-id",
  "user_id": "dify-user-id",
  "outcome": "COMPLETED",
  "summary": "...",
  "modified_files": ["src/feature.ts"],
  "verification_passed": true,
  "notes": "...",
  "exit_code": null,
  "log_tail": null,
  "duration_ms": 12345,
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

The generic adapter sends one POST per event. It does not template arbitrary user
input into the URL. The URL comes only from configuration.

### 9.3 Feishu Notifier

The default channel is a Feishu custom bot webhook.

`POST <FEISHU_WEBHOOK_URL>`

MVP payload uses `msg_type: "text"` for reliability:

```json
{
  "msg_type": "text",
  "content": {
    "text": "[Night-Shift] COMPLETED\nTask: uuid-v4\nUser: dify-user-id\n\nSummary:\n...\n\nFiles:\n- src/feature.ts\n\nVerification: PASSED\n\nNotes:\n..."
  }
}
```

If `FEISHU_WEBHOOK_SECRET` is configured, add `timestamp` and `sign` according to
the Feishu custom bot signature specification. The signature is computed with
HMAC-SHA256 over the documented string-to-sign and encoded as Base64.

Optional future enhancement: an interactive card with a colored header and
`lark_md` sections. Keep text as the default until the card schema is validated
against the tenant's Feishu client version.

Message limits:

- Total text payload is capped at 8 KiB after formatting.
- `summary` is capped at 4 KiB.
- `log_tail` is capped at 2 KiB and 50 lines.
- `modified_files` shows at most 50 entries, followed by `... and N more`.

### 9.4 Fan-Out and Failure Handling

`BRIDGE_NOTIFIERS` is a comma-separated list. Example:

```text
BRIDGE_NOTIFIERS=feishu,generic
```

Behavior:

- Each channel is attempted independently.
- A failure in one channel does not block the others.
- Each attempt is recorded in `bridge_notifications`.
- Retries use exponential backoff: 1s, then 4s, up to 3 attempts.
- After all attempts fail, the channel is marked `FAILED` and the task's
  `notification_status` becomes `FAILED` if no channel succeeded, or `SENT` if at
  least one succeeded.
- A failed notification can be replayed through
  `POST /api/bridge/tasks/:id/replay-notification`.

### 9.5 Message Template

````text
[Night-Shift] <OUTCOME>
Task: <task_id>
User: <user_id>
Duration: <duration>

Summary:
<summary>

Files:
- <file>
- ...

Verification: PASSED | FAILED | UNKNOWN

Notes:
<notes>

Exit code: <exit_code>          # fallback messages only
Log tail:
```text
<log_tail>
```                              # fallback messages only
````

Markdown fences are only used in channels that render Markdown. The Feishu text
notifier uses plain text and indents the log tail instead.

### 9.6 Feishu Setup Checklist

A Feishu custom bot is scoped to a group. It cannot send a direct message to an
individual user unless a full Feishu app is created; that is out of scope for the
MVP.

1. Create a Feishu group for bridge notifications. Use a test group first.
2. Open the group settings, choose Bots, and add a Custom Bot.
3. Copy the webhook URL into `FEISHU_WEBHOOK_URL`.
4. If signature verification is enabled, copy the secret into
   `FEISHU_WEBHOOK_SECRET`.
5. Send a test message with `curl` before connecting the bridge.
6. Add the bot to the production group only after the test succeeds.

Recommended security settings:

- Enable signature verification and store the secret only in the bridge
  environment.
- Optionally add an IP allowlist if the host has a static egress IP.
- Do not use keyword-only verification as the sole protection for a production
  group.

Feishu custom bots are subject to the tenant's bot rate limits. The notifier
retries with backoff, and the replay endpoint covers temporary outages.

## 10. Security

### 10.1 Public Trigger Authentication

- Require `Authorization: Bearer <BRIDGE_TRIGGER_TOKEN>`.
- Refuse to start if `BRIDGE_TRIGGER_TOKEN` is unset.
- Compare tokens with a timing-safe comparison.
- Apply the same auth to admin routes under `/api/bridge/*`.
- Do not log the Authorization header.

### 10.2 Internal Delivery Isolation

- Start a second Bun server bound to `127.0.0.1` for `/internal/delivery`.
- Use a separate `BRIDGE_INTERNAL_TOKEN`.
- If the token is not configured, generate a random token at startup and pass it
  to the child process environment.
- The public listener must not route to `/internal/delivery`.
- Cloudflare Tunnel or any reverse proxy must expose only the public port.

### 10.3 Path Traversal Defense

1. Require `WORKSPACE_BASE` to be an absolute path.
2. Resolve the base with `realpath`.
3. Join `relative_path` to the base.
4. Resolve the candidate with `realpath`.
5. Reject unless `candidate === base` or `candidate.startsWith(base + path.sep)`.
6. Reject if the resolved directory does not exist or is not a directory.

The separator check is mandatory. A plain `startsWith(base)` check would allow a
sibling directory such as `/workspace-evil` when the base is `/workspace`.

### 10.4 Payload Limits

- Public server `maxRequestBodySize`: 1 MiB.
- Internal server `maxRequestBodySize`: 256 KiB.
- `task_prompt`: 32 KiB.
- `summary`: 16 KiB.
- `notes`: 8 KiB.
- `modified_files`: 200 entries, 1024 characters each.
- `log_tail`: 2 KiB and 50 lines.

Reject oversized requests before parsing large JSON bodies where possible.

### 10.5 Log Redaction

Structured logs include task IDs and event types, never tokens, webhook URLs, or
full prompts by default. A debug mode may log truncated prompts, but it must be
off by default.

### 10.6 Webhook Secrets

- IM webhook URLs and secrets come from environment variables only.
- The bridge never accepts a webhook URL from a trigger request.
- Feishu signatures are recomputed per request using the current timestamp.
- Generic webhook tokens are sent only to the configured destination.

## 11. Reliability and Concurrency

### 11.1 Concurrency Limit

`BRIDGE_MAX_CONCURRENCY` defaults to `1`, matching the low-power host philosophy
of the existing project. It can be raised to `2` or more on stronger machines.

The scheduler maintains:

- `QUEUED` tasks in SQLite.
- At most `BRIDGE_MAX_CONCURRENCY` tasks in `RUNNING`.
- A FIFO start order by `created_at`.

`/trigger` never spawns the agent directly. It only enqueues. This keeps the HTTP
handler fast and makes backpressure explicit.

### 11.2 Idempotency

- If `idempotency_key` is present and already exists, return the existing
  `task_id` with `duplicate: true`.
- Do not spawn a second agent for a duplicate key.
- The unique index on `idempotency_key` is the final arbiter under races.

Dify should pass a stable key when the installed version exposes one, such as the
workflow run ID or message ID. Dify is not installed on the target host yet, so the
bridge must not depend on a specific Dify variable. If no stable key is available,
the bridge still works, but Dify HTTP retries can create duplicate tasks.

An optional `BRIDGE_DEDUPE_WINDOW_MS` guard can suppress duplicate triggers with
the same `conversation_id`, `user_id`, `relative_path`, and normalized
`task_prompt` inside the window. It is disabled by default because it can also
drop legitimate repeated requests.

### 11.3 First Delivery Wins

Delivery settlement runs in a SQLite transaction:

```sql
UPDATE bridge_tasks
SET reported = 1,
    status = 'SETTLED',
    outcome = ?,
    summary = ?,
    modified_files = ?,
    verification_passed = ?,
    notes = ?,
    finished_at = ?,
    updated_at = ?
WHERE id = ?
  AND reported = 0
  AND status = 'RUNNING';
```

If the update affects zero rows, return `already_delivered` or `task_not_running`.
This prevents duplicate IM messages from repeated tool calls.

### 11.4 Timeout and Process Tree

The existing `killProcessTreeWithEscalation` helper is reused. The bridge should
also verify that it kills the whole process group, not only direct children. If
the current `pkill -P` approach is insufficient for a Pi process that spawns
grandchildren, switch to a POSIX process group:

- Spawn with a new process group when supported.
- Send `SIGTERM` to the group.
- After the grace period, send `SIGKILL` to the group.

The timeout path must always emit a terminal notification, even if the process
does not exit promptly.

### 11.5 Graceful Shutdown

On `SIGTERM` or `SIGINT`:

1. Stop accepting new triggers.
2. Wait up to `BRIDGE_SHUTDOWN_GRACE_MS` for running tasks.
3. Mark remaining tasks `INTERRUPTED`.
4. Kill their process trees.
5. Send interrupted notifications if `BRIDGE_NOTIFY_ON_SHUTDOWN=true`.
6. Close the SQLite database.

### 11.6 Restart Recovery

- `QUEUED` tasks are re-enqueued after restart.
- `RUNNING` tasks from a previous process are marked `INTERRUPTED` because their
  child PIDs cannot be trusted after a restart.
- Recovery notifications are sent at most once per task.
- A stale `RUNNING` task must not block the scheduler.

### 11.7 Notification Failure Handling

- Persist the terminal outcome before attempting notification.
- If notification fails, the task remains queryable and replayable.
- Do not roll back the task state because an IM webhook was down.
- Keep the last error per channel for diagnostics.

## 12. Configuration

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `BRIDGE_PORT` | `4100` | no | Public trigger and admin port |
| `BRIDGE_HOST` | `0.0.0.0` | no | Public bind address |
| `BRIDGE_INTERNAL_PORT` | `4101` | no | Internal delivery port |
| `BRIDGE_INTERNAL_HOST` | `127.0.0.1` | no | Must remain loopback |
| `WORKSPACE_BASE` | none | yes | Absolute workspace root |
| `BRIDGE_TRIGGER_TOKEN` | none | yes | Public bearer token |
| `BRIDGE_INTERNAL_TOKEN` | random | no | Internal bearer token |
| `BRIDGE_DB_PATH` | `~/.night-shift/bridge.db` | no | SQLite database |
| `BRIDGE_TASK_TIMEOUT_MS` | `900000` | no | 15-minute task timeout |
| `BRIDGE_KILL_GRACE_MS` | `3000` | no | SIGTERM to SIGKILL grace |
| `BRIDGE_MAX_CONCURRENCY` | `1` | no | Concurrent agent runs |
| `BRIDGE_MAX_QUEUE_DEPTH` | `50` | no | Reject triggers beyond this depth |
| `BRIDGE_DEDUPE_WINDOW_MS` | `0` | no | Optional duplicate-trigger window; `0` disables it |
| `BRIDGE_SHUTDOWN_GRACE_MS` | `10000` | no | Graceful shutdown wait |
| `BRIDGE_NOTIFY_ON_SHUTDOWN` | `true` | no | Notify interrupted tasks |
| `BRIDGE_RECOVER_NOTIFY` | `true` | no | Notify recovered tasks |
| `BRIDGE_RETENTION_DAYS` | `30` | no | Audit retention; `0` keeps forever |
| `BRIDGE_AGENT_ID` | `pi` | no | Agent adapter ID; only `pi` is supported in the MVP |
| `BRIDGE_PI_BINARY` | `pi` | no | Pi executable name or absolute path |
| `BRIDGE_PI_MODEL` | none | no | Optional Pi model override |
| `BRIDGE_PI_EXTENSION` | `extensions/delivery.ts` | no | Delivery extension path |
| `BRIDGE_SYSTEM_PROMPT` | built-in | no | Optional prompt override |
| `BRIDGE_NOTIFIERS` | `feishu` | no | Comma-separated notifier channels |
| `FEISHU_WEBHOOK_URL` | none | if Feishu | Feishu custom bot URL |
| `FEISHU_WEBHOOK_SECRET` | none | no | Feishu signature secret |
| `GENERIC_WEBHOOK_URL` | none | if generic | Generic JSON webhook URL |
| `GENERIC_WEBHOOK_TOKEN` | none | no | Generic webhook bearer token |

Example `.env`:

```dotenv
BRIDGE_PORT=4100
BRIDGE_INTERNAL_PORT=4101
WORKSPACE_BASE=/home/lihaozhe/dev
BRIDGE_TRIGGER_TOKEN=replace-with-a-long-random-token
BRIDGE_DB_PATH=/home/lihaozhe/.night-shift/bridge.db
BRIDGE_TASK_TIMEOUT_MS=900000
BRIDGE_MAX_CONCURRENCY=1
BRIDGE_DEDUPE_WINDOW_MS=0
BRIDGE_NOTIFIERS=feishu
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/...
FEISHU_WEBHOOK_SECRET=...
```

## 13. Dify-Side Setup

### 13.1 Chatflow Shape

Use a Chatflow with three nodes:

```text
Start
  -> HTTP Request (POST /trigger)
  -> Answer (acknowledgement)
```

Do not add a result callback node. The result arrives through IM.

### 13.2 Variables to Pass

| Bridge field | Dify value |
| --- | --- |
| `task_prompt` | The user's request from `sys.query`, or a templated instruction |
| `relative_path` | A conversation variable or a constant for the target project |
| `conversation_id` | `sys.conversation_id` |
| `user_id` | `sys.user_id` |
| `idempotency_key` | A stable run/message identifier if the installed Dify version exposes one |

Use Dify's variable picker instead of hard-coding the Jinja syntax shown here.

### 13.3 HTTP Request Node

- Method: `POST`
- URL: `<BRIDGE_PUBLIC_URL>/trigger`
- Headers:
  - `Authorization: Bearer <BRIDGE_TRIGGER_TOKEN>`
  - `Content-Type: application/json`
- Body: JSON with the fields from Section 13.2.
- Timeout: 10 seconds. The bridge returns immediately, so a longer timeout is
  unnecessary.
- Retries: enable only if the bridge supports idempotency keys. Otherwise leave
  retries disabled to avoid duplicate tasks.

### 13.4 Answer Node

Return a short acknowledgement that includes the `task_id` from the HTTP node
response:

```text
Task accepted. The result will be pushed to IM when the agent finishes.
Task ID: {{http_request.body.task_id}}
```

This is the last message the user sees in the Dify WebApp for the trigger turn.
The final result is out-of-band.

### 13.5 What Not to Do

- Do not call Dify's `/v1/chat-messages` from the bridge.
- Do not configure the Dify HTTP node to wait for the agent result.
- Do not expose the internal delivery port through the tunnel.
- Do not put the bridge trigger token in client-side Dify variables that are
  visible to end users.

## 14. Implementation Phases

| Phase | Deliverable | Estimate |
| --- | --- | --- |
| P0 | Feishu webhook smoke test; Dify HTTP node proof of concept after Dify is installed | 0.5 day |
| P1 | Bridge skeleton, public/internal servers, security, config | 1 day |
| P2 | Task registry, scheduler, Pi agent runner, delivery endpoint | 1 day |
| P3 | Pi delivery extension and supervisor fallback | 0.5 day |
| P4 | Feishu + generic notifier layer, formatting, retries | 0.5 day |
| P5 | Persistence, recovery, idempotency, admin routes | 0.5 day |
| P6 | Tests, documentation, deployment notes | 1 day |

Total MVP estimate: **4 to 5 working days**, excluding Dify tenant-specific
configuration and IM bot approval delays.

## 15. Task Breakdown

### P1 - Bridge Skeleton

- [ ] Add `src/bridge/config.ts` with fail-closed validation.
- [ ] Add `src/bridge/types.ts` with request, task, delivery, and event types.
- [ ] Add public and internal Hono apps.
- [ ] Add timing-safe bearer auth.
- [ ] Add the path traversal guard.
- [ ] Add structured logging helpers.
- [ ] Add `package.json` scripts: `start:bridge`, `test:bridge`.

### P2 - Task Lifecycle

- [ ] Add SQLite schema initialization.
- [ ] Add `bridge_tasks`, `bridge_events`, and `bridge_notifications` queries.
- [ ] Implement `POST /trigger` with idempotency and queue-depth checks.
- [ ] Implement the scheduler with the concurrency cap.
- [ ] Extend `AgentRunOptions` with `extensions?: string[]`.
- [ ] Pass `--extension` from `PiAdapter`.
- [ ] Inject task environment variables.
- [ ] Implement `POST /internal/delivery` with first-wins settlement.

### P3 - Supervisor

- [ ] Implement the timeout timer and process-tree kill.
- [ ] Implement the missing-delivery fallback.
- [ ] Implement exit-code and log-tail capture.
- [ ] Implement startup recovery for `QUEUED` and `RUNNING` tasks.
- [ ] Implement graceful shutdown.

### P4 - Notifications

- [ ] Define the `Notifier` interface.
- [ ] Implement the generic webhook adapter.
- [ ] Implement the Feishu text adapter with optional signature.
- [ ] Add message truncation and file-list limits.
- [ ] Add per-channel retries and persistence.
- [ ] Add replay support.

### P5 - Agent Integration

- [ ] Add `extensions/delivery.ts`.
- [ ] Add the bridge system prompt.
- [ ] Ensure the extension is loaded by the Pi process.
- [ ] Test delivery success, HTTP failure, and duplicate calls.

### P6 - Verification

- [ ] Unit tests for path guard and payload validation.
- [ ] Unit tests for first-wins settlement.
- [ ] Unit tests for Feishu payload and signature.
- [ ] Integration test with a fake agent and fake webhook.
- [ ] Integration test for timeout fallback.
- [ ] Integration test for process exit without delivery.
- [ ] End-to-end test with a real Pi process in a temporary workspace directory.

## 16. Test Plan

### 16.1 Unit Tests

- `security.test.ts`: bearer auth, timing-safe comparison, path traversal.
- `delivery.test.ts`: valid payload, invalid status, oversized fields, duplicate
  delivery.
- `registry.test.ts`: state transitions, idempotency key uniqueness.
- `notifier-format.test.ts`: message truncation, file-list limits, fallback
  formatting.
- `feishu.test.ts`: text payload shape, signature generation.

### 16.2 Integration Tests

Use a fake agent script that reads the bridge environment and performs one of:

- Deliver `COMPLETED`.
- Deliver `BLOCKED`.
- Exit without delivery.
- Sleep until killed.
- Deliver twice.

Use a local HTTP server as the generic webhook and assert the received payload.
For Feishu, assert the JSON body without calling the real endpoint.

### 16.3 End-to-End Test

1. Create a temporary workspace directory inside `WORKSPACE_BASE`.
2. Start the bridge with a test database and a local webhook.
3. Send `POST /trigger` with a small task prompt.
4. Run a real Pi process with the delivery extension.
5. Assert that the webhook receives a `COMPLETED` event with the expected fields.
6. Repeat with a prompt that exits without delivery and assert the fallback event.

## 17. Acceptance Criteria

- `POST /trigger` returns within 200 ms for a valid request.
- The bridge never calls Dify's `/v1/chat-messages`.
- A successful agent run produces exactly one IM message with the summary,
  modified files, and verification result.
- An agent exit without delivery produces exactly one fallback IM message with the
  exit code and truncated log tail.
- A timeout produces exactly one timeout message and leaves no child process
  running.
- A duplicate delivery tool call does not produce a duplicate IM message.
- A path outside `WORKSPACE_BASE` returns `403`.
- A missing or invalid public token returns `401`.
- The internal delivery endpoint is unreachable from the public listener.
- A bridge restart marks interrupted tasks and notifies at most once.
- All unit and integration tests pass with `bun test`.

## 18. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Agent never calls `deliver_result` | No result | Supervisor fallback always emits a terminal event |
| Agent calls delivery too early | Incomplete snapshot | System prompt requires final call; document the tradeoff |
| Dify HTTP node retries create duplicates | Duplicate work | Require `idempotency_key`; unique index |
| IM webhook is down or rate-limited | Missing notification | Retries, persisted status, replay endpoint |
| Pi spawns orphan grandchildren | Resource leak | Process-group kill and timeout escalation |
| Bridge restarts mid-run | Lost task | SQLite recovery marks `INTERRUPTED` and notifies |
| Path traversal | Unauthorized file access | `realpath` plus separator-aware prefix check |
| Internal endpoint exposed publicly | Spoofed delivery | Separate loopback server and internal token |
| Oversized logs or summaries | IM rejection or context overflow | Hard truncation at formatting time |
| Feishu payload schema changes | Notification failure | Text payload first; card support behind a config flag |

## 19. Deployment Notes

- Run the bridge under systemd, Docker, or a process manager with restart-on-fail.
- Use an environment file with `0600` permissions for tokens and webhook URLs.
- Expose only `BRIDGE_PORT` through Cloudflare Tunnel or a reverse proxy.
- Keep `BRIDGE_INTERNAL_PORT` on loopback.
- Use a dedicated Unix user with access only to `WORKSPACE_BASE`.
- Add a health check against `GET /health`.
- Configure log rotation for structured JSON logs.
- Back up `bridge.db` if audit history matters. The database is not required for
  correctness after recovery, but it is useful for replay and diagnostics.

## 20. Confirmed Decisions and Remaining Details

The following decisions are confirmed for the MVP.

| Topic | Decision |
| --- | --- |
| Dify installation | Dify is not installed on the host yet. Bridge development and tests do not require a live Dify instance. The Dify-side proof of concept starts after Dify is installed manually. |
| Git | The bridge has no git integration. It does not run `git status`, stage files, or create commits. If a task needs a commit, the task prompt must ask the agent to do it. |
| Feishu target | The default notifier is a Feishu custom bot webhook. The concrete group and webhook URL are operational secrets added after the bot is created. |
| Ports | The bridge runs as a standalone process. Public port `4100`, internal loopback port `4101`; the existing WebUI remains on `4000`. |

### 20.1 Idempotency Without a Dify Run ID

Dify is not installed yet, so the bridge must not depend on a specific Dify
variable. `idempotency_key` remains optional. Recommended Dify-side strategy once
Dify is available:

1. Generate a UUID in a Dify code node or store it in a conversation variable at
   the start of the turn.
2. Pass the same value as `idempotency_key`.
3. Disable automatic HTTP retries unless the same key is reused.

If no stable key is available, the bridge cannot distinguish a Dify retry from a
legitimate repeated task. `BRIDGE_DEDUPE_WINDOW_MS` is an optional mitigation and
is disabled by default.

### 20.2 Feishu Operational Details

A Feishu custom bot is group-scoped. The bridge only needs the webhook URL and the
optional signing secret. Direct messages to an individual user require a full
Feishu app with bot permissions, which is out of scope for the MVP. The setup
checklist is in Section 9.6.

### 20.3 Remaining Inputs

- The Feishu group and webhook URL after the bot is created.
- Whether to enable `BRIDGE_DEDUPE_WINDOW_MS` after observing Dify retry behavior.
- Whether the host should run the bridge as systemd or Docker. This does not
  affect the code.
