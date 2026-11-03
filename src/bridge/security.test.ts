import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveWorkspacePath,
  timingSafeEqualString,
  validateDeliveryPayload,
  validateTriggerRequest,
  ValidationError,
  WorkspacePathError
} from './security.ts';

describe('bridge security', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bridge-security-'));
    workspace = join(root, 'workspace');
    outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(join(workspace, 'project'));
    mkdirSync(join(root, 'workspace-evil'));
    symlinkSync(outside, join(workspace, 'escape-link'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the base and an in-workspace subdirectory', () => {
    expect(resolveWorkspacePath(workspace)).toBe(workspace);
    expect(resolveWorkspacePath(workspace, 'project')).toBe(join(workspace, 'project'));
  });

  it('rejects traversal, sibling-prefix paths, and symlink escapes', () => {
    expect(() => resolveWorkspacePath(workspace, '../outside')).toThrow(WorkspacePathError);
    expect(() => resolveWorkspacePath(workspace, '../workspace-evil')).toThrow(WorkspacePathError);
    expect(() => resolveWorkspacePath(workspace, 'escape-link')).toThrow(WorkspacePathError);
    expect(() => resolveWorkspacePath(workspace, 'missing')).toThrow(WorkspacePathError);
  });

  it('validates trigger payloads', () => {
    const valid = validateTriggerRequest({
      task_prompt: 'Do the task',
      relative_path: 'project',
      conversation_id: 'conv-1',
      user_id: 'user-1',
      idempotency_key: 'key-1'
    });
    expect(valid.task_prompt).toBe('Do the task');
    expect(valid.relative_path).toBe('project');

    expect(() => validateTriggerRequest({})).toThrow(ValidationError);
    expect(() =>
      validateTriggerRequest({
        task_prompt: 'x'.repeat(33 * 1024),
        conversation_id: 'c',
        user_id: 'u'
      })
    ).toThrow(ValidationError);
  });

  it('validates delivery payloads', () => {
    const valid = validateDeliveryPayload({
      task_id: 'task-1',
      status: 'COMPLETED',
      summary: 'Done',
      modified_files: ['a.ts'],
      verification_passed: true
    });
    expect(valid.status).toBe('COMPLETED');

    expect(() =>
      validateDeliveryPayload({
        task_id: 'task-1',
        status: 'DONE',
        summary: 'Done',
        modified_files: [],
        verification_passed: true
      })
    ).toThrow(ValidationError);

    expect(() =>
      validateDeliveryPayload({
        task_id: 'task-1',
        status: 'COMPLETED',
        summary: 'Done',
        modified_files: 'a.ts',
        verification_passed: true
      })
    ).toThrow(ValidationError);
  });

  it('compares tokens without length leaks', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
  });
});
