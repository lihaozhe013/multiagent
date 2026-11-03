# Dify Local Bridge - Usage

This document describes the implemented bridge service. The design and
decision record is in `docs/dify-bridge-im-delivery-plan.md`, and the operational
handoff is in `docs/dify-bridge-handoff.md`.

## What Is Implemented

- Standalone Bun/Hono bridge with a public trigger server and a loopback-only
  delivery server.
- Bearer authentication for the public and internal endpoints.
- Workspace path validation with `realpath` and separator-aware prefix checks.
- Dify trigger contract with optional idempotency keys and an optional duplicate
  window.
- SQLite persistence for tasks, events, and per-channel notification attempts.
- Concurrency-limited scheduler with queued and running state.
- Pi agent runner with injected task environment and the `deliver_result` custom
  tool extension.
- Supervisor fallback for missing delivery, non-zero exits, timeouts, shutdown,
  and restart recovery.
- Generic JSON webhook notifier and Feishu custom bot notifier with optional
  signature.
- Notification retries, per-channel status, and replay through the admin API.
- Mock end-to-end test that covers happy path, missing-delivery fallback, timeout
  fallback, authentication, and internal endpoint isolation.

## What Is Not Yet Validated

- A live Dify installation and Chatflow HTTP node. Dify is intentionally deferred.
- A real Feishu tenant webhook. The payload and signature code is implemented but
  only tested with local assertions.
- A real Pi model run through the bridge. The delivery extension is implemented
  and the mock e2e uses a stub agent.
- Killing orphan Pi processes after an ungraceful bridge crash. Restart recovery
  marks the task `INTERRUPTED` and notifies, but it does not attempt to find a
  previous process tree.

## Configuration

Copy `.env.bridge.example` to `.env` (ignored by git) and fill in the values. Bun loads `.env` automatically for `bun run start:bridge`.

Required:

```dotenv
WORKSPACE_BASE=/home/you/dev
BRIDGE_TRIGGER_TOKEN=replace-with-a-long-random-token
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/...
```

Useful optional values:

```dotenv
BRIDGE_PORT=4100
BRIDGE_INTERNAL_PORT=4101
BRIDGE_DB_PATH=~/.night-shift/bridge.db
BRIDGE_TASK_TIMEOUT_MS=900000
BRIDGE_MAX_CONCURRENCY=1
BRIDGE_NOTIFIERS=feishu
BRIDGE_PI_BINARY=pi
BRIDGE_PI_EXTENSION=/absolute/path/to/extensions/delivery.ts
```

The internal host must stay on loopback. The bridge refuses to start with a
non-loopback internal bind address.

## Run The Mock Test

The mock test does not need Dify, Feishu, or a model:

```bash
bun run test:bridge:mock
```

It starts the bridge on ports `45100`/`45101` and a local webhook receiver on
`45102`. Override the ports with `BRIDGE_MOCK_PUBLIC_PORT`,
`BRIDGE_MOCK_INTERNAL_PORT`, and `BRIDGE_MOCK_WEBHOOK_PORT` if needed.

Run the unit and integration tests:

```bash
bun run test:bridge
```

## Start The Bridge

```bash
bun run start:bridge
```

The public server listens on `BRIDGE_PORT` (default `4100`). The internal server
listens on `127.0.0.1:BRIDGE_INTERNAL_PORT` (default `4101`).

Health check:

```bash
curl http://127.0.0.1:4100/health
```

## Trigger A Task

```bash
curl -X POST http://127.0.0.1:4100/trigger \
  -H "Authorization: Bearer $BRIDGE_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task_prompt": "Inspect the project and summarize its test setup.",
    "relative_path": "projects/example",
    "conversation_id": "conv-1",
    "user_id": "user-1",
    "idempotency_key": "optional-stable-key"
  }'
```

The response is immediate:

```json
{
  "status": "accepted",
  "task_id": "uuid-v4",
  "message": "Task queued and running in background.",
  "duplicate": false
}
```

Inspect the task:

```bash
curl http://127.0.0.1:4100/api/bridge/tasks/$TASK_ID \
  -H "Authorization: Bearer $BRIDGE_TRIGGER_TOKEN"
```

Replay a failed notification:

```bash
curl -X POST http://127.0.0.1:4100/api/bridge/tasks/$TASK_ID/replay-notification \
  -H "Authorization: Bearer $BRIDGE_TRIGGER_TOKEN"
```

## Dify Chatflow

Use a Chatflow with three nodes:

```text
Start -> HTTP Request (POST /trigger) -> Answer
```

The HTTP Request node should send `sys.query` as `task_prompt`,
`sys.conversation_id` as `conversation_id`, and `sys.user_id` as `user_id`. Set a
short timeout because the bridge returns immediately. Do not add a callback node
to `/v1/chat-messages`; results are pushed to IM.

## Feishu Bot

The default notifier is a Feishu custom bot in a group:

1. Create a test group.
2. Group settings -> Bots -> Add Custom Bot.
3. Copy the webhook URL to `FEISHU_WEBHOOK_URL`.
4. If signature verification is enabled, copy the secret to
   `FEISHU_WEBHOOK_SECRET`.
5. Send a test message before wiring the bridge.

A custom bot posts only to its group. Direct messages require a full Feishu app
and are outside the current scope.

## Operational Notes

- Run the bridge under systemd or another supervisor with restart-on-fail.
- Expose only `BRIDGE_PORT` through Cloudflare Tunnel or a reverse proxy.
- Keep `BRIDGE_INTERNAL_PORT` on `127.0.0.1`.
- Keep tokens and webhook URLs in an environment file with restrictive
  permissions.
- The bridge does not inspect or commit git state. If a task needs a commit, the
  task prompt must ask the agent to do it.
- `BRIDGE_DEDUPE_WINDOW_MS` is disabled by default. Enabling it can suppress a
  legitimate repeated request, so use it only after observing Dify retry behavior.
