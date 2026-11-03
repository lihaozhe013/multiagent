import type { BridgeTask, NotificationEvent } from '../types.ts';

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_LOG_BYTES = 2 * 1024;
const MAX_LOG_LINES = 50;
const MAX_FILES = 50;

export function truncateText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  let output = '';
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return `${output}\n...[truncated]`;
}

export function truncateLogTail(text: string): string {
  if (!text) return '';
  let lines = text.split(/\r?\n/);
  if (lines.length > MAX_LOG_LINES) {
    lines = lines.slice(-MAX_LOG_LINES);
  }

  const joined = lines.join('\n');
  if (Buffer.byteLength(joined, 'utf8') <= MAX_LOG_BYTES) return joined;

  let output = '';
  let bytes = 0;
  for (let index = joined.length - 1; index >= 0; index -= 1) {
    const char = joined[index];
    if (!char) continue;
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > MAX_LOG_BYTES) break;
    output = char + output;
    bytes += charBytes;
  }
  return `...[truncated]\n${output}`;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function verificationLabel(value: boolean | null): string {
  if (value === null) return 'UNKNOWN';
  return value ? 'PASSED' : 'FAILED';
}

function formatFiles(files: string[]): string[] {
  if (files.length === 0) return ['- (none)'];
  const shown = files.slice(0, MAX_FILES).map((file) => `- ${file}`);
  if (files.length > MAX_FILES) {
    shown.push(`- ... and ${files.length - MAX_FILES} more`);
  }
  return shown;
}

export function formatNotificationText(event: NotificationEvent): string {
  const lines: string[] = [
    `[Night-Shift] ${event.outcome}`,
    `Task: ${event.taskId}`,
    `User: ${event.userId}`
  ];

  if (event.durationMs !== undefined) {
    lines.push(`Duration: ${formatDuration(event.durationMs)}`);
  }

  lines.push(
    '',
    'Summary:',
    truncateText(event.summary, MAX_SUMMARY_BYTES),
    '',
    'Files:',
    ...formatFiles(event.modifiedFiles),
    '',
    `Verification: ${verificationLabel(event.verificationPassed)}`
  );

  if (event.notes) {
    lines.push('', 'Notes:', truncateText(event.notes, MAX_SUMMARY_BYTES));
  }

  if (event.exitCode !== undefined) {
    lines.push('', `Exit code: ${event.exitCode}`);
  }

  if (event.logTail) {
    lines.push('', 'Log tail:', truncateLogTail(event.logTail));
  }

  return truncateText(lines.join('\n'), MAX_MESSAGE_BYTES);
}

export function taskToNotificationEvent(task: BridgeTask): NotificationEvent {
  const start = task.startedAt ? Date.parse(task.startedAt) : Date.parse(task.createdAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  const durationMs = Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined;

  return {
    taskId: task.id,
    conversationId: task.conversationId,
    userId: task.userId,
    outcome: task.outcome ?? 'FAILED',
    summary: task.summary ?? 'No summary provided',
    modifiedFiles: task.modifiedFiles,
    verificationPassed: task.verificationPassed,
    ...(task.notes ? { notes: task.notes } : {}),
    ...(task.exitCode !== null ? { exitCode: task.exitCode } : {}),
    ...(task.logTail ? { logTail: task.logTail } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    createdAt: task.createdAt
  };
}
