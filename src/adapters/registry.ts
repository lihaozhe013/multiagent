import type { AgentAdapter } from './types.ts';
import { PiAdapter } from './pi.ts';
import { OpenCodeAdapter } from './opencode.ts';

export class AgentRegistry {
  private adapters = new Map<string, AgentAdapter>();

  constructor() {
    this.register(new PiAdapter());
    this.register(new OpenCodeAdapter());
  }

  public register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  public getOrThrow(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Agent adapter '${id}' not found. Registered: ${this.listIds().join(', ')}`);
    }
    return adapter;
  }

  public list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  public listIds(): string[] {
    return Array.from(this.adapters.keys());
  }
}

export const defaultAgentRegistry = new AgentRegistry();
