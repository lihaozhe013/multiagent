import { OutputRingBuffer } from './watchdog.ts';

export interface GateResult {
  passed: boolean;
  failingCommand?: string;
  exitCode?: number;
  outputTail: string;
}

export async function runVerificationCommands(
  commands: string[],
  cwd: string,
  timeoutMs: number = 5 * 60 * 1000 // 5m per command default
): Promise<GateResult> {
  if (commands.length === 0) {
    return { passed: true, outputTail: 'No verification commands configured' };
  }

  const ringBuffer = new OutputRingBuffer(64 * 1024);

  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;

    ringBuffer.append(`\n--- Running verification: ${trimmed} ---\n`);

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const flag = isWindows ? '/c' : '-c';

    const startTime = Date.now();
    let proc;
    try {
      proc = Bun.spawn([shell, flag, trimmed], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ringBuffer.append(`Failed to spawn command: ${msg}\n`);
      return {
        passed: false,
        failingCommand: trimmed,
        exitCode: 1,
        outputTail: ringBuffer.getTail(),
      };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    clearTimeout(timer);

    if (stdout) ringBuffer.append(stdout);
    if (stderr) ringBuffer.append(stderr);

    if (timedOut) {
      ringBuffer.append(`\nCommand timed out after ${timeoutMs / 1000}s\n`);
      return {
        passed: false,
        failingCommand: trimmed,
        exitCode: 124,
        outputTail: ringBuffer.getTail(),
      };
    }

    const exitCode = proc.exitCode ?? 0;
    if (exitCode !== 0) {
      ringBuffer.append(`\nCommand failed with exit code ${exitCode} (duration: ${Date.now() - startTime}ms)\n`);
      return {
        passed: false,
        failingCommand: trimmed,
        exitCode,
        outputTail: ringBuffer.getTail(),
      };
    }
  }

  return {
    passed: true,
    outputTail: ringBuffer.getTail(),
  };
}
