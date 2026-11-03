import type { Subprocess } from 'bun';
import type { AgentAdapter, AgentRunOptions, AgentExecutionResult, AdapterReadiness } from './types.ts';
import type { AgentEvent } from '../types/index.ts';
import { OutputRingBuffer, killProcessTreeWithEscalation } from '../core/watchdog.ts';

export class PiAdapter implements AgentAdapter {
  public readonly id = 'pi';
  public readonly name = 'Pi Coding Agent';

  private activeProcesses = new Map<number, Subprocess>();
  private readonly executable: string;

  constructor(executable: string = 'pi') {
    this.executable = executable;
  }

  public async checkReadiness(): Promise<AdapterReadiness> {
    try {
      const proc = Bun.spawn([this.executable, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        return { ok: false, error: `Exited with code ${exitCode}` };
      }
      const version = (await new Response(proc.stdout).text()).trim();
      return { ok: true, version, executablePath: this.executable };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async execute(
    options: AgentRunOptions,
    onEvent?: (event: AgentEvent) => void
  ): Promise<AgentExecutionResult> {
    const startTime = Date.now();
    const ringBuffer = new OutputRingBuffer(64 * 1024);

    const args: string[] = [
      this.executable,
      '--mode',
      'json',
      '-p',
      '--no-approve',
      '--name',
      `T${options.taskId}-${options.stage}: ${options.title}`,
    ];

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }

    // Append the prompt at the end
    args.push(options.prompt);

    let proc: Subprocess;
    try {
      proc = Bun.spawn(args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        summary: `Failed to spawn pi CLI: ${msg}`,
        rawTail: msg,
        durationMs: Date.now() - startTime,
        error: msg,
      };
    }

    this.activeProcesses.set(options.runId, proc);

    let summaryText = '';
    const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000; // 20m default

    // Set up timeout watchdog
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      void killProcessTreeWithEscalation(proc);
    }, timeoutMs);

    try {
      // Process stdout line by line
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let residual = '';

      const readStdout = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = residual + decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          residual = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            ringBuffer.append(line + '\n');

            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
              try {
                const record = JSON.parse(trimmed);
                this.parseAndEmitPiEvent(record, onEvent, (summary) => {
                  summaryText = summary;
                });
              } catch {
                onEvent?.({
                  type: 'stdout',
                  timestamp: Date.now(),
                  content: trimmed,
                });
              }
            } else {
              onEvent?.({
                type: 'stdout',
                timestamp: Date.now(),
                content: trimmed,
              });
            }
          }
        }
      };

      // Process stderr
      const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const readStderr = async () => {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          ringBuffer.append(text);
          onEvent?.({
            type: 'stderr',
            timestamp: Date.now(),
            content: text,
          });
        }
      };

      await Promise.all([readStdout(), readStderr(), proc.exited]);

      const exitCode = proc.exitCode ?? 0;
      clearTimeout(timeoutTimer);

      if (timedOut) {
        return {
          exitCode: 124, // standard timeout exit code
          summary: `Task execution timed out after ${timeoutMs / 1000}s`,
          rawTail: ringBuffer.getTail(),
          durationMs: Date.now() - startTime,
          error: 'Execution timed out',
        };
      }

      return {
        exitCode,
        summary: summaryText || (exitCode === 0 ? 'Execution completed successfully' : `Process exited with code ${exitCode}`),
        rawTail: ringBuffer.getTail(),
        durationMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutTimer);
      this.activeProcesses.delete(options.runId);
    }
  }

  public async abort(runId: number): Promise<void> {
    const proc = this.activeProcesses.get(runId);
    if (proc) {
      await killProcessTreeWithEscalation(proc);
      this.activeProcesses.delete(runId);
    }
  }

  private parseAndEmitPiEvent(
    record: Record<string, unknown>,
    onEvent?: (event: AgentEvent) => void,
    onSummary?: (summary: string) => void
  ): void {
    const type = String(record['type'] ?? '');
    const now = Date.now();

    if (type === 'message' || type === 'message_start' || type === 'message_delta') {
      const msg = record['message'] as Record<string, unknown> | undefined;
      const content = msg?.['content'];
      if (typeof content === 'string' && content.length > 0) {
        onSummary?.(content);
        onEvent?.({
          type: 'thinking',
          timestamp: now,
          content,
        });
      }
    } else if (type === 'tool_call' || type === 'toolUse') {
      onEvent?.({
        type: 'tool_call',
        timestamp: now,
        content: `Tool: ${String(record['name'] ?? record['toolName'] ?? 'unknown')}`,
        metadata: record,
      });
    } else if (type === 'agent_settled') {
      onEvent?.({
        type: 'stdout',
        timestamp: now,
        content: 'Agent settled',
      });
    }
  }
}
