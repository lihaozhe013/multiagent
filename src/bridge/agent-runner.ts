import { PiAdapter } from '../adapters/pi.ts';
import type { BridgeConfig } from './config.ts';
import type { AgentRunnerLike, AgentRunOutcome, BridgeTask } from './types.ts';

function buildTaskTitle(task: BridgeTask): string {
  const firstLine = task.prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const title = firstLine || `Bridge task ${task.id.slice(0, 8)}`;
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

export class PiBridgeAgentRunner implements AgentRunnerLike {
  private readonly adapter: PiAdapter;
  private readonly activeRuns = new Map<string, number>();
  private nextRunId = 1;

  constructor(private readonly config: BridgeConfig) {
    this.adapter = new PiAdapter(config.piBinary);
  }

  public async run(task: BridgeTask): Promise<AgentRunOutcome> {
    const runId = this.nextRunId;
    this.nextRunId += 1;
    this.activeRuns.set(task.id, runId);

    const internalHost = this.config.internalHost === '0.0.0.0' ? '127.0.0.1' : this.config.internalHost;
    const deliveryUrl = `http://${internalHost}:${this.config.internalPort}/internal/delivery`;

    try {
      return await this.adapter.execute({
        taskId: runId,
        runId,
        stage: 'AGENT',
        title: buildTaskTitle(task),
        prompt: task.prompt,
        cwd: task.resolvedCwd,
        timeoutMs: this.config.taskTimeoutMs,
        killGraceMs: this.config.killGraceMs,
        detached: true,
        appendSystemPrompt: this.config.systemPrompt,
        extensions: [this.config.piExtension],
        ...(this.config.piModel ? { model: this.config.piModel } : {}),
        env: {
          BRIDGE_TASK_ID: task.id,
          BRIDGE_DELIVERY_URL: deliveryUrl,
          BRIDGE_INTERNAL_TOKEN: this.config.internalToken,
          BRIDGE_CONVERSATION_ID: task.conversationId,
          BRIDGE_USER_ID: task.userId
        }
      });
    } finally {
      this.activeRuns.delete(task.id);
    }
  }

  public async abort(taskId: string): Promise<void> {
    const runId = this.activeRuns.get(taskId);
    if (runId === undefined) return;
    await this.adapter.abort(runId);
  }

  public async abortAll(): Promise<void> {
    const runIds = [...new Set(this.activeRuns.values())];
    await Promise.allSettled(
      runIds.map(async (runId) => {
        await this.adapter.abort(runId);
      })
    );
  }
}
