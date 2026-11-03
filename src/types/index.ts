export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' | 'FAILED';

export type PipelineStage = 'CODER' | 'TEST' | 'REVIEW' | 'AGENT' | 'IDLE';

export type QueueRunState = 'IDLE' | 'RUNNING' | 'PAUSED';

export interface Task {
  id: number;
  batch_id: string | null;
  title: string;
  description: string;
  agent_id: string; // 'pi' | 'opencode' | custom
  cwd: string;
  status: TaskStatus;
  rank: number;
  verify_commands: string[]; // parsed from JSON array
  max_retries: number;
  retry_count: number;
  current_stage: PipelineStage;
  claimed_token: string | null;
  result_summary: string | null;
  error_tail: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface TaskRow {
  id: number;
  batch_id: string | null;
  title: string;
  description: string;
  agent_id: string;
  cwd: string;
  status: TaskStatus;
  rank: number;
  verify_commands: string | null; // raw JSON string
  max_retries: number;
  retry_count: number;
  current_stage: PipelineStage | null;
  claimed_token: string | null;
  result_summary: string | null;
  error_tail: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface TaskRun {
  id: number;
  task_id: number;
  attempt: number;
  stage: PipelineStage;
  agent_id: string;
  status: 'SUCCESS' | 'FAILED' | 'REJECTED';
  log_tail: string | null;
  feedback: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface QueueState {
  id: number;
  state: QueueRunState;
  paused_reason: string | null;
  active_task_id: number | null;
  active_stage: PipelineStage | null;
  updated_at: string;
}

export interface Batch {
  id: string;
  raw_input: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  created_at: string;
  finished_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  cwd: string;
  agent_id?: string;
  batch_id?: string;
  verify_commands?: string[];
  max_retries?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  cwd?: string;
  agent_id?: string;
  verify_commands?: string[];
  max_retries?: number;
}

export interface SettleOutcome {
  status: 'DONE' | 'BLOCKED' | 'FAILED';
  result_summary?: string;
  error_tail?: string;
}

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'file_change' | 'stdout' | 'stderr' | 'error';
  timestamp: number;
  content: string;
  metadata?: Record<string, unknown>;
}
