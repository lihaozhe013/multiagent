import { describe, it, expect } from 'bun:test';
import { defaultAgentRegistry, AgentRegistry } from './registry.ts';
import { OutputRingBuffer } from '../core/watchdog.ts';

describe('Agent Adapters and Watchdog', () => {
  it('registers default adapters pi and opencode', () => {
    const registry = new AgentRegistry();
    expect(registry.listIds()).toContain('pi');
    expect(registry.listIds()).toContain('opencode');
    expect(registry.get('pi')?.name).toBe('Pi Coding Agent');
    expect(registry.get('opencode')?.name).toBe('OpenCode Agent');
  });

  it('checks readiness of pi CLI in local environment', async () => {
    const pi = defaultAgentRegistry.get('pi');
    expect(pi).toBeDefined();
    const readiness = await pi!.checkReadiness();
    expect(readiness.ok).toBe(true);
    expect(readiness.version).toBeDefined();
  });

  it('checks readiness of opencode CLI in local environment', async () => {
    const opencode = defaultAgentRegistry.get('opencode');
    expect(opencode).toBeDefined();
    const readiness = await opencode!.checkReadiness();
    expect(readiness.ok).toBe(true);
    expect(readiness.version).toBeDefined();
  });

  it('OutputRingBuffer bounds text accurately', () => {
    const buffer = new OutputRingBuffer(20); // 20 bytes
    buffer.append('Hello World 1\n'); // 14 bytes
    buffer.append('Hello World 2\n'); // 14 bytes -> total 28 > 20, trims World 1

    const tail = buffer.getTail();
    expect(tail).toBe('Hello World 2\n');
  });
});
