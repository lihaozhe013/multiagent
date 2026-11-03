import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiBridgeAgentRunner } from './agent-runner.ts';
import { createTestConfig, createTestRepo } from './test-helpers.ts';

describe('Pi bridge agent runner', () => {
  let tempDir: string | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('kills a detached process group on timeout', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bridge-agent-timeout-'));
    const scriptPath = join(tempDir, 'slow-pi');
    writeFileSync(
      scriptPath,
      '#!/usr/bin/env bun\nawait Bun.sleep(60000);\n',
      { mode: 0o755 }
    );

    const repo = createTestRepo();
    const task = repo.createTask({
      prompt: 'Hang until timeout',
      resolvedCwd: tempDir,
      conversationId: 'conv-timeout',
      userId: 'user-timeout',
      agentId: 'pi'
    }).task;

    const config = createTestConfig({
      piBinary: scriptPath,
      taskTimeoutMs: 100,
      killGraceMs: 10,
      piExtension: join(tempDir, 'fake-extension.ts')
    });
    const runner = new PiBridgeAgentRunner(config);
    const start = Date.now();
    const result = await runner.run(task);

    expect(result.exitCode).toBe(124);
    expect(Date.now() - start).toBeLessThan(3000);
    repo.close();
  });

  it('spawns the configured binary, injects bridge env, and passes the extension', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bridge-agent-runner-'));
    const scriptPath = join(tempDir, 'fake-pi');
    const received: Record<string, unknown>[] = [];

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        received.push((await request.json()) as Record<string, unknown>);
        return Response.json({ status: 'delivered' });
      }
    });

    const scriptSource = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (!args.includes('--extension')) {
  console.error('missing --extension');
  process.exit(2);
}
if (!args.includes('--append-system-prompt')) {
  console.error('missing --append-system-prompt');
  process.exit(3);
}
const taskId = process.env.BRIDGE_TASK_ID;
const url = process.env.BRIDGE_DELIVERY_URL;
const token = process.env.BRIDGE_INTERNAL_TOKEN;
if (!taskId || !url || !token) {
  console.error('missing bridge env');
  process.exit(4);
}
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({
    task_id: taskId,
    status: 'COMPLETED',
    summary: 'fake pi completed',
    modified_files: ['fake.txt'],
    verification_passed: true
  })
});
if (!response.ok) process.exit(5);
console.log(JSON.stringify({ type: 'message', message: { content: 'fake pi done' } }));
process.exit(0);
`;
    writeFileSync(scriptPath, scriptSource, { mode: 0o755 });

    const repo = createTestRepo();
    const task = repo.createTask({
      prompt: 'Run the fake agent',
      resolvedCwd: tempDir,
      conversationId: 'conv-1',
      userId: 'user-1',
      agentId: 'pi'
    }).task;

    const config = createTestConfig({
      piBinary: scriptPath,
      internalPort: server.port ?? 0,
      internalToken: 'runner-internal-token',
      piExtension: join(tempDir, 'fake-extension.ts')
    });
    const runner = new PiBridgeAgentRunner(config);
    const result = await runner.run(task);

    expect(result.exitCode).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.task_id).toBe(task.id);
    expect(received[0]?.status).toBe('COMPLETED');

    repo.close();
  });
});
