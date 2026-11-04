/**
 * Mock end-to-end check for the Dify bridge.
 *
 * This script does not call Dify, DingTalk, or a real model. It starts the bridge
 * with an in-memory database and a stub agent, then exercises the public trigger,
 * the internal delivery endpoint, and a generic webhook receiver.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startBridge } from '../src/bridge/server.ts';
import { GenericWebhookNotifier } from '../src/bridge/notifier/generic.ts';
import { createTestConfig } from '../src/bridge/test-helpers.ts';
import type { AgentRunnerLike, AgentRunOutcome, BridgeTask } from '../src/bridge/types.ts';

const PUBLIC_PORT = Number(process.env.BRIDGE_MOCK_PUBLIC_PORT ?? 45100);
const INTERNAL_PORT = Number(process.env.BRIDGE_MOCK_INTERNAL_PORT ?? 45101);
const WEBHOOK_PORT = Number(process.env.BRIDGE_MOCK_WEBHOOK_PORT ?? 45102);
const TRIGGER_TOKEN = 'mock-trigger-token';
const INTERNAL_TOKEN = 'mock-internal-token';

interface ReceivedEvent {
  task_id?: string;
  outcome?: string;
  [key: string]: unknown;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for condition');
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-mock-workspace-'));
  const received: ReceivedEvent[] = [];

  const webhookServer = Bun.serve({
    hostname: '127.0.0.1',
    port: WEBHOOK_PORT,
    fetch: async (request) => {
      const body = (await request.json()) as ReceivedEvent;
      received.push(body);
      return Response.json({ ok: true });
    }
  });

  const config = createTestConfig({
    port: PUBLIC_PORT,
    internalPort: INTERNAL_PORT,
    workspaceBase: workspace,
    triggerToken: TRIGGER_TOKEN,
    internalToken: INTERNAL_TOKEN,
    dbPath: ':memory:',
    piExtension: resolve(import.meta.dir, '../extensions/delivery.ts'),
    genericWebhookUrl: `http://127.0.0.1:${WEBHOOK_PORT}/hook`,
    notifyRetryDelaysMs: [0, 0]
  });

  const runner: AgentRunnerLike = {
    async run(task: BridgeTask): Promise<AgentRunOutcome> {
      if (task.prompt.includes('NO_DELIVERY')) {
        return {
          exitCode: 1,
          summary: 'Stub agent exited without delivery',
          rawTail: 'stub failure tail',
          durationMs: 1
        };
      }

      if (task.prompt.includes('TIMEOUT')) {
        return {
          exitCode: 124,
          summary: 'Stub agent timed out',
          rawTail: 'stub timeout tail',
          durationMs: 1
        };
      }

      const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/delivery`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INTERNAL_TOKEN}`
        },
        body: JSON.stringify({
          task_id: task.id,
          status: 'COMPLETED',
          summary: 'Stub agent completed the task',
          modified_files: ['mock-output.txt'],
          verification_passed: true
        })
      });

      if (!response.ok) {
        throw new Error(`Stub delivery failed with HTTP ${response.status}`);
      }

      return {
        exitCode: 0,
        summary: 'Stub agent completed',
        rawTail: 'stub success tail',
        durationMs: 1
      };
    },
    async abort() {},
    async abortAll() {}
  };

  const runtime = await startBridge({
    config,
    runner,
    notifiers: [new GenericWebhookNotifier(`http://127.0.0.1:${WEBHOOK_PORT}/hook`)]
  });

  const publicUrl = `http://127.0.0.1:${PUBLIC_PORT}`;

  try {
    const unauthorized = await fetch(`${publicUrl}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert(unauthorized.status === 401, `Expected 401 for unauthenticated trigger, got ${unauthorized.status}`);

    const publicInternal = await fetch(`${publicUrl}/internal/delivery`, { method: 'POST' });
    assert(publicInternal.status === 404, 'Internal delivery must not be exposed on the public port');

    const happyResponse = await fetch(`${publicUrl}/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TRIGGER_TOKEN}`
      },
      body: JSON.stringify({
        task_prompt: 'Complete a normal mock task',
        conversation_id: 'mock-conversation',
        user_id: 'mock-user',
        idempotency_key: 'mock-happy-1'
      })
    });
    assert(happyResponse.status === 200, `Expected 200 for happy trigger, got ${happyResponse.status}`);
    const happy = (await happyResponse.json()) as { task_id: string };
    assert(typeof happy.task_id === 'string', 'Happy trigger did not return a task_id');

    await waitFor(() => received.some((event) => event.task_id === happy.task_id));
    const happyEvent = received.find((event) => event.task_id === happy.task_id);
    assert(happyEvent?.outcome === 'COMPLETED', 'Happy path notification was not COMPLETED');

    const fallbackResponse = await fetch(`${publicUrl}/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TRIGGER_TOKEN}`
      },
      body: JSON.stringify({
        task_prompt: 'NO_DELIVERY: simulate a crashed agent',
        conversation_id: 'mock-conversation',
        user_id: 'mock-user',
        idempotency_key: 'mock-fallback-1'
      })
    });
    const fallback = (await fallbackResponse.json()) as { task_id: string };
    await waitFor(() =>
      received.some((event) => event.task_id === fallback.task_id && event.outcome === 'FAILED')
    );

    const timeoutResponse = await fetch(`${publicUrl}/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TRIGGER_TOKEN}`
      },
      body: JSON.stringify({
        task_prompt: 'TIMEOUT: simulate a timeout',
        conversation_id: 'mock-conversation',
        user_id: 'mock-user',
        idempotency_key: 'mock-timeout-1'
      })
    });
    const timeout = (await timeoutResponse.json()) as { task_id: string };
    await waitFor(() =>
      received.some((event) => event.task_id === timeout.task_id && event.outcome === 'TIMEOUT')
    );

    const taskResponse = await fetch(`${publicUrl}/api/bridge/tasks/${happy.task_id}`, {
      headers: { Authorization: `Bearer ${TRIGGER_TOKEN}` }
    });
    const taskBody = (await taskResponse.json()) as {
      task: { status: string; notification_status: string };
    };
    assert(taskBody.task.status === 'SETTLED', 'Happy task did not settle');
    assert(taskBody.task.notification_status === 'SENT', 'Happy task notification was not sent');

    console.log('Mock bridge e2e passed.');
    console.log(`Received notifications: ${received.map((event) => event.outcome).join(', ')}`);
  } finally {
    await runtime.stop();
    webhookServer.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error('Mock bridge e2e failed:', error);
  process.exit(1);
}
