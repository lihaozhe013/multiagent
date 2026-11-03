# Dify Local Bridge - Handoff

Status: MVP implemented and committed
Implementation commit: `c88fb48`
Last updated: 2026-11-03
Scope: Plan B - Dify triggers local agent work; results are pushed to IM, not back
to Dify chat.

Related documents:

- `docs/dify-bridge-im-delivery-plan.md` - design and decision record
- `docs/dify-bridge-usage.md` - configuration and usage
- `.env.bridge.example` - environment template

## 1. What This Is

The bridge connects a Dify Chatflow to a locally running Pi agent. Dify sends a
task through `POST /trigger` and immediately receives an acknowledgement. The
bridge runs the agent asynchronously, enforces a timeout, and pushes the final
result to one or more IM webhooks.

The bridge intentionally does **not** call Dify's `/v1/chat-messages` endpoint.
That API starts a new conversation turn rather than appending an assistant
message, and calling it from the bridge can re-trigger the same Dify flow. Plan B
avoids that loop by delivering results out-of-band through IM.

The implementation is additive. The existing Night-Shift WebUI, SQLite queue, and
Coder/Test/Review pipeline are unchanged.

## 2. Current State

Implemented:

- Standalone Bun/Hono bridge process with public and internal servers.
- Authenticated `POST /trigger` with immediate acknowledgement.
- Authenticated loopback-only `POST /internal/delivery`.
- Workspace path validation with `realpath` and separator-aware prefix checks.
- SQLite persistence for tasks, events, and per-channel notification attempts.
- Concurrency-limited scheduler with `QUEUED`, `RUNNING`, and `SETTLED` states.
- Pi process runner with environment injection and `deliver_result` extension.
- Process-group timeout handling with `SIGTERM` then `SIGKILL`.
- Supervisor fallback for missing delivery, non-zero exit, timeout, shutdown, and
  restart recovery.
- Generic JSON webhook notifier.
- Feishu custom bot notifier with optional signature.
- Notification retries, per-channel status, and manual replay.
- Mock end-to-end test and unit/integration tests.

Deferred by design or environment:

- Live Dify installation and Chatflow validation.
- Live Feishu tenant webhook validation.
- Real Pi model run through the bridge.
- Orphan process cleanup after an ungraceful bridge crash.
- Feishu interactive card rendering.
- Multi-agent routing.

## 3. Architecture

```text
Dify Chatflow
  POST /trigger
      |
      v
Bridge Public Server (Hono, BRIDGE_HOST:BRIDGE_PORT, default 0.0.0.0:4100)
      |
      v
BridgeRepository (SQLite, default ~/.night-shift/bridge.db)
      |
      v
BridgeScheduler (BRIDGE_MAX_CONCURRENCY, default 1)
      |
      v
PiBridgeAgentRunner
  pi --mode json -p --no-approve
     --extension extensions/delivery.ts
     --append-system-prompt <bridge prompt>
      |
      v
Pi calls deliver_result
  POST /internal/delivery (loopback only, default 127.0.0.1:4101)
      |
      v
DeliveryService -> NotificationDispatcher
      |
      +--> Generic webhook
      +--> Feishu custom bot
```

If the agent exits without delivery or the timeout fires, the supervisor settles
the task and sends a fallback notification instead.

## 4. Repository Map

| Path | Purpose |
| --- | --- |
| `src/bridge/server.ts` | Standalone bridge entrypoint and runtime assembly |
| `src/bridge/config.ts` | Environment parsing and fail-closed validation |
| `src/bridge/public-routes.ts` | `/trigger`, admin APIs, health |
| `src/bridge/internal-routes.ts` | `/internal/delivery` |
| `src/bridge/security.ts` | Bearer auth helpers, path guard, payload validation |
| `src/bridge/db/schema.ts` | SQLite schema and database open helper |
| `src/bridge/db/queries.ts` | Task, event, and notification persistence |
| `src/bridge/scheduler.ts` | Queue loop, concurrency, timeout fallback, recovery |
| `src/bridge/agent-runner.ts` | Pi runner and bridge environment injection |
| `src/bridge/delivery.ts` | Delivery settlement and fallback settlement |
| `src/bridge/notifier/index.ts` | Notifier factory, retries, fan-out, replay |
| `src/bridge/notifier/format.ts` | Message formatting and truncation |
| `src/bridge/notifier/generic.ts` | Generic JSON webhook |
| `src/bridge/notifier/feishu.ts` | Feishu text payload and signature |
| `extensions/delivery.ts` | Pi custom tool that calls the internal endpoint |
| `scripts/bridge-mock.ts` | Mock end-to-end test with no Dify, Feishu, or model |
| `.env.bridge.example` | Configuration template |
| `docs/dify-bridge-usage.md` | Usage, Dify setup, and Feishu setup |

