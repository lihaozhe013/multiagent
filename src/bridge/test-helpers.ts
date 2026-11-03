import type { BridgeConfig } from './config.ts';
import { openBridgeDatabase } from './db/schema.ts';
import { BridgeRepository } from './db/queries.ts';
import type { AgentRunnerLike, AgentRunOutcome, BridgeTask, NotificationEvent, Notifier } from './types.ts';

export function createTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    internalPort: 0,
    internalHost: '127.0.0.1',
    workspaceBase: process.cwd(),
    triggerToken: 'test-trigger-token',
    internalToken: 'test-internal-token',
    dbPath: ':memory:',
    taskTimeoutMs: 1000,
    killGraceMs: 10,
    maxConcurrency: 1,
    maxQueueDepth: 10,
    dedupeWindowMs: 0,
    shutdownGraceMs: 100,
    notifyOnShutdown: false,
    recoverNotify: false,
    retentionDays: 0,
    agentId: 'pi',
    piBinary: 'pi',
    piExtension: '/tmp/delivery.ts',
    systemPrompt: 'Test system prompt',
    notifiers: ['generic'],
    genericWebhookUrl: 'http://127.0.0.1:1/hook',
    notifyRetryDelaysMs: [0, 0],
    ...overrides
  };
}

export function createTestRepo(dedupeWindowMs = 0): BridgeRepository {
  return new BridgeRepository(openBridgeDatabase(':memory:'), { dedupeWindowMs });
}

export class MockNotifier implements Notifier {
  public readonly channel: string;
  public readonly events: NotificationEvent[] = [];
  public failTimes = 0;

  constructor(channel = 'mock') {
    this.channel = channel;
  }

  public async send(event: NotificationEvent): Promise<void> {
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('mock notifier failure');
    }
    this.events.push(event);
  }
}

export class MockAgentRunner implements AgentRunnerLike {
  public readonly runCalls: BridgeTask[] = [];
  public readonly aborted: string[] = [];

  constructor(
    private readonly result: AgentRunOutcome = {
      exitCode: 0,
      summary: 'Mock agent completed',
      rawTail: '',
      durationMs: 1
    }
  ) {}

  public async run(task: BridgeTask): Promise<AgentRunOutcome> {
    this.runCalls.push(task);
    return this.result;
  }

  public async abort(taskId: string): Promise<void> {
    this.aborted.push(taskId);
  }

  public async abortAll(): Promise<void> {
    this.aborted.push('all');
  }
}

export function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for condition'));
      }
    }, intervalMs);
  });
}
