import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Square,
  ListTodo,
  Terminal,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowUp,
  ArrowDown,
  Trash2,
  RefreshCw,
  Cpu,
  Sparkles,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';

interface Task {
  id: number;
  batch_id: string | null;
  title: string;
  description: string;
  agent_id: string;
  cwd: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' | 'FAILED';
  rank: number;
  verify_commands: string[];
  max_retries: number;
  retry_count: number;
  current_stage: 'CODER' | 'TEST' | 'REVIEW' | 'IDLE';
  result_summary: string | null;
  error_tail: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface QueueState {
  id: number;
  state: 'IDLE' | 'RUNNING' | 'PAUSED';
  paused_reason: string | null;
  active_task_id: number | null;
  active_stage: 'CODER' | 'TEST' | 'REVIEW' | 'IDLE' | null;
  updated_at: string;
}

interface LogEntry {
  id: string;
  timestamp: number;
  type: string;
  content: string;
  stage?: string;
  taskId?: number;
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [queueState, setQueueState] = useState<QueueState>({
    id: 1,
    state: 'IDLE',
    paused_reason: null,
    active_task_id: null,
    active_stage: 'IDLE',
    updated_at: '',
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [batchInput, setBatchInput] = useState('');
  const [batchCwd, setBatchCwd] = useState('/tmp');
  const [batchAgent, setBatchAgent] = useState('pi');
  const [autoScroll, setAutoScroll] = useState(true);

  const logsEndRef = useRef<HTMLDivElement>(null);

  // Initial fetch
  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      const data = (await res.json()) as { tasks?: Task[] };
      if (data.tasks) setTasks(data.tasks);
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    }
  };

  const fetchQueue = async () => {
    try {
      const res = await fetch('/api/queue');
      const data = (await res.json()) as { state?: QueueState };
      if (data.state) setQueueState(data.state);
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    }
  };

  // Connect to SSE stream
  useEffect(() => {
    fetchTasks();
    fetchQueue();

    const eventSource = new EventSource('/api/stream');

    eventSource.addEventListener('init', (e: Event) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.queue) setQueueState(data.queue);
        if (data.tasks) setTasks(data.tasks);
      } catch (err) {
        console.error('Error handling SSE init:', err);
      }
    });

    eventSource.addEventListener('queue_state', (e: Event) => {
      try {
        const state = JSON.parse((e as MessageEvent).data);
        setQueueState(state);
        fetchTasks();
      } catch (err) {
        console.error('Error handling SSE queue_state:', err);
      }
    });

    eventSource.addEventListener('task_created', () => {
      fetchTasks();
    });

    eventSource.addEventListener('task_updated', () => {
      fetchTasks();
    });

    eventSource.addEventListener('task_deleted', () => {
      fetchTasks();
    });

    eventSource.addEventListener('batch_created', () => {
      fetchTasks();
    });

