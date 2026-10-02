/**
 * Per-bot durable state of the task-agent ingress: which session a task maps
 * to, which comments were already consumed, and which turns still owe the task
 * a reply. One small JSON file per bot under the session data dir.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { logger } from '../../utils/logger.js';

export interface PendingTaskTurn {
  sessionId: string;
  triggerId: string;
  startedAt: number;
}

export interface TaskAgentTaskState {
  /** Session that owns this task's conversation; follow-up comments append to it. */
  sessionId?: string;
  /** Comment ids already consumed (or written by this bot). */
  handledCommentIds: string[];
  /** Turns dispatched to the agent whose result has not been written back yet. */
  pending: PendingTaskTurn[];
  /** The task was refused (creator not authorized) and the refusal was posted. */
  denied?: boolean;
  updatedAt: number;
}

export interface TaskAgentStore {
  get(taskGuid: string): TaskAgentTaskState | undefined;
  /** Mutate (creating if absent) and persist. */
  update(taskGuid: string, mutate: (state: TaskAgentTaskState) => void): TaskAgentTaskState;
  /** Task guids that still have pending turns. */
  listPending(): string[];
}

const MAX_TRACKED_TASKS = 500;
const MAX_HANDLED_COMMENTS_PER_TASK = 500;

export function taskAgentStorePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, 'lark-task-agent', `${larkAppId}.json`);
}

export function createTaskAgentStore(filePath: string, now: () => number = Date.now): TaskAgentStore {
  let tasks: Record<string, TaskAgentTaskState> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed.tasks === 'object' && parsed.tasks) tasks = parsed.tasks;
    } catch (err) {
      logger.warn(`[task-agent] state file unreadable, starting empty: ${filePath}: ${err}`);
    }
  }

  function persist(): void {
    // Finished tasks only matter for follow-up comments; drop the oldest ones
    // once the file grows, never one that still owes a reply.
    const guids = Object.keys(tasks);
    if (guids.length > MAX_TRACKED_TASKS) {
      const evictable = guids
        .filter(guid => tasks[guid].pending.length === 0)
        .sort((a, b) => tasks[a].updatedAt - tasks[b].updatedAt);
      for (const guid of evictable.slice(0, guids.length - MAX_TRACKED_TASKS)) delete tasks[guid];
    }
    mkdirSync(dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, JSON.stringify({ version: 1, tasks }, null, 2));
  }

  return {
    get: taskGuid => tasks[taskGuid],
    update(taskGuid, mutate) {
      const state = tasks[taskGuid] ?? { handledCommentIds: [], pending: [], updatedAt: now() };
      mutate(state);
      if (state.handledCommentIds.length > MAX_HANDLED_COMMENTS_PER_TASK) {
        state.handledCommentIds = state.handledCommentIds.slice(-MAX_HANDLED_COMMENTS_PER_TASK);
      }
      state.updatedAt = now();
      tasks[taskGuid] = state;
      persist();
      return state;
    },
    listPending: () => Object.keys(tasks).filter(guid => tasks[guid].pending.length > 0),
  };
}