Modified shared files:

| Path | Change |
| --- | --- |
| `src/adapters/types.ts` | Added `killGraceMs`, `detached`, and `extensions` options |
| `src/adapters/pi.ts` | Passes `--extension` and detached process-group flag |
| `src/core/watchdog.ts` | Supports detached process-group termination |
| `src/types/index.ts` | Added the `AGENT` pipeline stage |
| `package.json` | Added bridge scripts |
| `README.md` | Added a bridge documentation link |

## 5. API Contracts

### 5.1 Trigger

`POST /trigger`

Headers:

```http
Authorization: Bearer <BRIDGE_TRIGGER_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "task_prompt": "Do the requested task.",
  "relative_path": "projects/example",
  "conversation_id": "dify-conversation-id",
  "user_id": "dify-user-id",
  "idempotency_key": "optional-stable-key"
}
```

Response `200 OK`:

```json
{
  "status": "accepted",
  "task_id": "uuid-v4",
  "message": "Task queued and running in background.",
  "duplicate": false
}
```

Important status codes:

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON or invalid fields |
| `401` | Missing or invalid public token |
| `403` | Resolved path escapes `WORKSPACE_BASE` |
| `429` | Queue depth reached `BRIDGE_MAX_QUEUE_DEPTH` |

### 5.2 Internal Delivery

`POST /internal/delivery`, bound to `127.0.0.1` only.

Headers:

```http
Authorization: Bearer <BRIDGE_INTERNAL_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "task_id": "uuid-v4",
  "status": "COMPLETED",
  "summary": "Concise result summary.",
  "modified_files": ["src/example.ts"],
  "verification_passed": true,
  "notes": "Optional notes."
}
```

The first valid delivery wins. Duplicate calls return `already_delivered` and do
not send a second IM message.

### 5.3 Admin

All admin routes require the public trigger token.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health, queue counts, notifier channels |
| `GET` | `/api/bridge/tasks` | List tasks, optional `status` and `limit` |
| `GET` | `/api/bridge/tasks/:id` | Task detail |
| `GET` | `/api/bridge/tasks/:id/notifications` | Per-channel notification rows |
| `POST` | `/api/bridge/tasks/:id/replay-notification` | Re-send a settled task |

## 6. Data Model

The bridge uses a separate SQLite database. Default:
`~/.night-shift/bridge.db`.

Tables:

- `bridge_tasks`: task identity, workspace, status, outcome, delivery payload,
  exit code, log tail, notification aggregate, recovery marker.
- `bridge_events`: audit trail for creation, start, settlement, notification, and
  interruption events.
- `bridge_notifications`: one row per task and channel, with attempt count and
  last error.

The existing Night-Shift queue tables are untouched.

## 7. Configuration

Required:

| Variable | Meaning |
| --- | --- |
| `WORKSPACE_BASE` | Absolute workspace root for all tasks |
| `BRIDGE_TRIGGER_TOKEN` | Public bearer token for `/trigger` and admin routes |
| `FEISHU_WEBHOOK_URL` | Required when the Feishu notifier is enabled |

