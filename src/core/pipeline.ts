import type { Task, PipelineStage, AgentEvent } from '../types/index.ts';
import { QueueController } from './queue.ts';
import { AgentRegistry, defaultAgentRegistry } from '../adapters/registry.ts';
import { runVerificationCommands } from './gate.ts';
import { getGitDiff, commitChanges, isGitRepo } from './git.ts';

export interface PipelineEventListener {
  (event: AgentEvent & { taskId: number; stage: PipelineStage }): void;
}

export class PipelineRunner {
  private queue: QueueController;
  private registry: AgentRegistry;
  private listeners: PipelineEventListener[] = [];

  constructor(queue: QueueController, registry: AgentRegistry = defaultAgentRegistry) {
    this.queue = queue;
    this.registry = registry;
  }

  public addEventListener(listener: PipelineEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: AgentEvent, taskId: number, stage: PipelineStage): void {
    const payload = { ...event, taskId, stage };
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch (err) {
        console.error('Error in pipeline event listener:', err);
      }
    }
  }

  public async runTask(initialTask: Task, token: string): Promise<Task> {
    let task = initialTask;

    while (task.retry_count <= task.max_retries) {
      const attemptNumber = task.retry_count + 1;
      const startedAt = new Date().toISOString();

      // ==========================================
      // Stage 1: CODER
      // ==========================================
      this.queue.updateStage(task.id, token, 'CODER');
      this.emit({
        type: 'stdout',
        timestamp: Date.now(),
        content: `=== Starting Stage: CODER (Attempt ${attemptNumber}/${task.max_retries + 1}) ===`,
      }, task.id, 'CODER');

      let coderPrompt = task.description;
      if (task.retry_count > 0 && task.error_tail) {
        coderPrompt = `PREVIOUS ATTEMPT FAILED. Please review the errors/feedback and correct the code:\n\n` +
          `FEEDBACK:\n${task.error_tail}\n\n` +
          `ORIGINAL TASK SPECIFICATION:\n${task.description}`;
      }

      const adapter = this.registry.getOrThrow(task.agent_id);
      const coderResult = await adapter.execute(
        {
          taskId: task.id,
          runId: attemptNumber * 100 + 1,
          stage: 'CODER',
          title: task.title,
          prompt: coderPrompt,
          cwd: task.cwd,
        },
        (event) => this.emit(event, task.id, 'CODER')
      );

      this.queue.recordRun({
        taskId: task.id,
        attempt: attemptNumber,
        stage: 'CODER',
        agentId: task.agent_id,
        status: coderResult.exitCode === 0 ? 'SUCCESS' : 'FAILED',
        logTail: coderResult.rawTail,
        startedAt,
        finishedAt: new Date().toISOString(),
      });

      if (coderResult.exitCode !== 0) {
        const errorFeedback = `Coder agent exited with code ${coderResult.exitCode}:\n${coderResult.summary}\n${coderResult.rawTail.slice(-2000)}`;
        if (task.retry_count < task.max_retries) {
          this.queue.incrementRetry(task.id, token, errorFeedback);
          task = this.queue.getTask(task.id)!;
          continue; // Loop back to Coder stage
        } else {
          return this.queue.settle(task.id, token, {
            status: 'FAILED',
            result_summary: `Coder process failed with exit code ${coderResult.exitCode}`,
            error_tail: coderResult.rawTail,
          });
        }
      }

      // ==========================================
      // Stage 2: TEST GATE
      // ==========================================
      if (task.verify_commands.length > 0) {
        this.queue.updateStage(task.id, token, 'TEST');
        this.emit({
          type: 'stdout',
          timestamp: Date.now(),
          content: `=== Starting Stage: TEST GATE (${task.verify_commands.length} commands) ===`,
        }, task.id, 'TEST');

        const testStartTime = new Date().toISOString();
        const testResult = await runVerificationCommands(task.verify_commands, task.cwd);

        this.queue.recordRun({
          taskId: task.id,
          attempt: attemptNumber,
          stage: 'TEST',
          agentId: 'gate',
          status: testResult.passed ? 'SUCCESS' : 'FAILED',
          logTail: testResult.outputTail,
          feedback: testResult.passed ? undefined : `Failed on: ${testResult.failingCommand}`,
          startedAt: testStartTime,
          finishedAt: new Date().toISOString(),
        });

        if (!testResult.passed) {
          const testFeedback = `Verification command failed on '${testResult.failingCommand}' (exit ${testResult.exitCode}):\n${testResult.outputTail.slice(-2000)}`;
          this.emit({
            type: 'error',
            timestamp: Date.now(),
            content: testFeedback,
          }, task.id, 'TEST');

          if (task.retry_count < task.max_retries) {
            this.queue.incrementRetry(task.id, token, testFeedback);
            task = this.queue.getTask(task.id)!;
            continue; // Loop back to Coder stage
          } else {
            return this.queue.settle(task.id, token, {
              status: 'BLOCKED',
              result_summary: `Verification failed on: ${testResult.failingCommand}`,
              error_tail: testResult.outputTail,
            });
          }
        }
      }

      // ==========================================
      // Stage 3: REVIEW AGENT
      // ==========================================
      const isGit = await isGitRepo(task.cwd);
      if (isGit) {
        this.queue.updateStage(task.id, token, 'REVIEW');
        this.emit({
          type: 'stdout',
          timestamp: Date.now(),
          content: '=== Starting Stage: REVIEW AGENT ===',
        }, task.id, 'REVIEW');

        const diff = await getGitDiff(task.cwd);
        if (diff.trim().length > 0) {
          const reviewStartTime = new Date().toISOString();
          const reviewPrompt = `You are a senior code reviewer acting as a quality gate.\n\n` +
            `TASK TITLE: ${task.title}\n` +
            `TASK REQUIREMENTS:\n${task.description}\n\n` +
            `GIT DIFF TO REVIEW:\n\`\`\`diff\n${diff.slice(0, 30000)}\n\`\`\`\n\n` +
            `Evaluate the changes for correctness, potential regressions, and adherence to requirements.\n` +
            `CONCLUDE YOUR FINAL OUTPUT WITH EXACTLY ONE VERDICT ON ITS OWN LINE:\n` +
            `VERDICT: APPROVE\n` +
            `or\n` +
            `VERDICT: REJECT - <Detailed, actionable feedback explaining what needs to be fixed>`;

          const reviewResult = await adapter.execute(
            {
              taskId: task.id,
              runId: attemptNumber * 100 + 2,
              stage: 'REVIEW',
              title: `Review: ${task.title}`,
              prompt: reviewPrompt,
              cwd: task.cwd,
              appendSystemPrompt: 'You are an automated reviewer. Inspect the git diff and provide a final verdict.',
            },
            (event) => this.emit(event, task.id, 'REVIEW')
          );

          const isRejected = reviewResult.rawTail.includes('VERDICT: REJECT');
          const rejectReason = isRejected
            ? reviewResult.rawTail.slice(reviewResult.rawTail.indexOf('VERDICT: REJECT')).split('\n')[0]
            : undefined;

          this.queue.recordRun({
            taskId: task.id,
            attempt: attemptNumber,
            stage: 'REVIEW',
            agentId: task.agent_id,
            status: isRejected ? 'REJECTED' : 'SUCCESS',
            logTail: reviewResult.rawTail,
            feedback: rejectReason,
            startedAt: reviewStartTime,
            finishedAt: new Date().toISOString(),
          });

          if (isRejected) {
            const feedback = rejectReason ?? 'Review agent rejected the code changes.';
            this.emit({
              type: 'error',
              timestamp: Date.now(),
              content: feedback,
            }, task.id, 'REVIEW');

            if (task.retry_count < task.max_retries) {
              this.queue.incrementRetry(task.id, token, feedback);
              task = this.queue.getTask(task.id)!;
              continue; // Loop back to Coder stage
            } else {
              return this.queue.settle(task.id, token, {
                status: 'BLOCKED',
                result_summary: 'Review agent rejected changes and max retries exceeded',
                error_tail: feedback,
              });
            }
          }
        }
      }

      // ==========================================
      // All passed! Auto commit & settle DONE
      // ==========================================
      if (isGit) {
        await commitChanges(task.cwd, `feat(task-${task.id}): ${task.title}`);
      }

      const settled = this.queue.settle(task.id, token, {
        status: 'DONE',
        result_summary: `Task completed successfully on attempt ${attemptNumber}`,
      });

      this.emit({
        type: 'stdout',
        timestamp: Date.now(),
        content: `=== Task ${task.id} Succeeded and Settled as DONE! ===`,
      }, task.id, 'IDLE');

      return settled;
    }

    return this.queue.settle(task.id, token, {
      status: 'FAILED',
      result_summary: 'Max retry limit reached',
      error_tail: task.error_tail ?? undefined,
    });
  }
}
