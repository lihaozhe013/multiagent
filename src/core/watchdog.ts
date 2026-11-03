import type { Subprocess } from 'bun';

export class OutputRingBuffer {
  private buffer: string[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = 64 * 1024) {
    this.maxBytes = maxBytes;
  }

  public append(text: string): void {
    if (!text) return;
    this.buffer.push(text);
    this.totalBytes += Buffer.byteLength(text, 'utf8');

    while (this.totalBytes > this.maxBytes && this.buffer.length > 1) {
      const removed = this.buffer.shift();
      if (removed) {
        this.totalBytes -= Buffer.byteLength(removed, 'utf8');
      }
    }
  }

  public getTail(): string {
    return this.buffer.join('');
  }

  public clear(): void {
    this.buffer = [];
    this.totalBytes = 0;
  }
}

export async function killProcessTree(
  proc: Subprocess,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
  detached: boolean = false
): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;

  if (detached) {
    // The child was spawned as a process-group leader. A negative PID targets
    // the entire group, including grandchildren.
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to the direct process kill below.
    }
  }

  try {
    // Attempt to kill child processes first (POSIX pkill)
    const pkill = Bun.spawn(['pkill', signal === 'SIGKILL' ? '-9' : '-15', '-P', String(pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await pkill.exited;
  } catch {
    // Ignore pkill errors if no children
  }

  try {
    proc.kill(signal);
  } catch {
    // Ignore if already dead
  }
}

export async function killProcessTreeWithEscalation(
  proc: Subprocess,
  gracePeriodMs: number = 3000,
  detached: boolean = false
): Promise<void> {
  await killProcessTree(proc, 'SIGTERM', detached);

  const timeoutPromise = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), gracePeriodMs));
  const exitedPromise = proc.exited.then(() => true);

  const cleanExit = await Promise.race([timeoutPromise, exitedPromise]);
  if (!cleanExit) {
    await killProcessTree(proc, 'SIGKILL', detached);
  }
}
