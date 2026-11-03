import type { BridgeRepository } from './db/queries.ts';
import type {
  BridgeOutcome,
  BridgeTask,
  DeliveryPayload,
  DeliveryResult
} from './types.ts';
import type { NotificationDispatcher } from './notifier/index.ts';
import { truncateLogTail, truncateText } from './notifier/format.ts';

export interface FallbackInput {
  summary: string;
  modifiedFiles?: string[];
  notes?: string;
  exitCode?: number;
  logTail?: string;
}

export class DeliveryService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly dispatcher: NotificationDispatcher
  ) {}

  public async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const task = this.repo.getTask(payload.task_id);
    if (!task) {
      return { status: 'task_not_found' };
    }

    if (task.status !== 'RUNNING') {
      return task.reported
        ? { status: 'already_delivered', task }
        : { status: 'task_not_running', task };
    }

    const settled = this.repo.settleTask(task.id, {
      outcome: payload.status,
      reported: true,
      summary: payload.summary,
      modifiedFiles: payload.modified_files,
      verificationPassed: payload.verification_passed,
      notes: payload.notes ?? null,
      exitCode: null,
      logTail: null
    });

    if (!settled) {
      const latest = this.repo.getTask(task.id);
      if (latest?.reported) {
        return { status: 'already_delivered', task: latest };
      }
      return latest
        ? { status: 'task_not_running', task: latest }
        : { status: 'task_not_found' };
    }

    await this.dispatcher.dispatch(settled);
    return { status: 'delivered', task: settled };
  }

  public async fallback(
    task: BridgeTask,
    outcome: BridgeOutcome,
    input: FallbackInput,
    options: { notify?: boolean } = {}
  ): Promise<BridgeTask | null> {
    const settled = this.repo.settleTask(task.id, {
      outcome,
      reported: false,
      summary: truncateText(input.summary, 4 * 1024),
      modifiedFiles: input.modifiedFiles ?? [],
      verificationPassed: null,
      notes: input.notes ?? null,
      exitCode: input.exitCode ?? null,
      logTail: input.logTail ? truncateLogTail(input.logTail) : null
    });

    if (!settled) return null;

    if (options.notify === false) {
      this.repo.addEvent(settled.id, 'notification_skipped', { reason: 'shutdown' });
      return settled;
    }

    await this.dispatcher.dispatch(settled);
    return settled;
  }
}
