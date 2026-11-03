import { describe, it, expect, beforeEach } from 'bun:test';
import { StorageEngine } from '../core/store.ts';
import { QueueController } from '../core/queue.ts';
import { Orchestrator } from '../core/orchestrator.ts';
import { TaskDecomposer } from '../manager/decomposer.ts';
import { createApiRouter } from './routes.ts';

describe('TaskDecomposer and Hono API Routes', () => {
  let storage: StorageEngine;
  let queue: QueueController;
  let orchestrator: Orchestrator;
  let decomposer: TaskDecomposer;
  let app: ReturnType<typeof createApiRouter>;

  beforeEach(() => {
    storage = new StorageEngine(':memory:');
    queue = new QueueController(storage);
    orchestrator = new Orchestrator(queue);
    decomposer = new TaskDecomposer(queue);
    app = createApiRouter({ queue, orchestrator, decomposer });
  });

  it('TaskDecomposer accurately parses markdown checklists and headers', () => {
    const markdown = `
# Nightly Sprint Backlog
- [ ] Refactor user auth module: Clean up tokens (verify: bun test; npm run lint)
- Add dark mode CSS [agent: opencode] (test: bun test:ui)
  Here are extra details about dark mode.
## 3. Export PDF reports
  Implement pdf export endpoint.
    `;

    const items = decomposer.parseMarkdownBacklog(markdown, '/tmp');
    expect(items.length).toBe(3);

    expect(items[0]?.title).toBe('Refactor user auth module: Clean up tokens');
    expect(items[0]?.verify_commands).toEqual(['bun test', 'npm run lint']);
    expect(items[0]?.agent_id).toBe('pi');

    expect(items[1]?.title).toBe('Add dark mode CSS');
    expect(items[1]?.agent_id).toBe('opencode');
    expect(items[1]?.verify_commands).toEqual(['bun test:ui']);
    expect(items[1]?.description).toContain('Here are extra details');

    expect(items[2]?.title).toBe('3. Export PDF reports');
    expect(items[2]?.description).toContain('Implement pdf export endpoint.');
  });

  it('GET /health returns status ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('POST /tasks and GET /tasks create and fetch tasks', async () => {
    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'API Created Task',
        description: 'Details',
        cwd: '/tmp',
        verify_commands: ['echo 1'],
      }),
    });

    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { task: { id: number } };
    expect(createBody.task.id).toBe(1);

    const listRes = await app.request('/tasks');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { tasks: Array<{ title: string }> };
    expect(listBody.tasks.length).toBe(1);
    expect(listBody.tasks[0]?.title).toBe('API Created Task');
  });

  it('POST /batch enqueues a decomposed batch', async () => {
    const batchRes = await app.request('/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawInput: `- [ ] Task A\n- [ ] Task B (test: bun test)`,
        cwd: '/tmp',
      }),
    });

    expect(batchRes.status).toBe(201);
    const batchBody = (await batchRes.json()) as { createdCount: number };
    expect(batchBody.createdCount).toBe(2);

    const listRes = await app.request('/tasks');
    const listBody = (await listRes.json()) as { tasks: Array<{ title: string }> };
    expect(listBody.tasks.length).toBe(2);
  });

  it('POST /queue/control toggles queue state', async () => {
    const pauseRes = await app.request('/queue/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause', reason: 'Testing pause' }),
    });

    expect(pauseRes.status).toBe(200);
    const pauseBody = (await pauseRes.json()) as { state: { state: string; paused_reason: string } };
    expect(pauseBody.state.state).toBe('PAUSED');
    expect(pauseBody.state.paused_reason).toBe('Testing pause');
  });
});
