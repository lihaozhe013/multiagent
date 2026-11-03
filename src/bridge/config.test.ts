import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { loadBridgeConfig } from './config.ts';

function baseEnv(): Record<string, string> {
  return {
    WORKSPACE_BASE: tmpdir(),
    BRIDGE_TRIGGER_TOKEN: 'trigger-token',
    BRIDGE_INTERNAL_TOKEN: 'internal-token',
    BRIDGE_NOTIFIERS: 'generic',
    GENERIC_WEBHOOK_URL: 'http://127.0.0.1:1/hook'
  };
}

describe('bridge config', () => {
  it('loads a valid configuration', () => {
    const config = loadBridgeConfig(baseEnv());
    expect(config.port).toBe(4100);
    expect(config.internalPort).toBe(4101);
    expect(config.maxConcurrency).toBe(1);
    expect(config.notifiers).toEqual(['generic']);
    expect(config.triggerToken).toBe('trigger-token');
  });

  it('requires a trigger token', () => {
    const env = baseEnv();
    delete env.BRIDGE_TRIGGER_TOKEN;
    expect(() => loadBridgeConfig(env)).toThrow('BRIDGE_TRIGGER_TOKEN');
  });

  it('requires a webhook URL for enabled notifiers', () => {
    const env = baseEnv();
    delete env.GENERIC_WEBHOOK_URL;
    expect(() => loadBridgeConfig(env)).toThrow('GENERIC_WEBHOOK_URL');
  });

  it('rejects a non-loopback internal host', () => {
    const env = { ...baseEnv(), BRIDGE_INTERNAL_HOST: '0.0.0.0' };
    expect(() => loadBridgeConfig(env)).toThrow('loopback');
  });

  it('rejects unsupported agents in the MVP', () => {
    const env = { ...baseEnv(), BRIDGE_AGENT_ID: 'opencode' };
    expect(() => loadBridgeConfig(env)).toThrow('Only the pi agent');
  });

  it('parses booleans and numbers', () => {
    const env = {
      ...baseEnv(),
      BRIDGE_MAX_CONCURRENCY: '2',
      BRIDGE_TASK_TIMEOUT_MS: '5000',
      BRIDGE_RECOVER_NOTIFY: 'false',
      BRIDGE_DEDUPE_WINDOW_MS: '1000'
    };
    const config = loadBridgeConfig(env);
    expect(config.maxConcurrency).toBe(2);
    expect(config.taskTimeoutMs).toBe(5000);
    expect(config.recoverNotify).toBe(false);
    expect(config.dedupeWindowMs).toBe(1000);
  });
});
