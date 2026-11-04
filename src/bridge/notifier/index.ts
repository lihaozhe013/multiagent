import type { BridgeConfig } from '../config.ts';
import type { BridgeRepository } from '../db/queries.ts';
import type { BridgeTask, NotificationStatus, Notifier } from '../types.ts';
import { errorMessage, logError, logInfo, logWarn } from '../logging.ts';
import { taskToNotificationEvent } from './format.ts';
import { DingTalkNotifier } from './dingtalk.ts';
import { GenericWebhookNotifier } from './generic.ts';

export { DingTalkNotifier, GenericWebhookNotifier };
export { formatNotificationText, taskToNotificationEvent } from './format.ts';

const MAX_NOTIFICATION_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createNotifiers(config: BridgeConfig): Notifier[] {
  const notifiers: Notifier[] = [];

  for (const channel of config.notifiers) {
    if (channel === 'dingtalk') {
      if (!config.dingtalkWebhookUrl) {
        throw new Error('DINGTALK_WEBHOOK_URL is required when the dingtalk notifier is enabled');
      }
      notifiers.push(new DingTalkNotifier(config.dingtalkWebhookUrl, config.dingtalkWebhookSecret));
    } else if (channel === 'generic') {
      if (!config.genericWebhookUrl) {
        throw new Error('Generic notifier requires GENERIC_WEBHOOK_URL');
      }
      notifiers.push(new GenericWebhookNotifier(config.genericWebhookUrl, config.genericWebhookToken));
    }
  }

  return notifiers;
}

export class NotificationDispatcher {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly notifiers: Notifier[],
    private readonly retryDelaysMs: number[]
  ) {}

  public async dispatch(task: BridgeTask, options: { force?: boolean } = {}): Promise<NotificationStatus> {
    const latest = this.repo.getTask(task.id) ?? task;
    if (!options.force && latest.notificationStatus === 'SENT') {
      return 'SENT';
    }

    const event = taskToNotificationEvent(latest);
    let anySuccess = false;

    for (const notifier of this.notifiers) {
      let success = false;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_NOTIFICATION_ATTEMPTS; attempt += 1) {
        try {
          await notifier.send(event);
          success = true;
          anySuccess = true;
          this.repo.upsertNotification({
            taskId: latest.id,
            channel: notifier.channel,
            status: 'SENT',
            attempts: attempt
          });
          logInfo('notification sent', {
            taskId: latest.id,
            channel: notifier.channel,
            attempt
          });
          break;
        } catch (error) {
          lastError = errorMessage(error);
          logWarn('notification attempt failed', {
            taskId: latest.id,
            channel: notifier.channel,
            attempt,
            error: lastError
          });

          if (attempt < MAX_NOTIFICATION_ATTEMPTS) {
            const delay = this.retryDelaysMs[attempt - 1] ?? 1000;
            await sleep(delay);
          }
        }
      }

      if (!success) {
        this.repo.upsertNotification({
          taskId: latest.id,
          channel: notifier.channel,
          status: 'FAILED',
          attempts: MAX_NOTIFICATION_ATTEMPTS,
          lastError
        });
      }
    }

    const aggregate: NotificationStatus = anySuccess ? 'SENT' : 'FAILED';
    this.repo.setNotificationStatus(latest.id, aggregate);
    this.repo.addEvent(latest.id, aggregate === 'SENT' ? 'notification_sent' : 'notification_failed', {
      channels: this.notifiers.map((notifier) => notifier.channel)
    });

    if (aggregate === 'FAILED') {
      logError('all notification channels failed', { taskId: latest.id });
    }

    return aggregate;
  }
}
