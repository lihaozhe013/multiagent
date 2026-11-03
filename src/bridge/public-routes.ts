import { Hono, type Context, type Next } from 'hono';
import type { BridgeConfig } from './config.ts';
import type { BridgeRepository } from './db/queries.ts';
import type { NotificationDispatcher } from './notifier/index.ts';
import type { BridgeScheduler } from './scheduler.ts';
import type { BridgeTask, BridgeTaskStatus, TriggerRequest } from './types.ts';
import {
  extractBearerToken,
  resolveWorkspacePath,
  timingSafeEqualString,
  validateTriggerRequest,
  ValidationError,
  WorkspacePathError
} from './security.ts';
import { errorMessage } from './logging.ts';

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

function fail(error: string, code: string, status: ErrorStatus) {
  return { error, code, status } as const;
}

function serializeTask(task: BridgeTask) {
  return {
    id: task.id,
    idempotency_key: task.idempotencyKey,
    conversation_id: task.conversationId,
    user_id: task.userId,
    prompt: task.prompt,
    relative_path: task.relativePath,
    resolved_cwd: task.resolvedCwd,
    agent_id: task.agentId,
    status: task.status,
    outcome: task.outcome,
    reported: task.reported,
    summary: task.summary,
    modified_files: task.modifiedFiles,
    verification_passed: task.verificationPassed,
    notes: task.notes,
    exit_code: task.exitCode,
    log_tail: task.logTail,
    notification_status: task.notificationStatus,
    created_at: task.createdAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    updated_at: task.updatedAt
  };
}

function isTaskStatus(value: string): value is BridgeTaskStatus {
  return value === 'QUEUED' || value === 'RUNNING' || value === 'SETTLED';
}

export interface PublicRoutesContext {
  config: BridgeConfig;
  repo: BridgeRepository;
  dispatcher: NotificationDispatcher;
  scheduler: BridgeScheduler;
}

export function createPublicApp(ctx: PublicRoutesContext): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const counts = ctx.repo.countByStatus();
    return c.json({
      status: 'ok',
      uptime_seconds: Math.round(process.uptime()),
      running_tasks: counts.RUNNING,
      queued_tasks: counts.QUEUED,
      notifier_channels: ctx.config.notifiers
    });
  });

  const requireAuth = async (c: Context, next: Next) => {
    const token = extractBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeEqualString(token, ctx.config.triggerToken)) {
      const response = fail('Unauthorized', 'unauthorized', 401);
      return c.json({ error: response.error, code: response.code }, response.status);
    }
    await next();
  };

  app.use('/trigger', requireAuth);
  app.use('/api/bridge/*', requireAuth);

  app.post('/trigger', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      const response = fail('Invalid JSON body', 'invalid_json', 400);
      return c.json({ error: response.error, code: response.code }, response.status);
    }

    let input: TriggerRequest;
    try {
      input = validateTriggerRequest(body);
    } catch (error) {
      if (error instanceof ValidationError) {
        const response = fail(error.message, 'invalid_request', 400);
        return c.json({ error: response.error, code: response.code }, response.status);
      }
      throw error;
    }

    let resolvedCwd: string;
    try {
      resolvedCwd = resolveWorkspacePath(ctx.config.workspaceBase, input.relative_path);
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        const response = fail(error.message, 'invalid_workspace_path', 403);
        return c.json({ error: response.error, code: response.code }, response.status);
      }
      throw error;
    }

    if (input.idempotency_key) {
      const existing = ctx.repo.findByIdempotencyKey(input.idempotency_key);
      if (existing) {
        return c.json({
          status: 'accepted',
          task_id: existing.id,
          message: 'Duplicate task detected; returning the existing task.',
          duplicate: true
        });
      }
    }

    if (ctx.repo.countQueued() >= ctx.config.maxQueueDepth) {
      const response = fail('Bridge queue is full', 'queue_full', 429);
      return c.json({ error: response.error, code: response.code }, response.status);
    }

    const result = ctx.repo.createTask({
      prompt: input.task_prompt,
      relativePath: input.relative_path,
      resolvedCwd,
      conversationId: input.conversation_id,
      userId: input.user_id,
      idempotencyKey: input.idempotency_key,
      agentId: ctx.config.agentId
    });

    if (!result.duplicate) {
      ctx.scheduler.wake();
    }

    return c.json({
      status: 'accepted',
      task_id: result.task.id,
      message: result.duplicate
        ? 'Duplicate task detected; returning the existing task.'
        : 'Task queued and running in background.',
      duplicate: result.duplicate
    });
  });

  app.get('/api/bridge/tasks', (c) => {
    const status = c.req.query('status');
    if (status && !isTaskStatus(status)) {
      const response = fail('status must be QUEUED, RUNNING, or SETTLED', 'invalid_status', 400);
      return c.json({ error: response.error, code: response.code }, response.status);
    }
    const taskStatus: BridgeTaskStatus | undefined = status && isTaskStatus(status) ? status : undefined;

    const rawLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const tasks = ctx.repo.listTasks({ status: taskStatus, limit });
    return c.json({ tasks: tasks.map(serializeTask) });
  });

  app.get('/api/bridge/tasks/:id', (c) => {
    const task = ctx.repo.getTask(c.req.param('id'));
    if (!task) {
      const response = fail('Task not found', 'task_not_found', 404);
      return c.json({ error: response.error, code: response.code }, response.status);
    }
    return c.json({ task: serializeTask(task) });
  });

  app.get('/api/bridge/tasks/:id/notifications', (c) => {
    const task = ctx.repo.getTask(c.req.param('id'));
    if (!task) {
      const response = fail('Task not found', 'task_not_found', 404);
      return c.json({ error: response.error, code: response.code }, response.status);
    }
    return c.json({ notifications: ctx.repo.listNotifications(task.id) });
  });

  app.post('/api/bridge/tasks/:id/replay-notification', async (c) => {
    const task = ctx.repo.getTask(c.req.param('id'));
    if (!task) {
      const response = fail('Task not found', 'task_not_found', 404);
      return c.json({ error: response.error, code: response.code }, response.status);
    }
    if (task.status !== 'SETTLED') {
      const response = fail('Task has not settled yet', 'task_not_settled', 409);
      return c.json({ error: response.error, code: response.code }, response.status);
    }

    try {
      const notificationStatus = await ctx.dispatcher.dispatch(task, { force: true });
      return c.json({ status: 'replayed', notification_status: notificationStatus });
    } catch (error) {
      const response = fail(errorMessage(error), 'notification_failed', 500);
      return c.json({ error: response.error, code: response.code }, response.status);
    }
  });

  return app;
}
