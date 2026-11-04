import { describe, expect, it } from 'bun:test';
import type { NotificationEvent } from './types.ts';
import {
  buildDingtalkPayload,
  buildDingtalkSignature,
  buildDingtalkWebhookUrl
} from './notifier/dingtalk.ts';
import {
  formatDuration,
  formatNotificationText,
  truncateLogTail,
  truncateText
} from './notifier/format.ts';

const event: NotificationEvent = {
  taskId: 'task-1',
  conversationId: 'conv-1',
  userId: 'user-1',
  outcome: 'COMPLETED',
  summary: 'Implemented the task.',
  modifiedFiles: ['src/a.ts', 'src/b.ts'],
  verificationPassed: true,
  notes: 'No extra configuration required.',
  durationMs: 65000,
  createdAt: new Date().toISOString()
};

describe('notification formatting', () => {
  it('formats a completed event', () => {
    const text = formatNotificationText(event);
    expect(text).toContain('[Night-Shift] COMPLETED');
    expect(text).toContain('Task: task-1');
    expect(text).toContain('Duration: 1m 5s');
    expect(text).toContain('- src/a.ts');
    expect(text).toContain('Verification: PASSED');
    expect(text).toContain('No extra configuration required.');
  });

  it('formats fallback events with exit code and log tail', () => {
    const text = formatNotificationText({
      ...event,
      outcome: 'FAILED',
      verificationPassed: null,
      exitCode: 1,
      logTail: 'line 1\nline 2'
    });
    expect(text).toContain('Verification: UNKNOWN');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('Log tail:');
    expect(text).toContain('line 2');
  });

  it('truncates long output', () => {
    const text = truncateText('x'.repeat(2000), 100);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(160);
    expect(text).toContain('...[truncated]');

    const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n');
    const tail = truncateLogTail(lines);
    expect(tail.split('\n').length).toBeLessThanOrEqual(50);
    expect(tail).toContain('line-99');
    expect(tail).not.toContain('line-0\n');
  });

  it('formats durations', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(65000)).toBe('1m 5s');
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });
});

describe('dingtalk payload', () => {
  it('builds a deterministic signature', () => {
    // base64(HMAC-SHA256(key = 'secret', data = '1700000000\nsecret'))
    expect(buildDingtalkSignature('1700000000', 'secret')).toBe(
      'vli3/GfD4kJTUyxxBD82mmmq4rnrfhhcCjvn2rP9x7o='
    );
  });

  it('appends timestamp and sign query parameters to the webhook URL', () => {
    const url = buildDingtalkWebhookUrl(
      'https://oapi.dingtalk.com/robot/send?access_token=token',
      'secret',
      '1700000000'
    );
    expect(url).toBe(
      'https://oapi.dingtalk.com/robot/send?access_token=token&timestamp=1700000000&sign=vli3%2FGfD4kJTUyxxBD82mmmq4rnrfhhcCjvn2rP9x7o%3D'
    );
  });

  it('returns the webhook URL unchanged when no secret is configured', () => {
    const url = buildDingtalkWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=token');
    expect(url).toBe('https://oapi.dingtalk.com/robot/send?access_token=token');
  });

  it('builds a text payload', () => {
    const payload = buildDingtalkPayload('hello');
    expect(payload.msgtype).toBe('text');
    expect(payload.text.content).toBe('hello');
  });
});
