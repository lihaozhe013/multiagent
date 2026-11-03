import { afterEach, describe, expect, it } from 'bun:test';
import type { BridgeRepository } from './db/queries.ts';
import { DeliveryService } from './delivery.ts';
import { NotificationDispatcher } from './notifier/index.ts';
import { BridgeScheduler } from './scheduler.ts';
import type { AgentRunnerLike, AgentRunOutcome, BridgeTask } from './types.ts';
import {
  createTestConfig,
  createTestRepo,
  MockAgentRunner,
  MockNotifier,
  waitFor
} from './test-helpers.ts';

describe('bridge scheduler', () => {
  let repo: BridgeRepository | null = null;
  let scheduler: BridgeScheduler | null = null;

  afterEach(async () => {
    await scheduler?.stop();
    repo?.close();
    repo = null;
    scheduler = null;
  });

  function setup(runner: AgentRunnerLike, options: { recoverNotify?: boolean } = {}) {
    repo = createTestRepo();
    const notifier = new MockNotifier();
    const config = createTestConfig({ recoverNotify: options.recoverNotify ?? false });
    const dispatcher = new NotificationDispatcher(repo, [notifier], [0, 0]);
    const deliveryService = new DeliveryService(repo, dispatcher);
    scheduler = new BridgeScheduler(repo, config, runner, deliveryService, dispatcher);
    return { repo, notifier, config, scheduler, deliveryService };
  }

  function createTask(repo: BridgeRepository) {
    return repo.createTask({
      prompt: 'Do the work',
      resolvedCwd: process.cwd(),
      conversationId: 'conv-1',
      userId: 'user-1',
      agentId: 'pi'
    }).task;
  }

  it('emits a fallback when the agent exits without delivery', async () => {
    const runner = new MockAgentRunner({
      exitCode: 1,
      summary: 'Agent failed',
      rawTail: 'error line',
      durationMs: 5
    });
    const { repo, notifier, scheduler } = setup(runner);
    const task = createTask(repo);

    await scheduler.start();
    await waitFor(() => repo.getTask(task.id)?.status === 'SETTLED');

    const latest = repo.getTask(task.id);
    expect(latest?.outcome).toBe('FAILED');
    expect(latest?.reported).toBe(false);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.outcome).toBe('FAILED');
    expect(notifier.events[0]?.exitCode).toBe(1);
  });

  it('emits a timeout fallback for exit code 124', async () => {
    const runner = new MockAgentRunner({
      exitCode: 124,
      summary: 'timed out',
      rawTail: 'timeout tail',
      durationMs: 5
    });
    const { repo, notifier, scheduler } = setup(runner);
    const task = createTask(repo);

    await scheduler.start();
    await waitFor(() => repo.getTask(task.id)?.status === 'SETTLED');

    expect(repo.getTask(task.id)?.outcome).toBe('TIMEOUT');
    expect(notifier.events[0]?.outcome).toBe('TIMEOUT');
  });

  it('does not send a fallback after a successful delivery', async () => {
    let service: DeliveryService | null = null;
    const runner: AgentRunnerLike = {
      async run(task: BridgeTask): Promise<AgentRunOutcome> {
        await service!.deliver({
          task_id: task.id,
          status: 'COMPLETED',
          summary: 'Delivered',
          modified_files: [],
          verification_passed: true
        });
        return { exitCode: 0, summary: 'done', rawTail: '', durationMs: 1 };
      },
      async abort() {},
      async abortAll() {}
    };
    const { repo, notifier, scheduler, deliveryService } = setup(runner);
    service = deliveryService;
    const task = createTask(repo);

    await scheduler.start();
    await waitFor(() => repo.getTask(task.id)?.status === 'SETTLED');

    expect(repo.getTask(task.id)?.outcome).toBe('COMPLETED');
    expect(notifier.events).toHaveLength(1);
  });

  it('marks stale running tasks as interrupted on recovery', async () => {
    const runner = new MockAgentRunner();
    const { repo, notifier, scheduler } = setup(runner, { recoverNotify: true });
    const task = createTask(repo);
    repo.claimNextQueued();

    await scheduler.start();
    await waitFor(() => repo.getTask(task.id)?.outcome === 'INTERRUPTED');

    expect(repo.getTask(task.id)?.status).toBe('SETTLED');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]?.outcome).toBe('INTERRUPTED');
  });
});
