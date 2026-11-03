import type { NotificationEvent, Notifier } from '../types.ts';

const REQUEST_TIMEOUT_MS = 15000;

export class GenericWebhookNotifier implements Notifier {
  public readonly channel = 'generic';

  constructor(
    private readonly url: string,
    private readonly token?: string
  ) {}

  public async send(event: NotificationEvent): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'night-shift-bridge',
        event: 'task_result',
        task_id: event.taskId,
        conversation_id: event.conversationId,
        user_id: event.userId,
        outcome: event.outcome,
        summary: event.summary,
        modified_files: event.modifiedFiles,
        verification_passed: event.verificationPassed,
        notes: event.notes ?? null,
        exit_code: event.exitCode ?? null,
        log_tail: event.logTail ?? null,
        duration_ms: event.durationMs ?? null,
        created_at: event.createdAt
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Generic webhook returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
  }
}