Common optional values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_PORT` | `4100` | Public server port |
| `BRIDGE_INTERNAL_PORT` | `4101` | Internal delivery port |
| `BRIDGE_DB_PATH` | `~/.night-shift/bridge.db` | SQLite path |
| `BRIDGE_TASK_TIMEOUT_MS` | `900000` | 15-minute task timeout |
| `BRIDGE_MAX_CONCURRENCY` | `1` | Concurrent agent runs |
| `BRIDGE_NOTIFIERS` | `feishu` | Comma-separated `feishu,generic` |
| `BRIDGE_PI_BINARY` | `pi` | Pi executable |
| `BRIDGE_PI_EXTENSION` | project `extensions/delivery.ts` | Delivery tool path |
| `BRIDGE_DEDUPE_WINDOW_MS` | `0` | Optional duplicate-trigger window |

See `.env.bridge.example` for the full list.

The bridge refuses to start when:

- `WORKSPACE_BASE` is missing.
- `BRIDGE_TRIGGER_TOKEN` is missing.
- A selected notifier has no webhook URL.
- `BRIDGE_INTERNAL_HOST` is not a loopback address.
- `BRIDGE_AGENT_ID` is not `pi`.
- The configured Pi extension does not exist.

## 8. Runbook

### 8.1 Prepare

```bash
bun install
cp .env.bridge.example .env
# Edit .env with workspace, tokens, and notifier settings.
```

### 8.2 Run Mock Checks

No Dify, Feishu, or model is required:

```bash
bun run test:bridge
bun run test:bridge:mock
```

The mock e2e uses ports `45100`, `45101`, and `45102` by default. Override them
with `BRIDGE_MOCK_PUBLIC_PORT`, `BRIDGE_MOCK_INTERNAL_PORT`, and
`BRIDGE_MOCK_WEBHOOK_PORT` if needed.

### 8.3 Start

```bash
bun run start:bridge
```

Health:

```bash
curl http://127.0.0.1:4100/health
```

### 8.4 Trigger

```bash
curl -X POST http://127.0.0.1:4100/trigger \
  -H "Authorization: Bearer $BRIDGE_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task_prompt": "Inspect the project and summarize its test setup.",
    "relative_path": "projects/example",
    "conversation_id": "conv-1",
    "user_id": "user-1",
    "idempotency_key": "manual-test-1"
  }'
```

### 8.5 Inspect And Replay

```bash
curl http://127.0.0.1:4100/api/bridge/tasks/$TASK_ID \
  -H "Authorization: Bearer $BRIDGE_TRIGGER_TOKEN"

curl -X POST http://127.0.0.1:4100/api/bridge/tasks/$TASK_ID/replay-notification \
  -H "Authorization: Bearer $BRIDGE_TRIGGER_TOKEN"
