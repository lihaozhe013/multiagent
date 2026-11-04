import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NotificationEvent } from './types.ts';
import { DingTalkNotifier, buildDingtalkSignature } from './notifier/dingtalk.ts';
import { GenericWebhookNotifier } from './notifier/generic.ts';

const event: NotificationEvent = {
  taskId: 'task-http-1',
  conversationId: 'conv-1',
  userId: 'user-1',
  outcome: 'COMPLETED',
  summary: 'HTTP notifier test',
  modifiedFiles: ['src/a.ts'],
  verificationPassed: true,
  durationMs: 1200,
  createdAt: new Date().toISOString()
};

describe('HTTP notifiers', () => {
  let server: ReturnType<typeof Bun.serve>;
  let received: Record<string, unknown>[] = [];

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        received.push(body);
        return Response.json({ code: 0, msg: 'success' });
      }
    });
  });

  afterAll(() => {
    server.stop();
  });

  it('sends a generic webhook envelope', async () => {
    received = [];
    const notifier = new GenericWebhookNotifier(
      `http://127.0.0.1:${server.port}/generic`,
      'generic-token'
    );
    await notifier.send(event);

    expect(received).toHaveLength(1);
    const body = received[0]!;
    expect(body.source).toBe('night-shift-bridge');
    expect(body.task_id).toBe('task-http-1');
    expect(body.outcome).toBe('COMPLETED');
    expect(body.verification_passed).toBe(true);
    expect(body.modified_files).toEqual(['src/a.ts']);
  });

  it('sends a DingTalk text payload with a signed URL', async () => {
    received = [];
    const requestedUrls: string[] = [];
    const notifier = new DingTalkNotifier(
      `http://127.0.0.1:${server.port}/dingtalk?access_token=token`,
      'dingtalk-secret'
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrls.push(String(input));
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await notifier.send(event);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrls).toHaveLength(1);
    const url = new URL(requestedUrls[0]!);
    const timestamp = url.searchParams.get('timestamp');
    const sign = url.searchParams.get('sign');
    expect(timestamp).toBeTruthy();
    expect(sign).toBe(buildDingtalkSignature(timestamp!, 'dingtalk-secret'));

    expect(received).toHaveLength(1);
    const body = received[0]!;
    expect(body.msgtype).toBe('text');
    const text = (body.text as { content?: string })?.content ?? '';
    expect(text).toContain('[Night-Shift] COMPLETED');
    expect(text).toContain('HTTP notifier test');
  });

  it('fails when DingTalk replies with a non-zero errcode', async () => {
    const failingServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => Response.json({ errcode: 310000, errmsg: 'keywords not in content' })
    });
    try {
      const notifier = new DingTalkNotifier(`http://127.0.0.1:${failingServer.port}/dingtalk`);
      await expect(async () => {
        await notifier.send(event);
      }).toThrow(/errcode 310000/);
    } finally {
      failingServer.stop();
    }
  });
});
