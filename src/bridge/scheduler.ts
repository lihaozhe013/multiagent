import type { BridgeConfig } from './config.ts';
import type { BridgeRepository } from './db/queries.ts';
import type { DeliveryService } from './delivery.ts';
import type { NotificationDispatcher } from './notifier/index.ts';
import type { AgentRunnerLike, AgentRunOutcome, BridgeTask } from './types.ts';
import { errorMessage, logError, logInfo, logWarn } from './logging.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BridgeScheduler {
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private wakeSignal: (() => void) | null = null;
  private readonly activePromises = new Set<Promise<void>>();
  private readonly activeTaskIds = new Set<string>();

  constructor(
    private readonly repo: BridgeRepository,
    private readonly config: BridgeConfig,
    private readonly runner: AgentRunnerLike,
    private readonly deliveryService: DeliveryService,
    private readonly dispatcher: NotificationDispatcher
  ) {}

  public async start(): Promise<void> {
    const interrupted = this.repo.markRunningInterrupted();
    for (const task of interrupted) {
      if (this.config.recoverNotify && !task.recoveryNotified) {
        try {
          await this.dispatcher.dispatch(task);
          this.repo.markRecoveryNotified(task.id);
        } catch (error) {
          logError('failed to notify recovered task', {
            taskId: task.id,
            error: errorMessage(error)
          });
        }
      }
    }

    const removed = this.repo.cleanupOldTasks(this.config.retentionDays);
    if (removed > 0) {
      logInfo('cleaned up old bridge tasks', { removed });
    }

    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  public wake(): void {
    if (this.wakeSignal) {
      this.wakeSignal();
      this.wakeSignal = null;
    }
  }

  public async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    this.wake();

    if (this.loopPromise) {
      await this.loopPromise;
    }

    const deadline = Date.now() + this.config.shutdownGraceMs;
    while (this.activePromises.size > 0 && Date.now() < deadline) {
      await sleep(50);
    }

    if (this.activePromises.size > 0) {
      logWarn('aborting active tasks during shutdown', {
        activeTasks: [...this.activeTaskIds]
      });
      await this.runner.abortAll();
      await Promise.allSettled(this.activePromises);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.activePromises.size >= this.config.maxConcurrency) {
        await this.waitForWake(250);
        continue;
      }

      const task = this.repo.claimNextQueued();
      if (!task) {
        await this.waitForWake(1000);
        continue;
      }

      this.activeTaskIds.add(task.id);
      let promise: Promise<void>;
      promise = this.executeTask(task)
        .catch(async (error: unknown) => {
          const message = errorMessage(error);
          logError('unexpected task execution error', {
            taskId: task.id,
            error: message
          });
          const latest = this.repo.getTask(task.id);
          if (latest?.status === 'RUNNING') {
            try {
              await this.deliveryService.fallback(latest, 'FAILED', {
                summary: `Internal bridge error: ${message}`
              });
            } catch (fallbackError) {
              logError('failed to settle task after internal error', {
                taskId: task.id,
                error: errorMessage(fallbackError)
              });
            }
          }
        })
        .finally(() => {
          this.activePromises.delete(promise);
          this.activeTaskIds.delete(task.id);
          this.wake();
        });
      this.activePromises.add(promise);
    }
  }

  private async executeTask(task: BridgeTask): Promise<void> {
    logInfo('agent task started', { taskId: task.id, cwd: task.resolvedCwd });

    let result: AgentRunOutcome;
    try {
      result = await this.runner.run(task);
    } catch (error) {
      const message = errorMessage(error);
      result = {
        exitCode: 1,
        summary: `Agent runner failed: ${message}`,
        rawTail: message,
        durationMs: 0,
        error: message
      };
    }

    const latest = this.repo.getTask(task.id);
    if (!latest || latest.status !== 'RUNNING') {
      logInfo('task already settled before fallback', { taskId: task.id });
      return;
    }

    if (this.stopping) {
      await this.deliveryService.fallback(
        latest,
        'INTERRUPTED',
        {
          summary: 'Bridge shut down while the task was running',
          exitCode: result.exitCode,
          logTail: result.rawTail
        },
        { notify: this.config.notifyOnShutdown }
      );
      return;
    }

    if (result.exitCode === 124) {
      await this.deliveryService.fallback(latest, 'TIMEOUT', {
        summary: `Task timed out after ${Math.round(this.config.taskTimeoutMs / 1000)}s`,
        exitCode: 124,
        logTail: result.rawTail
      });
      return;
    }

    const detail = result.error ?? result.summary;
    await this.deliveryService.fallback(latest, 'FAILED', {
      summary: `Agent exited with code ${result.exitCode} without calling deliver_result: ${detail}`,
      exitCode: result.exitCode,
      logTail: result.rawTail
    });
  }

  private waitForWake(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSignal = null;
        resolve();
      }, timeoutMs);

      this.wakeSignal = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
