import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { StorageEngine } from './core/store.ts';
import { QueueController } from './core/queue.ts';
import { Orchestrator } from './core/orchestrator.ts';
import { TaskDecomposer } from './manager/decomposer.ts';
import { createApiRouter } from './api/routes.ts';

const dataDir = process.env.NIGHT_SHIFT_DIR ?? join(homedir(), '.night-shift');
mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.NIGHT_SHIFT_DB ?? join(dataDir, 'night-shift.db');
console.log(`[Night-Shift] Initializing database at: ${dbPath}`);

const storage = new StorageEngine(dbPath);
const queue = new QueueController(storage);
const orchestrator = new Orchestrator(queue);
const decomposer = new TaskDecomposer(queue);

const app = new Hono();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Mount API routes
const apiRouter = createApiRouter({ queue, orchestrator, decomposer });
app.route('/api', apiRouter);

// Root greeting / status
app.get('/', (c) => {
  return c.json({
    name: 'Night-Shift Serial Multi-Agent Orchestrator',
    status: 'running',
    version: '0.1.0',
    queueState: queue.getQueueState(),
  });
});

const port = Number(process.env.PORT ?? 4000);

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[Night-Shift] Backend server running at http://localhost:${server.port}`);

// Graceful shutdown handling
const shutdown = () => {
  console.log('\n[Night-Shift] Shutting down gracefully...');
  orchestrator.stop();
  storage.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
