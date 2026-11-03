import { afterEach, describe, expect, it } from 'bun:test';
import type { BridgeRepository } from './db/queries.ts';
import { DeliveryService } from './delivery.ts';
import { NotificationDispatcher } from './notifier/index.ts';
import { createTestRepo, MockNotifier } from './test-helpers.ts';

describe('delivery settlement', () => {
  let repo: BridgeRepository | null = null;

  afterEach(() => {
    repo?.close();
    repo = null;
  });

  function setup() {
    repo = createTestRepo();
    const notifier = new MockNotifier();
    const dispatcher = new NotificationDispatcher(repo, [notifier], [0, 0]);
    const service = new DeliveryService(repo, dispatcher);
    return { repo, notifier, dispatcher, service };
  }

  function createRunningTask(repo: BridgeRepository, idempotencyKey?: string) {
    const result = repo.createTask({
      prompt: 'Do the work',
      resolvedCwd: process.cwd(),
      conversationId: 'conv-1',
      userId: 'user-1',
      ...(idempotencyKey ? { idempotencyKey } : {}),
      agentId: 'pi'
    });
    const claimed = repo.claimNextQueued();
    expect(claimed?.id).toBe(result.task.id);
    return claimed!;
  }

  it('accepts the first delivery and sends one notification', async () => {
    const { repo, notifier, service } = setup();
    const task = createRunningTask(repo);

    const result = await service.deliver({
      task_id: task.id,
      status: 'COMPLETED',
      summary: 'Done',
      modified_files: ['src/a.ts'],
      verification_passed: true
    });

    expect(result.status).toBe('delivered');
    const latest = repo.getTask(task.id);
    expect(latest?.status).toBe('SETTLED');
    expect(latest?.outcome).toBe('COMPLETED');
    expect(latest?.reported).toBe(true);
    expect(latest?.notificationStatus).toBe('SENT');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.outcome).toBe('COMPLETED');
  });

  it('ignores duplicate deliveries', async () => {
    const { repo, notifier, service } = setup();
    const task = createRunningTask(repo);

    const payload = {
      task_id: task.id,
      status: 'COMPLETED' as const,
      summary: 'Done',
      modified_files: [],
      verification_passed: true
    };

    expect((await service.deliver(payload)).status).toBe('delivered');
    expect((await service.deliver(payload)).status).toBe('already_delivered');
    expect(notifier.events).toHaveLength(1);
  });

  it('settles fallbacks with a notification', async () => {
    const { repo, notifier, service } = setup();
    const task = createRunningTask(repo);

    const settled = await service.fallback(task, 'FAILED', {
      summary: 'Agent exited without delivery',
      exitCode: 1,
      logTail: 'line 1\nline 2'
    });

    expect(settled?.status).toBe('SETTLED');
    expect(settled?.outcome).toBe('FAILED');
    expect(settled?.reported).toBe(false);
    expect(settled?.exitCode).toBe(1);
    expect(settled?.logTail).toContain('line 2');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.outcome).toBe('FAILED');
  });

  it('does not deliver after a fallback has settled the task', async () => {
    const { repo, notifier, service } = setup();
    const task = createRunningTask(repo);

    await service.fallback(task, 'TIMEOUT', { summary: 'Timed out', exitCode: 124 });
    const result = await service.deliver({
      task_id: task.id,
      status: 'COMPLETED',
      summary: 'Late delivery',
      modified_files: [],
      verification_passed: true
    });

    expect(result.status).toBe('task_not_running');
    expect(notifier.events).toHaveLength(1);
    expect(repo.getTask(task.id)?.outcome).toBe('TIMEOUT');
  });

  it('deduplicates idempotency keys', () => {
    repo = createTestRepo();
    const input = {
      prompt: 'Do the work',
      resolvedCwd: process.cwd(),
      conversationId: 'conv-1',
      userId: 'user-1',
      idempotencyKey: 'key-1',
      agentId: 'pi'
    };

    const first = repo.createTask(input);
    const second = repo.createTask(input);
    expect(second.duplicate).toBe(true);
    expect(second.task.id).toBe(first.task.id);
  });

  it('deduplicates recent identical triggers when enabled', () => {
    repo = createTestRepo(60000);
    const input = {
      prompt: 'Do the work',
      resolvedCwd: process.cwd(),
      conversationId: 'conv-1',
      userId: 'user-1',
      agentId: 'pi'
    };

    const first = repo.createTask(input);
    const second = repo.createTask(input);
    expect(second.duplicate).toBe(true);
    expect(second.task.id).toBe(first.task.id);
  });
});
