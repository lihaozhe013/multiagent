import { realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { DeliveryPayload, TriggerRequest } from './types.ts';

const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_CONVERSATION_ID_LENGTH = 255;
const MAX_USER_ID_LENGTH = 255;
const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_NOTES_BYTES = 8 * 1024;
const MAX_MODIFIED_FILES = 200;
const MAX_MODIFIED_FILE_LENGTH = 1024;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  maxLength?: number,
  maxBytes?: number
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`${field} cannot be empty`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new ValidationError(`${field} exceeds ${maxLength} characters`);
  }
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ValidationError(`${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength?: number,
  maxBytes?: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  if (value === '') return undefined;
  if (maxLength !== undefined && value.length > maxLength) {
    throw new ValidationError(`${field} exceeds ${maxLength} characters`);
  }
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ValidationError(`${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

export function validateTriggerRequest(body: unknown): TriggerRequest {
  if (!isRecord(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const taskPrompt = requireString(
    body.task_prompt,
    'task_prompt',
    undefined,
    MAX_PROMPT_BYTES
  );
  const conversationId = requireString(
    body.conversation_id,
    'conversation_id',
    MAX_CONVERSATION_ID_LENGTH
  );
  const userId = requireString(body.user_id, 'user_id', MAX_USER_ID_LENGTH);
  const relativePath = optionalString(
    body.relative_path,
    'relative_path',
    MAX_RELATIVE_PATH_LENGTH
  );
  const idempotencyKey = optionalString(
    body.idempotency_key,
    'idempotency_key',
    MAX_IDEMPOTENCY_KEY_LENGTH
  );

  return {
    task_prompt: taskPrompt,
    ...(relativePath ? { relative_path: relativePath } : {}),
    conversation_id: conversationId,
    user_id: userId,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
  };
}

export function validateDeliveryPayload(body: unknown): DeliveryPayload {
  if (!isRecord(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const taskId = requireString(body.task_id, 'task_id', 255);
  const status = requireString(body.status, 'status', 32);
  if (status !== 'COMPLETED' && status !== 'BLOCKED') {
    throw new ValidationError('status must be COMPLETED or BLOCKED');
  }

  const summary = requireString(body.summary, 'summary', undefined, MAX_SUMMARY_BYTES);
  const notes = optionalString(body.notes, 'notes', undefined, MAX_NOTES_BYTES);

  if (!Array.isArray(body.modified_files)) {
    throw new ValidationError('modified_files must be an array');
  }
  if (body.modified_files.length > MAX_MODIFIED_FILES) {
    throw new ValidationError(`modified_files exceeds ${MAX_MODIFIED_FILES} entries`);
  }

  const modifiedFiles = body.modified_files.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new ValidationError(`modified_files[${index}] must be a non-empty string`);
    }
    if (item.length > MAX_MODIFIED_FILE_LENGTH) {
      throw new ValidationError(
        `modified_files[${index}] exceeds ${MAX_MODIFIED_FILE_LENGTH} characters`
      );
    }
    return item;
  });

  if (typeof body.verification_passed !== 'boolean') {
    throw new ValidationError('verification_passed must be a boolean');
  }

  return {
    task_id: taskId,
    status,
    summary,
    modified_files: modifiedFiles,
    verification_passed: body.verification_passed,
    ...(notes ? { notes } : {})
  };
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function resolveWorkspacePath(workspaceBase: string, relativePath?: string): string {
  let base: string;
  try {
    base = realpathSync(workspaceBase);
  } catch {
    throw new WorkspacePathError(`Workspace base does not exist: ${workspaceBase}`);
  }

  const baseStat = statSync(base);
  if (!baseStat.isDirectory()) {
    throw new WorkspacePathError(`Workspace base is not a directory: ${base}`);
  }

  const candidate = relativePath ? join(base, relativePath) : base;
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw new WorkspacePathError(`Target path does not exist: ${relativePath ?? '.'}`);
  }

  const candidateStat = statSync(resolved);
  if (!candidateStat.isDirectory()) {
    throw new WorkspacePathError(`Target path is not a directory: ${relativePath ?? '.'}`);
  }

  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new WorkspacePathError('Target path escapes the workspace base');
  }

  return resolved;
}
