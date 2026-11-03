import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageEngine } from './store.ts';
import { QueueController } from './queue.ts';
import { PipelineRunner } from './pipeline.ts';
import { runVerificationCommands } from './gate.ts';
import { isGitRepo } from './git.ts';
import { AgentRegistry } from '../adapters/registry.ts';
import type { AgentAdapter, AgentRunOptions, AgentExecutionResult } from '../adapters/types.ts';

class MockAgentAdapter implements AgentAdapter {
  public readonly id = 'mock';
  public readonly name = 'Mock Agent';
  public calls: AgentRunOptions[] = [];
  public shouldFailCoder = false;

  public async checkReadiness() {
    return { ok: true, version: '1.0' };
  }

  public async execute(options: AgentRunOptions): Promise<AgentExecutionResult> {
    this.calls.push(options);
    if (this.shouldFailCoder && options.stage === 'CODER') {
      return {
        exitCode: 1,
        summary: 'Mock coder intentional failure',
        rawTail: 'Error: syntax error at line 1',
        durationMs: 10,
      };
    }

    if (options.stage === 'REVIEW') {
      return {
        exitCode: 0,
        summary: 'Review completed',
        rawTail: 'Code looks good.\nVERDICT: APPROVE',
        durationMs: 10,
      };
    }

    return {
      exitCode: 0,
      summary: 'Mock success',
      rawTail: 'All done',
      durationMs: 10,
    };
  }

  public async abort() {}
}

describe('Pipeline and Gate Engine', () => {
  let storage: StorageEngine;
  let queue: QueueController;
  let registry: AgentRegistry;
  let mockAdapter: MockAgentAdapter;
  let pipeline: PipelineRunner;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
    storage = new StorageEngine(':memory:');
    queue = new QueueController(storage);
    registry = new AgentRegistry();
    mockAdapter = new MockAgentAdapter();
    registry.register(mockAdapter);
    pipeline = new PipelineRunner(queue, registry);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('runVerificationCommands executes successfully for clean commands', async () => {
    const res = await runVerificationCommands(['echo "hello world"', 'true'], tempDir);
    expect(res.passed).toBe(true);
    expect(res.outputTail).toContain('hello world');
  });

  it('runVerificationCommands flags failing command accurately', async () => {
    const res = await runVerificationCommands(['echo "first"', 'false', 'echo "should not reach"'], tempDir);
    expect(res.passed).toBe(false);
    expect(res.failingCommand).toBe('false');
    expect(res.outputTail).toContain('first');
    expect(res.outputTail).not.toContain('should not reach');
  });

  it('isGitRepo correctly detects current repo', async () => {
    const isGit = await isGitRepo(process.cwd());
    expect(isGit).toBe(true);
  });

  it('Pipeline runs Coder -> Test -> Done on clean pass', async () => {
    const task = queue.createTask({
      title: 'Simple Task',
      description: 'Do something simple',
      cwd: tempDir,
      agent_id: 'mock',
      verify_commands: ['true'],
    });

    const claimed = queue.claimNext()!;
    const settled = await pipeline.runTask(claimed.task, claimed.token);

    expect(settled.status).toBe('DONE');
    expect(mockAdapter.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockAdapter.calls[0]?.stage).toBe('CODER');

    const runs = queue.listRuns(task.id);
    expect(runs.some((r) => r.stage === 'CODER' && r.status === 'SUCCESS')).toBe(true);
    expect(runs.some((r) => r.stage === 'TEST' && r.status === 'SUCCESS')).toBe(true);
  });

  it('Pipeline loops back to Coder when Test Gate fails and retries', async () => {
    const task = queue.createTask({
      title: 'Retry Task',
      description: 'Fix the bug',
      cwd: tempDir,
      agent_id: 'mock',
      verify_commands: ['false'],
      max_retries: 2,
    });

    const claimed = queue.claimNext()!;
    const settled = await pipeline.runTask(claimed.task, claimed.token);

    expect(settled.status).toBe('BLOCKED');
    expect(settled.result_summary).toContain('Verification failed on: false');

    const runs = queue.listRuns(task.id);
    expect(runs.filter((r) => r.stage === 'TEST').length).toBe(3);
  });
});
