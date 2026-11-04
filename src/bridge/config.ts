import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_BRIDGE_SYSTEM_PROMPT } from './prompts.ts';

export interface BridgeConfig {
  port: number;
  host: string;
  internalPort: number;
  internalHost: string;
  workspaceBase: string;
  triggerToken: string;
  internalToken: string;
  dbPath: string;
  taskTimeoutMs: number;
  killGraceMs: number;
  maxConcurrency: number;
  maxQueueDepth: number;
  dedupeWindowMs: number;
  shutdownGraceMs: number;
  notifyOnShutdown: boolean;
  recoverNotify: boolean;
  retentionDays: number;
  agentId: string;
  piBinary: string;
  piModel?: string;
  piExtension: string;
  systemPrompt: string;
  notifiers: string[];
  dingtalkWebhookUrl?: string;
  dingtalkWebhookSecret?: string;
  genericWebhookUrl?: string;
  genericWebhookToken?: string;
  notifyRetryDelaysMs: number[];
}

const PROJECT_ROOT = resolve(import.meta.dir, '../..');

function parseNumber(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

function parseBoolean(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${key} must be a boolean`);
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

function requireString(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(
  env: Record<string, string | undefined>,
  key: string
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function resolveOptionalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const expanded = expandHome(value);
  if (existsSync(expanded)) return readFileSync(expanded, 'utf8');
  return value;
}

function parseNotifiers(env: Record<string, string | undefined>): string[] {
  const raw = env.BRIDGE_NOTIFIERS?.trim() || 'dingtalk';
  const channels = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (channels.length === 0) {
    throw new Error('BRIDGE_NOTIFIERS must contain at least one channel');
  }

  for (const channel of channels) {
    if (channel !== 'dingtalk' && channel !== 'generic') {
      throw new Error(`Unsupported notifier channel: ${channel}`);
    }
  }

  return [...new Set(channels)];
}

export function loadBridgeConfig(
  env: Record<string, string | undefined> = process.env
): BridgeConfig {
  const workspaceBase = resolve(expandHome(requireString(env, 'WORKSPACE_BASE')));
  if (!isAbsolute(workspaceBase)) {
    throw new Error('WORKSPACE_BASE must be an absolute path');
  }

  const dbPath = resolve(expandHome(optionalString(env, 'BRIDGE_DB_PATH') ?? '~/.night-shift/bridge.db'));
  const triggerToken = requireString(env, 'BRIDGE_TRIGGER_TOKEN');
  const internalToken = optionalString(env, 'BRIDGE_INTERNAL_TOKEN') ?? crypto.randomUUID();

  const internalHost = optionalString(env, 'BRIDGE_INTERNAL_HOST') ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(internalHost)) {
    throw new Error('BRIDGE_INTERNAL_HOST must be a loopback address');
  }

  const agentId = optionalString(env, 'BRIDGE_AGENT_ID') ?? 'pi';
  if (agentId !== 'pi') {
    throw new Error('Only the pi agent is supported in the MVP');
  }

  const notifiers = parseNotifiers(env);
  const dingtalkWebhookUrl = optionalString(env, 'DINGTALK_WEBHOOK_URL');
  const genericWebhookUrl = optionalString(env, 'GENERIC_WEBHOOK_URL');

  if (notifiers.includes('dingtalk') && !dingtalkWebhookUrl) {
    throw new Error('DINGTALK_WEBHOOK_URL is required when the dingtalk notifier is enabled');
  }
  if (notifiers.includes('generic') && !genericWebhookUrl) {
    throw new Error('GENERIC_WEBHOOK_URL is required when the generic notifier is enabled');
  }

  const configuredExtension = optionalString(env, 'BRIDGE_PI_EXTENSION');
  const piExtension = resolve(
    PROJECT_ROOT,
    expandHome(configuredExtension ?? 'extensions/delivery.ts')
  );
  if (!existsSync(piExtension)) {
    throw new Error(`BRIDGE_PI_EXTENSION does not exist: ${piExtension}`);
  }

  const systemPrompt =
    resolveOptionalText(optionalString(env, 'BRIDGE_SYSTEM_PROMPT')) ??
    DEFAULT_BRIDGE_SYSTEM_PROMPT;

  return {
    port: parseNumber(env, 'BRIDGE_PORT', 4100),
    host: optionalString(env, 'BRIDGE_HOST') ?? '0.0.0.0',
    internalPort: parseNumber(env, 'BRIDGE_INTERNAL_PORT', 4101),
    internalHost,
    workspaceBase,
    triggerToken,
    internalToken,
    dbPath,
    taskTimeoutMs: parseNumber(env, 'BRIDGE_TASK_TIMEOUT_MS', 15 * 60 * 1000),
    killGraceMs: parseNumber(env, 'BRIDGE_KILL_GRACE_MS', 3000),
    maxConcurrency: Math.max(1, parseNumber(env, 'BRIDGE_MAX_CONCURRENCY', 1)),
    maxQueueDepth: parseNumber(env, 'BRIDGE_MAX_QUEUE_DEPTH', 50),
    dedupeWindowMs: parseNumber(env, 'BRIDGE_DEDUPE_WINDOW_MS', 0),
    shutdownGraceMs: parseNumber(env, 'BRIDGE_SHUTDOWN_GRACE_MS', 10000),
    notifyOnShutdown: parseBoolean(env, 'BRIDGE_NOTIFY_ON_SHUTDOWN', true),
    recoverNotify: parseBoolean(env, 'BRIDGE_RECOVER_NOTIFY', true),
    retentionDays: parseNumber(env, 'BRIDGE_RETENTION_DAYS', 30),
    agentId,
    piBinary: optionalString(env, 'BRIDGE_PI_BINARY') ?? 'pi',
    ...(optionalString(env, 'BRIDGE_PI_MODEL')
      ? { piModel: optionalString(env, 'BRIDGE_PI_MODEL') }
      : {}),
    piExtension,
    systemPrompt,
    notifiers,
    ...(dingtalkWebhookUrl ? { dingtalkWebhookUrl } : {}),
    ...(optionalString(env, 'DINGTALK_WEBHOOK_SECRET')
      ? { dingtalkWebhookSecret: optionalString(env, 'DINGTALK_WEBHOOK_SECRET') }
      : {}),
    ...(genericWebhookUrl ? { genericWebhookUrl } : {}),
    ...(optionalString(env, 'GENERIC_WEBHOOK_TOKEN')
      ? { genericWebhookToken: optionalString(env, 'GENERIC_WEBHOOK_TOKEN') }
      : {}),
    notifyRetryDelaysMs: [1000, 4000, 16000]
  };
}
