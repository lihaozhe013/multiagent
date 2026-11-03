import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { NotificationEvent } from './types.ts';
import { FeishuNotifier, buildFeishuSignature } from './notifier/feishu.ts';
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

  it('sends a Feishu text payload with a signature', async () => {
    received = [];
    const notifier = new FeishuNotifier(
      `http://127.0.0.1:${server.port}/feishu`,
      'feishu-secret'
    );
    await notifier.send(event);

    expect(received).toHaveLength(1);
    const body = received[0]!;
    expect(body.msg_type).toBe('text');
    expect(body.timestamp).toBeTypeOf('string');
    expect(body.sign).toBe(buildFeishuSignature(String(body.timestamp), 'feishu-secret'));

    const content = body.content as { text?: string };
    expect(content.text).toContain('[Night-Shift] COMPLETED');
    expect(content.text).toContain('HTTP notifier test');
  });
});
