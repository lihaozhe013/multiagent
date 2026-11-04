import { createHmac } from 'node:crypto';
import type { NotificationEvent, Notifier } from '../types.ts';
import { formatNotificationText } from './format.ts';

const REQUEST_TIMEOUT_MS = 15000;

export interface DingTalkTextPayload {
  msgtype: 'text';
  text: {
    content: string;
  };
}

/**
 * DingTalk custom robot signature (security setting "加签").
 *
 * sign = base64(HMAC-SHA256(key = secret, message = `${timestamp}\n${secret}`)).
 * The timestamp is in milliseconds and the URL-encoded signature is appended
 * to the webhook URL as query parameters, unlike Feishu which carries them in
 * the JSON body.
 */
export function buildDingtalkSignature(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', secret).update(stringToSign).digest('base64');
}

export function buildDingtalkWebhookUrl(
  webhookUrl: string,
  secret?: string,
  timestamp: string = Date.now().toString()
): string {
  if (!secret) return webhookUrl;
  const sign = encodeURIComponent(buildDingtalkSignature(timestamp, secret));
  const joiner = webhookUrl.includes('?') ? '&' : '?';
  return `${webhookUrl}${joiner}timestamp=${timestamp}&sign=${sign}`;
}

export function buildDingtalkPayload(text: string): DingTalkTextPayload {
  return {
    msgtype: 'text',
    text: { content: text }
  };
}

export class DingTalkNotifier implements Notifier {
  public readonly channel = 'dingtalk';

  constructor(
    private readonly webhookUrl: string,
    private readonly secret?: string
  ) {}

  public async send(event: NotificationEvent): Promise<void> {
    const text = formatNotificationText(event);
    const payload = buildDingtalkPayload(text);
    const url = buildDingtalkWebhookUrl(this.webhookUrl, this.secret);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const rawBody = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`DingTalk webhook returned HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
    }

    if (rawBody.trim()) {
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>;
          const errcode = record.errcode;
          // DingTalk replies with HTTP 200 and errcode 0 on success. A non-zero
          // errcode means keyword mismatch, bad signature, rate limiting, etc.
          if (typeof errcode === 'number' && errcode !== 0) {
            throw new Error(`DingTalk webhook returned errcode ${errcode}: ${rawBody.slice(0, 500)}`);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('DingTalk webhook returned errcode')) {
          throw error;
        }
        // Non-JSON responses are accepted when the HTTP status is successful.
      }
    }
  }
}