```

### 8.6 Shutdown

Send `SIGTERM` or `SIGINT`. The bridge stops accepting triggers, waits up to
`BRIDGE_SHUTDOWN_GRACE_MS`, aborts remaining process groups, optionally notifies
interrupted tasks, and closes SQLite.

## 9. Verification Evidence

Run at implementation commit `c88fb48`:

| Command | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| `bun run lint` | Passed |
| `bun run test:bridge` | 38 tests passed |
| `bun run test:bridge:mock` | Passed, received `COMPLETED`, `FAILED`, `TIMEOUT` |
| `bun src/bridge/server.ts` smoke test | Health `200`, internal health `200`, unauthenticated trigger `401`, graceful shutdown |

Full `bun test` result: 58 passed, 1 environment failure. The failure is the
existing Pi readiness test because the local `pi` binary is a node shim and
`node` is not installed. The bridge tests do not depend on that binary; the Pi
runner is tested with a fake executable.

## 10. Known Gaps

1. **Live Dify validation**: Dify is not installed. The Chatflow HTTP node,
   variable mapping, and real conversation flow are untested.
2. **Live Feishu validation**: The payload and signature are tested locally, but
   no real tenant webhook has received a message.
3. **Real Pi model run**: The bridge spawn path, environment injection, extension
   argument, and timeout kill are tested with a fake Pi executable. A real model
   run is not validated.
4. **Orphan process cleanup after bridge crash**: Restart recovery marks stale
   `RUNNING` tasks `INTERRUPTED` and notifies, but it does not search for and kill
   a process tree left by the previous bridge process.
5. **Feishu card message**: The MVP sends plain text. Interactive cards are not
   implemented.
6. **Dify DSL export**: No version-specific Chatflow DSL file is included. Setup
   is documented as manual node configuration.
7. **Multi-agent routing**: The bridge supports `pi` only. The existing opencode
   adapter is not wired into the bridge.
8. **Git behavior**: The bridge does not inspect, stage, or commit changes. If a
   task needs a commit, the task prompt must request it.
9. **Dedupe window default**: `BRIDGE_DEDUPE_WINDOW_MS` is disabled because it can
   suppress a legitimate repeated task.

## 11. Next Steps

### Step 1: Validate Feishu

1. Create a Feishu test group.
2. Add a Custom Bot to the group.
3. Copy the webhook URL into `FEISHU_WEBHOOK_URL`.
4. If signature verification is enabled, copy the secret into
   `FEISHU_WEBHOOK_SECRET`.
5. Start the bridge and trigger a small task.
6. Confirm the group receives a text result.

Acceptance: one `COMPLETED` message with summary, files, and verification status.

### Step 2: Validate A Real Pi Run

1. Confirm `pi --version` works on the host that will run the bridge.
2. Set `BRIDGE_PI_BINARY` if Pi is not on `PATH`.
3. Set `BRIDGE_PI_MODEL` if needed.
4. Trigger a small task in a test workspace.
5. Confirm the agent calls `deliver_result` and the IM message arrives.

Acceptance: task status `SETTLED`, outcome `COMPLETED`, notification status
`SENT`.

### Step 3: Validate Dify

1. Install Dify.
2. Create a Chatflow with `Start -> HTTP Request -> Answer`.
3. Send `sys.query`, `sys.conversation_id`, and `sys.user_id`.
4. Use a short HTTP timeout because the bridge returns immediately.
5. Disable HTTP retries unless a stable `idempotency_key` is configured.
6. Trigger from the Dify WebApp and confirm the immediate acknowledgement.
7. Confirm the final result arrives through IM.

Acceptance: Dify shows the acknowledgement, the local task completes, and the IM
message arrives without a second trigger.

### Step 4: Optional Hardening

- Add PID persistence and orphan-tree cleanup on startup.
- Add Feishu interactive card formatting.
- Add a Dify conversation variable or code-node UUID for `idempotency_key`.
- Decide whether to enable `BRIDGE_DEDUPE_WINDOW_MS`.
- Add a systemd unit or Dockerfile if the bridge will run permanently.

## 12. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `401` on `/trigger` | Wrong or missing public token | Check `BRIDGE_TRIGGER_TOKEN` |
| `403 invalid_workspace_path` | Path escapes `WORKSPACE_BASE` or does not exist | Use an existing directory under the workspace |
| `429 queue_full` | Queue depth reached | Wait, raise `BRIDGE_MAX_QUEUE_DEPTH`, or raise concurrency |
| Task `FAILED` with "without calling deliver_result" | Agent did not call the tool | Check the Pi extension, system prompt, and agent logs |
| Task `TIMEOUT` | Agent exceeded `BRIDGE_TASK_TIMEOUT_MS` | Increase timeout or investigate the task |
| Notification status `FAILED` | IM webhook unavailable or rejected the payload | Check logs, fix the webhook, call the replay endpoint |
| Pi spawn failure | `pi` binary is missing or a node shim lacks `node` | Set `BRIDGE_PI_BINARY` to a working executable |
| `EADDRINUSE` | Port conflict | Change `BRIDGE_PORT` or `BRIDGE_INTERNAL_PORT` |

Logs are structured JSON lines. They include task IDs and event types, but never
tokens or webhook URLs.

## 13. Security Notes

- Keep `BRIDGE_TRIGGER_TOKEN` and `BRIDGE_INTERNAL_TOKEN` out of source control.
- Expose only `BRIDGE_PORT` through Cloudflare Tunnel or a reverse proxy.
- Keep `BRIDGE_INTERNAL_PORT` on loopback.
- Do not pass the public trigger token to the agent process.
- The internal delivery token is passed to the agent only through its environment.
- Feishu webhook URLs and secrets belong in the environment file, not in code.
- Path validation uses `realpath`, so symlink escapes are rejected.
- Request bodies are limited to 1 MiB on the public server and 256 KiB on the
  internal server.
- Log tails are truncated to 2 KiB and 50 lines before storage or notification.

## 14. Design Decisions

| Decision | Rationale |
| --- | --- |
| No Dify chat callback | Avoids re-trigger loops and Dify-side LLM cost |
| IM delivery | Result is visible without refreshing Dify |
| Standalone bridge process | Public and internal endpoints can bind different interfaces |
| Separate SQLite database | Existing Night-Shift schema remains untouched |
| Agent self-delivery tool | Structured results instead of terminal scraping |
| Supervisor fallback | Guarantees a terminal notification |
| No git integration | The bridge supports general tasks, not only coding |
| Pi only in MVP | Keeps the first integration small and testable |

## 15. Handoff Checklist

- [x] Bridge code committed at `c88fb48`.
- [x] Plan, usage, and handoff documents present.
- [x] Environment template present.
- [x] Typecheck and lint pass.
- [x] Bridge unit and integration tests pass.
- [x] Mock end-to-end test passes.
- [x] Entrypoint smoke test passes.
- [ ] Live Feishu webhook validated.
- [ ] Real Pi model run validated.
- [ ] Live Dify Chatflow validated.
- [ ] Optional orphan-process cleanup implemented.
