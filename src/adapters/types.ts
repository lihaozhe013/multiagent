import type { AgentEvent, PipelineStage } from '../types/index.ts';

export interface AgentRunOptions {
  taskId: number;
  runId: number;
  stage: PipelineStage;
  title: string;
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  appendSystemPrompt?: string;
  model?: string;
}

export interface AgentExecutionResult {
  exitCode: number;
  summary: string;
  rawTail: string;
  durationMs: number;
  error?: string;
}

export interface AdapterReadiness {
  ok: boolean;
  version?: string;
  executablePath?: string;
  error?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;

  checkReadiness(): Promise<AdapterReadiness>;

  execute(
    options: AgentRunOptions,
    onEvent?: (event: AgentEvent) => void
  ): Promise<AgentExecutionResult>;

  abort(runId: number): Promise<void>;
}
