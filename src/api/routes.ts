import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { QueueController } from '../core/queue.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import { TaskDecomposer } from '../manager/decomposer.ts';
import { TaskLockedError, TaskNotFoundError } from '../core/store.ts';
import type { AgentEvent, PipelineStage } from '../types/index.ts';

export interface AppContext {
  queue: QueueController;
  orchestrator: Orchestrator;
  decomposer: TaskDecomposer;
}

export function createApiRouter(ctx: AppContext): Hono {
  const app = new Hono();

  // Simple pub/sub for SSE subscribers
  type SseListener = (data: { event: string; payload: unknown }) => void;
  const sseListeners = new Set<SseListener>();

  const broadcast = (event: string, payload: unknown) => {
    for (const listener of sseListeners) {
      try {
        listener({ event, payload });
      } catch {
        // ignore client write errors
      }
    }
  };

  // Connect orchestrator pipeline events to SSE broadcast
  ctx.orchestrator.onEvent((event: AgentEvent & { taskId: number; stage: PipelineStage }) => {
    broadcast('agent_event', event);
    // Also notify queue state changes on pipeline stage shifts
    broadcast('queue_state', ctx.queue.getQueueState());
  });

  // Health check
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/tasks
  app.get('/tasks', (c) => {
    const status = c.req.query('status');
    const batchId = c.req.query('batch_id');
    const tasks = ctx.queue.listTasks({
      status: status || undefined,
      batch_id: batchId || undefined,
    });
    return c.json({ tasks });
  });

  // POST /api/tasks
  app.post('/tasks', async (c) => {
    const body = await c.req.json();
    if (!body.title || !body.cwd) {
      return c.json({ error: 'Title and cwd are required' }, 400);
    }

    const task = ctx.queue.createTask({
      title: String(body.title),
      description: String(body.description ?? ''),
      cwd: String(body.cwd),
      agent_id: body.agent_id ? String(body.agent_id) : 'pi',
      batch_id: body.batch_id ? String(body.batch_id) : undefined,
      verify_commands: Array.isArray(body.verify_commands) ? body.verify_commands.map(String) : [],
      max_retries: typeof body.max_retries === 'number' ? body.max_retries : 3,
    });

    broadcast('task_created', task);
    ctx.orchestrator.wake();
    return c.json({ task }, 201);
  });

  // GET /api/tasks/:id
  app.get('/tasks/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const task = ctx.queue.getTask(id);
    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }
    const runs = ctx.queue.listRuns(id);
    return c.json({ task, runs });
  });

  // PATCH /api/tasks/:id
  app.patch('/tasks/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json();

    try {
      const task = ctx.queue.updateTask(id, body);
      broadcast('task_updated', task);
      return c.json({ task });
    } catch (err) {
      if (err instanceof TaskLockedError) {
        return c.json({ error: err.message, code: 'task_locked' }, 409);
      }
      if (err instanceof TaskNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: String(err) }, 500);
    }
  });

  // DELETE /api/tasks/:id
  app.delete('/tasks/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    try {
      const deleted = ctx.queue.deleteTask(id);
      broadcast('task_deleted', { id });
      return c.json({ ok: deleted });
    } catch (err) {
      if (err instanceof TaskLockedError) {
        return c.json({ error: err.message, code: 'task_locked' }, 409);
      }
      if (err instanceof TaskNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: String(err) }, 500);
    }
  });

  // POST /api/tasks/:id/retry
  app.post('/tasks/:id/retry', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    try {
      const task = ctx.queue.retryTask(id);
      broadcast('task_updated', task);
      ctx.orchestrator.wake();
      return c.json({ task });
    } catch (err) {
      if (err instanceof TaskLockedError) {
        return c.json({ error: err.message, code: 'task_locked' }, 409);
      }
      if (err instanceof TaskNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: String(err) }, 500);
    }
  });

  // POST /api/tasks/reorder
  app.post('/tasks/reorder', async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body.orderedIds)) {
      return c.json({ error: 'orderedIds array required' }, 400);
    }
    ctx.queue.reorderPending(body.orderedIds);
    broadcast('queue_reordered', { orderedIds: body.orderedIds });
    return c.json({ ok: true });
  });

  // GET /api/queue
  app.get('/queue', (c) => {
    const state = ctx.queue.getQueueState();
    let activeTask = null;
    if (state.active_task_id) {
      activeTask = ctx.queue.getTask(state.active_task_id);
    }
    return c.json({ state, activeTask });
  });

  // POST /api/queue/control
  app.post('/queue/control', async (c) => {
    const body = await c.req.json();
    const action = String(body.action);

    switch (action) {
      case 'start':
        await ctx.orchestrator.start();
        break;
      case 'pause':
        ctx.orchestrator.pause(body.reason ? String(body.reason) : undefined);
        break;
      case 'resume':
        ctx.orchestrator.resume();
        break;
      case 'stop':
        ctx.orchestrator.stop();
        break;
      default:
        return c.json({ error: `Unknown control action: ${action}` }, 400);
    }

    broadcast('queue_state', ctx.queue.getQueueState());
    return c.json({ ok: true, state: ctx.queue.getQueueState() });
  });

  // POST /api/batch (Task Manager Batch Decompose & Enqueue)
  app.post('/batch', async (c) => {
    const body = await c.req.json();
    const rawInput = String(body.rawInput ?? '');
    const cwd = String(body.cwd ?? process.cwd());
    const defaultAgent = String(body.agentId ?? 'pi');

    if (!rawInput.trim()) {
      return c.json({ error: 'rawInput cannot be empty' }, 400);
    }

    const batchId = `batch-${Date.now()}`;
    const decomposed = ctx.decomposer.parseMarkdownBacklog(rawInput, cwd, defaultAgent);

    if (decomposed.length === 0) {
      return c.json({ error: 'Could not extract any tasks from input' }, 400);
    }

    ctx.decomposer.enqueueBatch(batchId, rawInput, decomposed, cwd);
    broadcast('batch_created', { batchId, taskCount: decomposed.length });
    ctx.orchestrator.wake();

    return c.json({
      batchId,
      createdCount: decomposed.length,
      tasks: decomposed,
    }, 201);
  });

  // GET /api/stream (SSE Endpoint)
  app.get('/stream', (c) => {
    return streamSSE(c, async (stream) => {
      // Send initial snapshot
      await stream.writeSSE({
        event: 'init',
        data: JSON.stringify({
          queue: ctx.queue.getQueueState(),
          tasks: ctx.queue.listTasks(),
        }),
      });

      const listener: SseListener = (msg) => {
        void stream.writeSSE({
          event: msg.event,
          data: JSON.stringify(msg.payload),
        });
      };

      sseListeners.add(listener);

      // Heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: 'heartbeat' });
      }, 15000);

      stream.onAbort(() => {
        clearInterval(heartbeat);
        sseListeners.delete(listener);
      });

      // Keep open until client aborts
      await new Promise(() => {});
    });
  });

  return app;
}
