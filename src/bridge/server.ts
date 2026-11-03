import type { BridgeConfig } from './config.ts';
import { loadBridgeConfig } from './config.ts';
import { openBridgeDatabase } from './db/schema.ts';
import { BridgeRepository } from './db/queries.ts';
import { PiBridgeAgentRunner } from './agent-runner.ts';
import { DeliveryService } from './delivery.ts';
import { BridgeScheduler } from './scheduler.ts';
import { createNotifiers, NotificationDispatcher } from './notifier/index.ts';
import { createPublicApp } from './public-routes.ts';
import { createInternalApp } from './internal-routes.ts';
import type { AgentRunnerLike, Notifier } from './types.ts';
import { logError, logInfo } from './logging.ts';

export interface BridgeRuntimeOverrides {
  config?: BridgeConfig;
  repo?: BridgeRepository;
  runner?: AgentRunnerLike;
  notifiers?: Notifier[];
}

export interface BridgeRuntime {
  config: BridgeConfig;
  repo: BridgeRepository;
  scheduler: BridgeScheduler;
  deliveryService: DeliveryService;
  dispatcher: NotificationDispatcher;
  publicServer: ReturnType<typeof Bun.serve>;
  internalServer: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
}

export async function startBridge(
  overrides: BridgeRuntimeOverrides = {}
): Promise<BridgeRuntime> {
  const config = overrides.config ?? loadBridgeConfig();
  const ownsRepo = !overrides.repo;
  const db = overrides.repo ? null : openBridgeDatabase(config.dbPath);
  const repo =
    overrides.repo ??
    new BridgeRepository(db!, { dedupeWindowMs: config.dedupeWindowMs });
  const notifiers = overrides.notifiers ?? createNotifiers(config);
  const dispatcher = new NotificationDispatcher(
    repo,
    notifiers,
    config.notifyRetryDelaysMs
  );
  const deliveryService = new DeliveryService(repo, dispatcher);
  const runner = overrides.runner ?? new PiBridgeAgentRunner(config);
  const scheduler = new BridgeScheduler(repo, config, runner, deliveryService, dispatcher);

  const publicApp = createPublicApp({ config, repo, dispatcher, scheduler });
  const internalApp = createInternalApp({ config, deliveryService });

  let publicServer: ReturnType<typeof Bun.serve> | null = null;
  let internalServer: ReturnType<typeof Bun.serve> | null = null;

  try {
    publicServer = Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: publicApp.fetch,
      maxRequestBodySize: 1024 * 1024
    });

    internalServer = Bun.serve({
      hostname: config.internalHost,
      port: config.internalPort,
      fetch: internalApp.fetch,
      maxRequestBodySize: 256 * 1024
    });

    await scheduler.start();
  } catch (error) {
    publicServer?.stop();
    internalServer?.stop();
    if (ownsRepo) {
      repo.close();
    }
    throw error;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logInfo('bridge shutting down');
    try {
      publicServer?.stop();
      await scheduler.stop();
    } finally {
      internalServer?.stop();
      if (ownsRepo) {
        repo.close();
      }
      logInfo('bridge stopped');
    }
  };

  logInfo('bridge started', {
    publicUrl: `http://${config.host}:${publicServer.port}`,
    internalUrl: `http://${config.internalHost}:${internalServer.port}`,
    workspaceBase: config.workspaceBase,
    notifiers: config.notifiers,
    maxConcurrency: config.maxConcurrency
  });

  return {
    config,
    repo,
    scheduler,
    deliveryService,
    dispatcher,
    publicServer: publicServer!,
    internalServer: internalServer!,
    stop
  };
}

if (import.meta.main) {
  try {
    const runtime = await startBridge();
    const shutdown = async (): Promise<void> => {
      await runtime.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
  } catch (error) {
    logError('bridge failed to start', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}
