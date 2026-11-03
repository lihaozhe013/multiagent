import { Hono, type Context, type Next } from 'hono';
import type { BridgeConfig } from './config.ts';
import type { DeliveryService } from './delivery.ts';
import type { DeliveryPayload } from './types.ts';
import {
  extractBearerToken,
  timingSafeEqualString,
  validateDeliveryPayload,
  ValidationError
} from './security.ts';

export interface InternalRoutesContext {
  config: BridgeConfig;
  deliveryService: DeliveryService;
}

export function createInternalApp(ctx: InternalRoutesContext): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', scope: 'internal' }));

  const requireInternalAuth = async (c: Context, next: Next) => {
    const token = extractBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeEqualString(token, ctx.config.internalToken)) {
      return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }
    await next();
  };

  app.use('/internal/delivery', requireInternalAuth);

  app.post('/internal/delivery', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'invalid_json' }, 400);
    }

    let payload: DeliveryPayload;
    try {
      payload = validateDeliveryPayload(body);
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message, code: 'invalid_delivery' }, 400);
      }
      throw error;
    }

    const result = await ctx.deliveryService.deliver(payload);
    if (result.status === 'delivered') {
      return c.json({ status: 'delivered' });
    }
    if (result.status === 'already_delivered') {
      return c.json({ status: 'already_delivered' });
    }
    if (result.status === 'task_not_found') {
      return c.json({ error: 'Task not found', code: 'task_not_found' }, 404);
    }

    return c.json(
      {
        error: `Task is not running (current status: ${result.task.status})`,
        code: 'task_not_running'
      },
      409
    );
  });

  return app;
}
