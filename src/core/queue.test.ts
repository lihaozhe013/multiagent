import { describe, it, expect, beforeEach } from 'bun:test';
import { StorageEngine, TaskLockedError, QueueBusyError } from './store.ts';
import { QueueController } from './queue.ts';

describe('QueueController', () => {
  let storage: StorageEngine;
  let queue: QueueController;

  beforeEach(() => {
    storage = new StorageEngine(':memory:');
    queue = new QueueController(storage);
  });

  it('creates tasks with incremental ranks and parses JSON verify commands', () => {
    const task1 = queue.createTask({
      title: 'First Task',
      description: 'Do first thing',
      cwd: '/tmp/test',
      verify_commands: ['bun test', 'echo ok'],
    });

    const task2 = queue.createTask({
      title: 'Second Task',
      description: 'Do second thing',
      cwd: '/tmp/test',
    });

    expect(task1.id).toBe(1);
    expect(task1.rank).toBe(10);
    expect(task1.verify_commands).toEqual(['bun test', 'echo ok']);
    expect(task1.status).toBe('PENDING');

    expect(task2.id).toBe(2);
    expect(task2.rank).toBe(20);
    expect(task2.verify_commands).toEqual([]);
  });

  it('atomically claims next pending task and protects against concurrent runs', () => {
    queue.createTask({ title: 'Task 1', description: 'Desc 1', cwd: '/tmp' });
    queue.createTask({ title: 'Task 2', description: 'Desc 2', cwd: '/tmp' });

    const claimed = queue.claimNext();
    expect(claimed).not.toBeNull();
    expect(claimed!.task.id).toBe(1);
    expect(claimed!.task.status).toBe('IN_PROGRESS');
    expect(claimed!.token).toBeDefined();

    const qState = queue.getQueueState();
    expect(qState.state).toBe('RUNNING');
    expect(qState.active_task_id).toBe(1);

    // Attempting to claim again while task 1 is running throws QueueBusyError
    expect(() => queue.claimNext()).toThrow(QueueBusyError);
  });

  it('locks running tasks against edits and deletions', () => {
    queue.createTask({ title: 'Task 1', description: 'Desc', cwd: '/tmp' });
    queue.claimNext();

    expect(() => queue.updateTask(1, { title: 'New Title' })).toThrow(TaskLockedError);
    expect(() => queue.deleteTask(1)).toThrow(TaskLockedError);
  });

  it('settles running task to DONE and allows claiming next task', () => {
    queue.createTask({ title: 'Task 1', description: 'Desc 1', cwd: '/tmp' });
    queue.createTask({ title: 'Task 2', description: 'Desc 2', cwd: '/tmp' });

    const claim1 = queue.claimNext()!;
    const settled = queue.settle(claim1.task.id, claim1.token, {
      status: 'DONE',
      result_summary: 'All tests passed',
    });

    expect(settled.status).toBe('DONE');
    expect(settled.result_summary).toBe('All tests passed');
    expect(queue.getQueueState().active_task_id).toBeNull();

    // Now task 2 can be claimed
    const claim2 = queue.claimNext()!;
    expect(claim2.task.id).toBe(2);
  });

  it('supports looping retry and run history logging', () => {
    queue.createTask({ title: 'Task with loop', description: 'Desc', cwd: '/tmp' });
    const claim = queue.claimNext()!;

    queue.recordRun({
      taskId: claim.task.id,
      attempt: 1,
      stage: 'TEST',
      agentId: 'pi',
      status: 'FAILED',
      feedback: 'Assertion error in foo.test.ts',
      startedAt: new Date().toISOString(),
    });

    const newRetry = queue.incrementRetry(claim.task.id, claim.token, 'Fix test assertions');
    expect(newRetry).toBe(1);

    const updatedTask = queue.getTask(claim.task.id)!;
    expect(updatedTask.retry_count).toBe(1);
    expect(updatedTask.error_tail).toBe('Fix test assertions');

    const runs = queue.listRuns(claim.task.id);
    expect(runs.length).toBe(1);
    expect(runs[0]?.feedback).toBe('Assertion error in foo.test.ts');
  });

  it('recovers interrupted tasks on startup', () => {
    queue.createTask({ title: 'Interrupted Task', description: 'Desc', cwd: '/tmp' });
    queue.claimNext();

    const recoveredCount = queue.recoverInterrupted();
    expect(recoveredCount).toBe(1);

    const task = queue.getTask(1)!;
    expect(task.status).toBe('BLOCKED');
    expect(task.result_summary).toContain('orchestrator restarted');
    expect(queue.getQueueState().active_task_id).toBeNull();
  });

  it('reorders pending tasks cleanly', () => {
    const t1 = queue.createTask({ title: 'Task 1', description: '', cwd: '/tmp' });
    const t2 = queue.createTask({ title: 'Task 2', description: '', cwd: '/tmp' });
    const t3 = queue.createTask({ title: 'Task 3', description: '', cwd: '/tmp' });

    // Reverse order: 3, 2, 1
    queue.reorderPending([t3.id, t2.id, t1.id]);

    const tasks = queue.listTasks({ status: 'PENDING' });
    expect(tasks[0]?.id).toBe(t3.id);
    expect(tasks[0]?.rank).toBe(10);
    expect(tasks[1]?.id).toBe(t2.id);
    expect(tasks[1]?.rank).toBe(20);
    expect(tasks[2]?.id).toBe(t1.id);
    expect(tasks[2]?.rank).toBe(30);
  });
});
