import { describe, expect, it } from 'bun:test';
import type { NotificationEvent } from './types.ts';
import {
  buildFeishuPayload,
  buildFeishuSignature
} from './notifier/feishu.ts';
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

describe('feishu payload', () => {
  it('builds a deterministic signature', () => {
    expect(buildFeishuSignature('1700000000', 'secret')).toBe(
      'fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA='
    );
  });

  it('includes signature fields when a secret is configured', () => {
    const payload = buildFeishuPayload('hello', 'secret', '1700000000');
    expect(payload.msg_type).toBe('text');
    expect(payload.content.text).toBe('hello');
    expect(payload.timestamp).toBe('1700000000');
    expect(payload.sign).toBe('fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=');
  });

  it('omits signature fields when no secret is configured', () => {
    const payload = buildFeishuPayload('hello');
    expect(payload.timestamp).toBeUndefined();
    expect(payload.sign).toBeUndefined();
  });
});
