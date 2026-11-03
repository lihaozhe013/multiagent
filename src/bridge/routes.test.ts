import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BridgeRepository } from './db/queries.ts';
import { DeliveryService } from './delivery.ts';
import { NotificationDispatcher } from './notifier/index.ts';
import { BridgeScheduler } from './scheduler.ts';
import { createPublicApp } from './public-routes.ts';
import { createInternalApp } from './internal-routes.ts';
import { createTestConfig, createTestRepo, MockAgentRunner, MockNotifier } from './test-helpers.ts';

describe('bridge routes', () => {
  let repo: BridgeRepository;
  let notifier: MockNotifier;
  let publicApp: ReturnType<typeof createPublicApp>;
  let internalApp: ReturnType<typeof createInternalApp>;
  let root: string;
  let workspace: string;

  const triggerHeaders = {
    Authorization: 'Bearer test-trigger-token',
    'Content-Type': 'application/json'
  };
  const internalHeaders = {
    Authorization: 'Bearer test-internal-token',
    'Content-Type': 'application/json'
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bridge-routes-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'project'));
    mkdirSync(join(root, 'outside'));

    repo = createTestRepo();
    notifier = new MockNotifier();
    const config = createTestConfig({ workspaceBase: workspace });
    const dispatcher = new NotificationDispatcher(repo, [notifier], [0, 0]);
    const deliveryService = new DeliveryService(repo, dispatcher);
    const scheduler = new BridgeScheduler(
      repo,
      config,
      new MockAgentRunner(),
      deliveryService,
      dispatcher
    );
    publicApp = createPublicApp({ config, repo, dispatcher, scheduler });
    internalApp = createInternalApp({ config, deliveryService });
  });

  afterAll(() => {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('exposes an unauthenticated health endpoint', async () => {
    const response = await publicApp.request('/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; notifier_channels: string[] };
    expect(body.status).toBe('ok');
    expect(body.notifier_channels).toContain('generic');
  });

  it('rejects unauthenticated triggers', async () => {
    const response = await publicApp.request('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(401);
  });

  it('rejects path traversal', async () => {
    const response = await publicApp.request('/trigger', {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        task_prompt: 'Do work',
        relative_path: '../outside',
        conversation_id: 'conv-1',
        user_id: 'user-1'
      })
    });
    expect(response.status).toBe(403);
  });

  it('accepts a valid trigger and deduplicates idempotency keys', async () => {
    const payload = {
      task_prompt: 'Do work',
      relative_path: 'project',
      conversation_id: 'conv-1',
      user_id: 'user-1',
      idempotency_key: 'route-key-1'
    };

    const firstResponse = await publicApp.request('/trigger', {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify(payload)
    });
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      task_id: string;
      duplicate: boolean;
    };
    expect(first.duplicate).toBe(false);

    const secondResponse = await publicApp.request('/trigger', {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify(payload)
    });
    const second = (await secondResponse.json()) as {
      task_id: string;
      duplicate: boolean;
    };
    expect(second.duplicate).toBe(true);
    expect(second.task_id).toBe(first.task_id);

    const taskResponse = await publicApp.request(`/api/bridge/tasks/${first.task_id}`, {
      headers: triggerHeaders
    });
    expect(taskResponse.status).toBe(200);
    const taskBody = (await taskResponse.json()) as {
      task: { id: string; resolved_cwd: string };
    };
    expect(taskBody.task.id).toBe(first.task_id);
    expect(taskBody.task.resolved_cwd).toBe(join(workspace, 'project'));

    const queued = repo.claimNextQueued();
    if (queued) {
      repo.settleTask(queued.id, {
        outcome: 'FAILED',
        reported: false,
        summary: 'Test cleanup'
      });
    }
  });

  it('accepts a delivery on the internal endpoint and rejects duplicates', async () => {
    const task = repo.createTask({
      prompt: 'Internal delivery test',
      resolvedCwd: workspace,
      conversationId: 'conv-2',
      userId: 'user-2',
      agentId: 'pi'
    }).task;
    const claimed = repo.claimNextQueued();
    expect(claimed?.id).toBe(task.id);

    const payload = {
      task_id: task.id,
      status: 'COMPLETED',
      summary: 'Done',
      modified_files: [],
      verification_passed: true
    };

    const first = await internalApp.request('/internal/delivery', {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(payload)
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe('delivered');

    const second = await internalApp.request('/internal/delivery', {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify(payload)
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe('already_delivered');
    expect(notifier.events.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects internal delivery without the internal token', async () => {
    const response = await internalApp.request('/internal/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(401);
  });
});
