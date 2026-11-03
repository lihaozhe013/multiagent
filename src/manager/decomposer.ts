import { QueueController } from '../core/queue.ts';

export interface DecomposedTaskItem {
  title: string;
  description: string;
  cwd?: string;
  agent_id?: string;
  verify_commands?: string[];
  max_retries?: number;
}

export class TaskDecomposer {
  private queue: QueueController;

  constructor(queue: QueueController) {
    this.queue = queue;
  }

  /**
   * Parses markdown checklist or headers into structured tasks deterministically.
   */
  public parseMarkdownBacklog(
    markdown: string,
    defaultCwd: string,
    defaultAgentId: string = 'pi'
  ): DecomposedTaskItem[] {
    const lines = markdown.split('\n');
    const tasks: DecomposedTaskItem[] = [];

    let currentTask: DecomposedTaskItem | null = null;
    let descriptionLines: string[] = [];

    const flushCurrent = () => {
      if (currentTask) {
        currentTask.description = descriptionLines.join('\n').trim() || currentTask.title;
        tasks.push(currentTask);
        currentTask = null;
        descriptionLines = [];
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Check for Markdown list item: - [ ] Task title or - Task title or 1. Task title
      const todoMatch = line.match(/^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.*)$/);
      // Check for Header: ## Task title (level 2-4 headers, ignoring level 1 document title)
      const headerMatch = line.match(/^#{2,4}\s+(.*)$/);

      if (todoMatch?.[1] || headerMatch?.[1]) {
        flushCurrent();

        const rawTitle = todoMatch?.[1] ?? headerMatch?.[1];
        if (!rawTitle) continue;
        const titleCandidate = rawTitle.trim();
        if (!titleCandidate) continue;

        // Extract verify commands if specified inline, e.g. "(verify: bun test)" or "(test: npm test)"
        let verifyCommands: string[] = [];
        let cleanTitle = titleCandidate;

        const verifyMatch = titleCandidate.match(/\((?:verify|test):\s*([^)]+)\)/i);
        if (verifyMatch?.[1]) {
          verifyCommands = verifyMatch[1].split(';').map((c) => c.trim()).filter(Boolean);
          cleanTitle = titleCandidate.replace(verifyMatch[0], '').trim();
        }

        // Extract agent if specified, e.g. "[agent: opencode]"
        let assignedAgent = defaultAgentId;
        const agentMatch = cleanTitle.match(/\[agent:\s*([a-zA-Z0-9_-]+)\]/i);
        if (agentMatch?.[1]) {
          assignedAgent = agentMatch[1].toLowerCase();
          cleanTitle = cleanTitle.replace(agentMatch[0], '').trim();
        }

        currentTask = {
          title: cleanTitle,
          description: '',
          cwd: defaultCwd,
          agent_id: assignedAgent,
          verify_commands: verifyCommands,
          max_retries: 3,
        };
      } else if (currentTask) {
        descriptionLines.push(rawLine);
      }
    }

    flushCurrent();
    return tasks;
  }

  /**
   * Enqueues a batch of decomposed tasks into SQLite atomically.
   */
  public enqueueBatch(
    batchId: string,
    rawInput: string,
    tasks: DecomposedTaskItem[],
    defaultCwd: string
  ): void {
    const db = (this.queue as unknown as { db: import('bun:sqlite').Database }).db;
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      db.run(
        'INSERT INTO batches (id, raw_input, status, created_at) VALUES (?, ?, ?, ?)',
        [batchId, rawInput, 'RUNNING', now]
      );

      for (const item of tasks) {
        this.queue.createTask({
          batch_id: batchId,
          title: item.title,
          description: item.description,
          cwd: item.cwd ?? defaultCwd,
          agent_id: item.agent_id ?? 'pi',
          verify_commands: item.verify_commands ?? [],
          max_retries: item.max_retries ?? 3,
        });
      }
    });

    tx();
  }
}
