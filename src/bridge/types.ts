export type BridgeTaskStatus = 'QUEUED' | 'RUNNING' | 'SETTLED';

export type BridgeOutcome = 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'TIMEOUT' | 'INTERRUPTED';

export type DeliveryStatus = 'COMPLETED' | 'BLOCKED';

export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface TriggerRequest {
  task_prompt: string;
  relative_path?: string;
  conversation_id: string;
  user_id: string;
  idempotency_key?: string;
}

export interface CreateBridgeTaskInput {
  prompt: string;
  relativePath?: string;
  resolvedCwd: string;
  conversationId: string;
  userId: string;
  idempotencyKey?: string;
  agentId: string;
}

export interface DeliveryPayload {
  task_id: string;
  status: DeliveryStatus;
  summary: string;
  modified_files: string[];
  verification_passed: boolean;
  notes?: string;
}

export interface BridgeTask {
  id: string;
  idempotencyKey: string | null;
  conversationId: string;
  userId: string;
  prompt: string;
  relativePath: string | null;
  resolvedCwd: string;
  agentId: string;
  status: BridgeTaskStatus;
  outcome: BridgeOutcome | null;
  reported: boolean;
  summary: string | null;
  modifiedFiles: string[];
  verificationPassed: boolean | null;
  notes: string | null;
  exitCode: number | null;
  logTail: string | null;
  notificationStatus: NotificationStatus;
  recoveryNotified: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface BridgeTaskRow {
  id: string;
  idempotency_key: string | null;
  conversation_id: string;
  user_id: string;
  prompt: string;
  relative_path: string | null;
  resolved_cwd: string;
  agent_id: string;
  status: BridgeTaskStatus;
  outcome: BridgeOutcome | null;
  reported: number;
  summary: string | null;
  modified_files: string | null;
  verification_passed: number | null;
  notes: string | null;
  exit_code: number | null;
  log_tail: string | null;
  notification_status: NotificationStatus;
  recovery_notified: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface BridgeEventRow {
  id: number;
  task_id: string;
  event_type: string;
  payload: string | null;
  created_at: string;
}

export interface BridgeNotificationRow {
  id: number;
  task_id: string;
  channel: string;
  status: NotificationStatus;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SettleTaskInput {
  outcome: BridgeOutcome;
  reported: boolean;
  summary: string;
  modifiedFiles?: string[];
  verificationPassed?: boolean | null;
  notes?: string | null;
  exitCode?: number | null;
  logTail?: string | null;
}

export interface NotificationEvent {
  taskId: string;
  conversationId: string;
  userId: string;
  outcome: BridgeOutcome;
  summary: string;
  modifiedFiles: string[];
  verificationPassed: boolean | null;
  notes?: string;
  exitCode?: number;
  logTail?: string;
  durationMs?: number;
  createdAt: string;
}

export interface Notifier {
  readonly channel: string;
  send(event: NotificationEvent): Promise<void>;
}

export type DeliveryResult =
  | { status: 'delivered'; task: BridgeTask }
  | { status: 'already_delivered'; task: BridgeTask }
  | { status: 'task_not_found' }
  | { status: 'task_not_running'; task: BridgeTask };

export interface AgentRunOutcome {
  exitCode: number;
  summary: string;
  rawTail: string;
  durationMs: number;
  error?: string;
}

export interface AgentRunnerLike {
  run(task: BridgeTask): Promise<AgentRunOutcome>;
  abort(taskId: string): Promise<void>;
  abortAll(): Promise<void>;
}
