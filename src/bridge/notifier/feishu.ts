import { createHmac } from 'node:crypto';
import type { NotificationEvent, Notifier } from '../types.ts';
import { formatNotificationText } from './format.ts';

const REQUEST_TIMEOUT_MS = 15000;

export interface FeishuTextPayload {
  timestamp?: string;
  sign?: string;
  msg_type: 'text';
  content: {
    text: string;
  };
}

export function buildFeishuSignature(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

export function buildFeishuPayload(
  text: string,
  secret?: string,
  timestamp: string = Math.floor(Date.now() / 1000).toString()
): FeishuTextPayload {
  const payload: FeishuTextPayload = {
    msg_type: 'text',
    content: { text }
  };
  if (secret) {
    payload.timestamp = timestamp;
    payload.sign = buildFeishuSignature(timestamp, secret);
  }
  return payload;
}

export class FeishuNotifier implements Notifier {
  public readonly channel = 'feishu';

  constructor(
    private readonly webhookUrl: string,
    private readonly secret?: string
  ) {}

  public async send(event: NotificationEvent): Promise<void> {
    const text = formatNotificationText(event);
    const payload = buildFeishuPayload(text, this.secret);

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const rawBody = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`Feishu webhook returned HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
    }

    if (rawBody.trim()) {
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>;
          const code = record.code ?? record.StatusCode;
          if (typeof code === 'number' && code !== 0) {
            throw new Error(`Feishu webhook returned code ${code}: ${rawBody.slice(0, 500)}`);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Feishu webhook returned code')) {
          throw error;
        }
        // Non-JSON responses are accepted when the HTTP status is successful.
      }
    }
  }
}