    eventSource.addEventListener('agent_event', (e: Event) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data);
        const newLog: LogEntry = {
          id: Math.random().toString(36).substring(2, 9),
          timestamp: ev.timestamp ?? Date.now(),
          type: ev.type ?? 'stdout',
          content: ev.content ?? '',
          stage: ev.stage,
          taskId: ev.taskId,
        };
        setLogs((prev) => [...prev.slice(-500), newLog]);
      } catch (err) {
        console.error('Error parsing agent_event:', err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, []);

  // Auto scroll logs
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleQueueControl = async (action: 'start' | 'pause' | 'resume' | 'stop') => {
    try {
      await fetch('/api/queue/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      fetchQueue();
      fetchTasks();
    } catch (err) {
      console.error(`Queue control failed:`, err);
    }
  };

  const handleRetryTask = async (id: number) => {
    try {
      await fetch(`/api/tasks/${id}/retry`, { method: 'POST' });
      fetchTasks();
    } catch (err) {
      console.error('Failed to retry task:', err);
    }
  };

  const handleDeleteTask = async (id: number) => {
    if (!confirm('Are you sure you want to delete this task?')) return;
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      fetchTasks();
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const handleMoveTask = async (id: number, direction: 'up' | 'down') => {
    const pending = tasks.filter((t) => t.status === 'PENDING');
    const idx = pending.findIndex((t) => t.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === pending.length - 1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    const current = pending[idx]!;
    const neighbor = pending[targetIdx]!;

    pending[idx] = neighbor;
    pending[targetIdx] = current;

    const orderedIds = pending.map((t) => t.id);
    try {
      await fetch('/api/tasks/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
      fetchTasks();
    } catch (err) {
      console.error('Failed to reorder tasks:', err);
    }
  };

  const handleBatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchInput.trim()) return;

    try {
      const res = await fetch('/api/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInput: batchInput,
          cwd: batchCwd,
          agentId: batchAgent,
        }),
      });
      if (res.ok) {
        setIsBatchModalOpen(false);
        setBatchInput('');
        fetchTasks();
        fetchQueue();
      }
    } catch (err) {
      console.error('Failed to submit batch:', err);
    }
  };

  const activeTask = tasks.find((t) => t.status === 'IN_PROGRESS');
  const filteredTasks = tasks.filter((t) => {
    if (filterStatus === 'ALL') return true;
    if (filterStatus === 'BLOCKED_OR_FAILED') return t.status === 'BLOCKED' || t.status === 'FAILED';
    return t.status === filterStatus;
  });

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-sans">
      {/* Top Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur z-20">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
            <Cpu className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold tracking-tight text-lg text-white">Night-Shift</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-300 border border-indigo-700/50">
                SERIAL VIBE CODING
              </span>
            </div>
            <p className="text-xs text-slate-400">Headless Unattended Multi-Agent Orchestrator</p>
          </div>
        </div>

        {/* Global Controls & Status */}
        <div className="flex items-center gap-3">
          {/* Status Badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-slate-800 bg-slate-900 text-xs font-medium">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                queueState.state === 'RUNNING'
                  ? 'bg-emerald-400 animate-ping'
                  : queueState.state === 'PAUSED'
                  ? 'bg-amber-400'
                  : 'bg-slate-500'
              }`}
            />
            <span className="text-slate-300">Queue:</span>
            <span
              className={`font-semibold ${
                queueState.state === 'RUNNING'
                  ? 'text-emerald-400'
                  : queueState.state === 'PAUSED'
                  ? 'text-amber-400'
                  : 'text-slate-400'
              }`}
            >
              {queueState.state}
            </span>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-1 gap-1">
            {queueState.state !== 'RUNNING' ? (
              <button
                onClick={() => handleQueueControl('start')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded transition shadow-sm"
              >
                <Play className="w-3.5 h-3.5" /> Start
              </button>
            ) : (
              <button
                onClick={() => handleQueueControl('pause')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded transition"
              >
                <Pause className="w-3.5 h-3.5" /> Pause
              </button>
            )}

            {queueState.state === 'PAUSED' && (
              <button
                onClick={() => handleQueueControl('resume')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded transition"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Resume
              </button>
            )}

            <button
              onClick={() => handleQueueControl('stop')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-red-900/60 text-slate-300 hover:text-red-200 rounded transition"
            >
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
          </div>

          {/* Nightly Intake Button */}
          <button
            onClick={() => setIsBatchModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-lg shadow-md transition"
          >
            <Sparkles className="w-3.5 h-3.5" /> Nightly Intake
          </button>
        </div>
      </header>

      {/* Active Run Banner (Micro-Pipeline Status) */}
      {activeTask && (
        <div className="bg-indigo-950/40 border-b border-indigo-900/50 px-6 py-2.5 flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
            </span>
            <span className="font-semibold text-indigo-300">Running Task #{activeTask.id}:</span>
            <span className="text-white font-medium">{activeTask.title}</span>
            <span className="font-mono bg-indigo-900/60 text-indigo-200 px-2 py-0.5 rounded text-[11px] border border-indigo-700/50">
              Agent: {activeTask.agent_id}
            </span>
            <span className="text-slate-400">
              Attempt {activeTask.retry_count + 1} of {activeTask.max_retries + 1}
            </span>
          </div>

          {/* Stage Breadcrumb */}
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded border ${
                activeTask.current_stage === 'CODER'
                  ? 'bg-indigo-600 text-white border-indigo-400 shadow-sm animate-pulse'
                  : 'bg-slate-900/80 text-slate-400 border-slate-800'
              }`}
            >
              <span>1. Coder</span>
            </div>
            <ChevronRight className="w-3 h-3 text-slate-600" />
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded border ${
                activeTask.current_stage === 'TEST'
                  ? 'bg-amber-600 text-white border-amber-400 shadow-sm animate-pulse'
                  : 'bg-slate-900/80 text-slate-400 border-slate-800'
              }`}
            >
              <span>2. Test Gate</span>
            </div>
            <ChevronRight className="w-3 h-3 text-slate-600" />
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded border ${
                activeTask.current_stage === 'REVIEW'
                  ? 'bg-purple-600 text-white border-purple-400 shadow-sm animate-pulse'
                  : 'bg-slate-900/80 text-slate-400 border-slate-800'
              }`}
            >
              <span>3. Review</span>
            </div>
          </div>
        </div>
      )}

      {/* Main Workspace (Split View) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Task Queue */}
        <div className="w-1/2 flex flex-col border-r border-slate-800 bg-slate-900/40">
          {/* Filter Bar */}
          <div className="flex items-center justify-between p-3 border-b border-slate-800 bg-slate-900/60">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              {['ALL', 'PENDING', 'DONE', 'BLOCKED_OR_FAILED'].map((st) => (
                <button
                  key={st}
                  onClick={() => setFilterStatus(st)}
                  className={`px-2.5 py-1 rounded-md transition ${
                    filterStatus === st
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {st === 'BLOCKED_OR_FAILED' ? 'Blocked / Failed' : st}
                </button>
              ))}
            </div>
            <span className="text-xs text-slate-500 font-mono">
              Total: {tasks.length} tasks
            </span>
          </div>

          {/* Tasks List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {filteredTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-xs">
                <ListTodo className="w-8 h-8 mb-2 stroke-1" />
                <p>No tasks in this view.</p>
                <p className="mt-1">Click "Nightly Intake" to batch decompose a backlog!</p>
              </div>
            ) : (
              filteredTasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => setSelectedTask(task)}
                  className={`group p-3.5 rounded-xl border transition cursor-pointer ${
                    task.status === 'IN_PROGRESS'
                      ? 'bg-indigo-950/30 border-indigo-500/50 shadow-md ring-1 ring-indigo-500/20'
                      : selectedTask?.id === task.id
                      ? 'bg-slate-800/80 border-slate-600'
                      : 'bg-slate-900/70 border-slate-800 hover:border-slate-700 hover:bg-slate-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 flex-1 min-w-0">
                      {/* Status Icon */}
                      <div className="mt-0.5">
                        {task.status === 'DONE' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                        {task.status === 'IN_PROGRESS' && <RefreshCw className="w-4 h-4 text-indigo-400 animate-spin" />}
                        {task.status === 'BLOCKED' && <ShieldAlert className="w-4 h-4 text-amber-400" />}
                        {task.status === 'FAILED' && <XCircle className="w-4 h-4 text-red-400" />}
                        {task.status === 'PENDING' && <Clock className="w-4 h-4 text-slate-500" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-slate-400">#{task.id}</span>
                          <h3 className="text-sm font-medium text-slate-200 truncate group-hover:text-white">
                            {task.title}
                          </h3>
                        </div>

                        {task.description && (
                          <p className="text-xs text-slate-400 line-clamp-1 mt-1 font-mono">
                            {task.description}
                          </p>
                        )}

                        <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                            {task.agent_id}
                          </span>
                          {task.verify_commands.length > 0 && (
                            <span className="text-slate-400">
                              {task.verify_commands.length} verify cmd(s)
                            </span>
                          )}
                          {task.retry_count > 0 && (
                            <span className="text-amber-400">
                              Retried {task.retry_count}x
                            </span>
                          )}
                          <span className="truncate max-w-[150px]">{task.cwd}</span>
                        </div>
                      </div>
                    </div>

                    {/* Quick Row Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                      {task.status === 'PENDING' && (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveTask(task.id, 'up');
                            }}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white"
                            title="Move Up"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveTask(task.id, 'down');
                            }}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white"
                            title="Move Down"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}

                      {(task.status === 'BLOCKED' || task.status === 'FAILED') && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRetryTask(task.id);
                          }}
                          className="p-1 hover:bg-slate-800 rounded text-indigo-400 hover:text-indigo-300"
                          title="Retry"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {task.status !== 'IN_PROGRESS' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteTask(task.id);
                          }}
                          className="p-1 hover:bg-red-900/40 rounded text-slate-500 hover:text-red-400"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Column: Live Terminal & Thinking Output */}
        <div className="w-1/2 flex flex-col bg-black/60 font-mono">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800 bg-slate-900/70">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <Terminal className="w-4 h-4 text-indigo-400" />
              <span>Live Terminal & Thinking Stream</span>
              <span className="text-[10px] text-slate-500">({logs.length} lines)</span>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer text-slate-400 hover:text-slate-300">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="rounded bg-slate-800 border-slate-700 text-indigo-600 focus:ring-0"
                />
                Auto-scroll
              </label>
              <button
                onClick={() => setLogs([])}
                className="text-slate-500 hover:text-slate-300 text-xs"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 text-xs space-y-1 select-text">
            {logs.length === 0 ? (
              <div className="text-slate-600 italic">No output yet. Queue events and agent logs will stream here live.</div>
            ) : (
              logs.map((log) => {
                let color = 'text-slate-300';
                if (log.type === 'error') color = 'text-red-400';
                else if (log.type === 'tool_call') color = 'text-amber-300';
                else if (log.type === 'thinking') color = 'text-purple-300';
                else if (log.content.includes('=== Starting Stage:')) color = 'text-emerald-400 font-bold';

                return (
                  <div key={log.id} className="leading-relaxed break-words whitespace-pre-wrap">
                    <span className="text-slate-600 text-[10px] mr-2">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    {log.stage && (
                      <span className="text-indigo-400 text-[10px] mr-2 px-1 rounded bg-indigo-950/60 border border-indigo-900/50">
                        [{log.stage}]
                      </span>
                    )}
                    <span className={color}>{log.content}</span>
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>

      {/* Nightly Batch Intake Modal */}
      {isBatchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <h2 className="text-lg font-semibold text-white">Nightly Intake Backlog</h2>
              </div>
              <button
                onClick={() => setIsBatchModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleBatchSubmit} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Target Project Directory (cwd)
                </label>
                <input
                  type="text"
                  value={batchCwd}
                  onChange={(e) => setBatchCwd(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  placeholder="/home/username/dev/my-project"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Default Agent CLI
                </label>
                <select
                  value={batchAgent}
                  onChange={(e) => setBatchAgent(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                >
                  <option value="pi">pi (Pi Coding Agent)</option>
                  <option value="opencode">opencode (OpenCode Agent)</option>
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-300">
                    Improvement Plan / Task List (Markdown)
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setBatchInput(
                        `# Nightly Sprint\n- [ ] Refactor auth tokens: replace JWT secret with rotate key (test: bun test)\n- [ ] Add dark mode theme support [agent: opencode]\n- [ ] Clean up unused database indexes (verify: bun run typecheck)`
                      );
                    }}
                    className="text-xs text-indigo-400 hover:text-indigo-300 underline"
                  >
                    Load Sample Checklist
                  </button>
                </div>
                <textarea
                  rows={8}
                  value={batchInput}
                  onChange={(e) => setBatchInput(e.target.value)}
                  className="w-full p-3 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  placeholder="- [ ] Task 1 description (verify: bun test)&#10;- [ ] Task 2 description [agent: opencode]"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Tips: Use <code>- [ ]</code> or headers. Add <code>(verify: command)</code> for tests and <code>[agent: opencode]</code> for specific CLIs.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsBatchModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg shadow transition"
                >
                  Decompose & Enqueue Batch
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
