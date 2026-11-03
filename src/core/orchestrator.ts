import type { Task, PipelineStage, AgentEvent } from '../types/index.ts';
import { QueueController } from './queue.ts';
import { PipelineRunner } from './pipeline.ts';
import { AgentRegistry, defaultAgentRegistry } from '../adapters/registry.ts';

export class Orchestrator {
  private queue: QueueController;
  private pipeline: PipelineRunner;
  private isRunning = false;
  private shouldStop = false;
  private loopPromise: Promise<void> | null = null;
  private wakeSignal: (() => void) | null = null;

  constructor(queue: QueueController, registry: AgentRegistry = defaultAgentRegistry) {
    this.queue = queue;
    this.pipeline = new PipelineRunner(queue, registry);
  }

  public getPipeline(): PipelineRunner {
    return this.pipeline;
  }

  public onEvent(listener: (event: AgentEvent & { taskId: number; stage: PipelineStage }) => void): () => void {
    return this.pipeline.addEventListener(listener);
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Recover any task left IN_PROGRESS from previous crashed session
    this.queue.recoverInterrupted();

    this.isRunning = true;
    this.shouldStop = false;
    this.queue.setQueueState('RUNNING');

    this.loopPromise = this.runLoop();
  }

  public pause(reason: string = 'Paused by user'): void {
    this.queue.setQueueState('PAUSED', reason);
  }

  public resume(): void {
    this.queue.setQueueState('RUNNING');
    this.wake();
  }

  public stop(): void {
    this.shouldStop = true;
    this.wake();
  }

  public wake(): void {
    if (this.wakeSignal) {
      this.wakeSignal();
      this.wakeSignal = null;
    }
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.shouldStop) {
        const qState = this.queue.getQueueState();
        if (qState.state === 'PAUSED') {
          await this.waitForWake(2000);
          continue;
        }

        let claimResult: { task: Task; token: string } | null = null;
        try {
          claimResult = this.queue.claimNext();
        } catch (err) {
          console.error('Error claiming next task:', err);
          await this.waitForWake(3000);
          continue;
        }

        if (!claimResult) {
          // No pending tasks available, wait for wake or poll
          await this.waitForWake(5000);
          continue;
        }

        const { task, token } = claimResult;
        try {
          await this.pipeline.runTask(task, token);
        } catch (err) {
          console.error(`Unexpected pipeline error on task ${task.id}:`, err);
          try {
            this.queue.settle(task.id, token, {
              status: 'FAILED',
              result_summary: `Internal pipeline crash: ${err instanceof Error ? err.message : String(err)}`,
            });
          } catch {
            // Ignore if already settled
          }
        }
      }
    } finally {
      this.isRunning = false;
      this.queue.setQueueState('IDLE');
    }
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
