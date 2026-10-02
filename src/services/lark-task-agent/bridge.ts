/**
 * Lark Task ingress ("任务智能体").
 *
 * A bot registered as a task agent can be made the assignee of a Lark task.
 * This bridge turns that into an ordinary programmatic turn:
 *
 *   task assigned to the bot      → fresh async virtual session (one per task)
 *   authorized comment on the task → follow-up turn on that same session
 *   turn finished                 → final output posted as a task comment,
 *                                   agent status moved to done / waiting
 *
 * It deliberately reuses the `/api/trigger` machinery (async virtual sessions,
 * idempotency leases, durable results) instead of adding another session
 * flavour to the daemon: the only thing the daemon contributes is the event.
 *
 * Task events carry nothing but the task guid, so every decision re-reads the
 * task or its comments as the bot. The bot's own writes come back as events
 * too (its comments fire `task_comment_create`); app-authored comments are
 * therefore never treated as input.
 */
import type { TriggerRequest, TriggerResponse } from '../trigger-types.js';
import { logger } from '../../utils/logger.js';
import { AGENT_TASK_STATUS, type LarkTask, type LarkTaskApi, type LarkTaskComment } from './api.js';
import type { PendingTaskTurn, TaskAgentStore } from './store.js';

/** The agent starts its reply with this when it needs the assigner to decide. */
export const WAITING_FOR_HUMAN_MARK = '【待确认】';

const START_EVENTS = new Set(['task_create', 'task_assignees_update']);
const COMMENT_EVENTS = new Set(['task_comment_create', 'task_comment_reply']);

/** Lark rejects comments beyond ~3000 chars / 10000 bytes. */
const COMMENT_CHUNK_CHARS = 2800;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_TURN_AGE_MS = 12 * 60 * 60 * 1000;
/** The first `register_agent` call for an app has been seen to answer 500
 *  (code 2200) and then succeed moments later. */
const REGISTER_ATTEMPTS = 3;
const REGISTER_RETRY_MS = 5_000;

export interface TaskAgentDeps {
  larkAppId: string;
  api: LarkTaskApi;
  store: TaskAgentStore;
  trigger: (req: TriggerRequest) => Promise<TriggerResponse>;
  lookup: (sessionId: string, triggerId: string) => TriggerResponse;
  /** Whether this open_id may hand work to the bot. */
  canOperate: (openId: string) => boolean;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TaskEvent {
  taskGuid: string;
  eventTypes: string[];
}

export function chunkCommentText(text: string, limit = COMMENT_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const newline = rest.lastIndexOf('\n', limit);
    const cut = newline > limit / 2 ? newline : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const REPLY_RULES = [
  '要求：',
  '- 你的最终回复会原样作为评论发到这条任务下，指派人在任务里看结果。只写给指派人看的结论，不写过程。',
  `- 需要指派人做决定或补充信息才能继续时，回复以「${WAITING_FOR_HUMAN_MARK}」开头，并写清要确认什么。`,
  '- 不要自己调用 Lark 任务接口去改这条任务的状态或评论。',
].join('\n');

export function buildTaskInstruction(task: LarkTask, latestComments: LarkTaskComment[] = []): string {
  const lines = [
    '你被指派了一条 Lark 任务，请完成它。',
    '',
    `任务标题：${task.summary || '（无标题）'}`,
  ];
  if (task.description.trim()) lines.push('任务描述：', task.description.trim());
  if (latestComments.length > 0) {
    lines.push('', '指派人在任务下的最新评论（以它为准）：', ...latestComments.map(c => c.content.trim()));
  }
  lines.push('', REPLY_RULES);
  return lines.join('\n');
}

export function buildFollowUpInstruction(comments: LarkTaskComment[]): string {
  return [
    '指派人在这条 Lark 任务下追加了评论，请据此继续：',
    '',
    ...comments.map(c => c.content.trim()),
    '',
    REPLY_RULES,
  ].join('\n');
}

export class LarkTaskAgent {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly deliveryAttempts = new Map<string, number>();
  /** Chunks of a reply already posted, so a retry never repeats them. */
  private readonly deliveredChunks = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(private readonly deps: TaskAgentDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Register the bot as a task agent and resume turns left pending by a restart. */
  async start(): Promise<void> {
    this.ensurePolling();
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }));
    for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
      try {
        await this.deps.api.register();
        logger.info(`[task-agent] ${this.deps.larkAppId} registered as Lark task agent`);
        return;
      } catch (err) {
        if (attempt < REGISTER_ATTEMPTS) {
          logger.info(`[task-agent] ${this.deps.larkAppId} registration attempt ${attempt} failed (${err}); retrying`);
          await sleep(REGISTER_RETRY_MS * attempt);
          continue;
        }
        logger.warn(
          `[task-agent] ${this.deps.larkAppId} registration failed: ${err}. `
          + `需要机器人权限 task:task:read/write、task:comment:read/write，并订阅事件 task.task.update_user_access_v2。`,
        );
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Events for one task are handled strictly in arrival order. */
  handleEvent(event: TaskEvent): Promise<void> {
    const previous = this.queues.get(event.taskGuid) ?? Promise.resolve();
    const next = previous
      .then(() => this.process(event))
      .catch(err => logger.error(`[task-agent] task ${event.taskGuid} event failed: ${err}`))
      .finally(() => {
        if (this.queues.get(event.taskGuid) === next) this.queues.delete(event.taskGuid);
      });
    this.queues.set(event.taskGuid, next);
    return next;
  }

  private async process(event: TaskEvent): Promise<void> {
    const state = this.deps.store.get(event.taskGuid);
    if (state?.denied) return;
    if (event.eventTypes.some(type => COMMENT_EVENTS.has(type))) {
      await this.handleComments(event.taskGuid);
    } else if (event.eventTypes.some(type => START_EVENTS.has(type)) && !state?.sessionId) {
      await this.startTask(event.taskGuid);
    }
  }

  private isAssignee(task: LarkTask): boolean {
    return task.members.some(m => m.role === 'assignee' && m.type === 'app' && m.id === this.deps.larkAppId);
  }

  private isAuthorizedUser(actor: { id: string; type?: string } | undefined): boolean {
    return actor?.type === 'user' && this.deps.canOperate(actor.id);
  }

  private async startTask(taskGuid: string): Promise<void> {
    const task = await this.deps.api.getTask(taskGuid);
    if (!this.isAssignee(task)) return;
    if (task.status === 'done') return;
    // Someone (an earlier run, another integration) already moved it along.
    if (task.agentTaskStatus !== undefined && task.agentTaskStatus !== AGENT_TASK_STATUS.notStarted) return;

    if (!this.isAuthorizedUser(task.creator)) {
      logger.warn(`[task-agent] task ${taskGuid} refused: creator ${task.creator?.id ?? '?'} is not an allowed user`);
      const commentId = await this.deps.api.createComment(
        taskGuid,
        '这条任务没有执行：只有本 Bot 的授权用户创建的任务才会交给智能体处理。',
      );
      this.deps.store.update(taskGuid, s => {
        s.denied = true;
        if (commentId) s.handledCommentIds.push(commentId);
      });
      return;
    }

    // Comments that already exist are context, not new instructions to replay.
    const comments = await this.deps.api.listComments(taskGuid);
    const authored = comments.filter(c => this.isAuthorizedUser(c.creator));
    this.deps.store.update(taskGuid, s => {
      s.handledCommentIds.push(...comments.map(c => c.id));
    });
    await this.dispatchFresh(task, authored, `lark-task:${taskGuid}`);
  }

  private async handleComments(taskGuid: string): Promise<void> {
    const comments = await this.deps.api.listComments(taskGuid);
    const state = this.deps.store.get(taskGuid);
    const handled = new Set(state?.handledCommentIds ?? []);
    const fresh = comments.filter(c => !handled.has(c.id));
    if (fresh.length === 0) return;
    this.deps.store.update(taskGuid, s => {
      s.handledCommentIds.push(...fresh.map(c => c.id));
    });
    const instructions = fresh.filter(c => this.isAuthorizedUser(c.creator) && c.content.trim());
    if (instructions.length === 0) return;

    const task = await this.deps.api.getTask(taskGuid);
    if (!this.isAssignee(task)) return;
    const turnKey = instructions[instructions.length - 1].id;

    const sessionId = this.deps.store.get(taskGuid)?.sessionId;
    if (sessionId) {
      const res = await this.deps.trigger({
        source: { type: 'webhook', connectorId: 'lark-task' },
        target: { kind: 'turn', botId: this.deps.larkAppId, sessionId },
        instruction: buildFollowUpInstruction(instructions),
        envelope: { format: 'json', sourceName: 'lark-task', trusted: false, payload: { task_guid: taskGuid, task_url: task.url } },
        options: { asyncReturnSessionId: true, turnIdempotencyKey: `lark-task-comment:${turnKey}` },
      });
      if (res.ok && res.triggerId) {
        await this.recordDispatched(taskGuid, sessionId, res.triggerId);
        return;
      }
      if (res.errorCode !== 'session_not_found') {
        await this.reportDispatchFailure(taskGuid, res);
        return;
      }
      // The task's session was closed; continue in a new one with full context.
    }
    await this.dispatchFresh(task, instructions, `lark-task:${taskGuid}:${turnKey}`);
  }

  private async dispatchFresh(task: LarkTask, latestComments: LarkTaskComment[], idempotencyKey: string): Promise<void> {
    const res = await this.deps.trigger({
      source: { type: 'webhook', connectorId: 'lark-task' },
      target: { kind: 'turn', botId: this.deps.larkAppId },
      instruction: buildTaskInstruction(task, latestComments),
      envelope: { format: 'json', sourceName: 'lark-task', trusted: false, payload: { task_guid: task.guid, task_url: task.url } },
      presentation: { title: `[任务] ${task.summary}`.slice(0, 50) },
      options: { asyncReturnSessionId: true, idempotencyKey },
    });
    const sessionId = res.target?.sessionId;
    if (!res.ok || !res.triggerId || !sessionId) {
      await this.reportDispatchFailure(task.guid, res);
      return;
    }
    await this.recordDispatched(task.guid, sessionId, res.triggerId);
  }

  private async recordDispatched(taskGuid: string, sessionId: string, triggerId: string): Promise<void> {
    this.deps.store.update(taskGuid, s => {
      s.sessionId = sessionId;
      if (!s.pending.some(p => p.triggerId === triggerId)) {
        s.pending.push({ sessionId, triggerId, startedAt: this.now() });
      }
    });
    logger.info(`[task-agent] task ${taskGuid} dispatched: session=${sessionId} trigger=${triggerId}`);
    await this.setStatus(taskGuid, AGENT_TASK_STATUS.running, '正在执行');
    this.ensurePolling();
  }

  private async reportDispatchFailure(taskGuid: string, res: TriggerResponse): Promise<void> {
    const reason = res.error ?? res.errorCode ?? 'unknown';
    logger.error(`[task-agent] task ${taskGuid} dispatch failed: ${reason}`);
    await this.comment(taskGuid, `没能把这条任务交给智能体：${reason}。可以在任务下再评论一次让我重试。`);
    await this.setStatus(taskGuid, AGENT_TASK_STATUS.waitingForHuman, '未能开始');
  }

  private async comment(taskGuid: string, text: string): Promise<void> {
    const id = await this.deps.api.createComment(taskGuid, text);
    if (id) this.deps.store.update(taskGuid, s => { s.handledCommentIds.push(id); });
  }

  /** Status is a display nicety; a failed write must not lose the turn. */
  private async setStatus(taskGuid: string, status: Parameters<LarkTaskApi['setAgentStatus']>[1], progress: string): Promise<void> {
    try {
      await this.deps.api.setAgentStatus(taskGuid, status, progress);
    } catch (err) {
      logger.warn(`[task-agent] task ${taskGuid} status update to ${status} failed: ${err}`);
    }
  }

  private ensurePolling(): void {
    if (this.timer || this.deps.store.listPending().length === 0) return;
    this.timer = setInterval(() => { void this.pollOnce(); }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Settle finished turns. Reads only local trigger results; no Lark calls while a turn runs. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const taskGuid of this.deps.store.listPending()) {
        try {
          await this.settleTask(taskGuid);
        } catch (err) {
          logger.error(`[task-agent] task ${taskGuid} settle failed: ${err}`);
        }
      }
    } finally {
      this.polling = false;
      if (this.deps.store.listPending().length === 0) this.stop();
    }
  }

  private async settleTask(taskGuid: string): Promise<void> {
    // Turns of one task run serially in its session, so results arrive in order.
    for (;;) {
      const turn = this.deps.store.get(taskGuid)?.pending[0];
      if (!turn) return;
      const outcome = this.readOutcome(turn);
      if (!outcome) return;

      const attemptKey = `${taskGuid}:${turn.triggerId}`;
      const chunks = chunkCommentText(outcome.text);
      try {
        for (let i = this.deliveredChunks.get(attemptKey) ?? 0; i < chunks.length; i++) {
          await this.comment(taskGuid, chunks[i]);
          this.deliveredChunks.set(attemptKey, i + 1);
        }
      } catch (err) {
        const attempts = (this.deliveryAttempts.get(attemptKey) ?? 0) + 1;
        this.deliveryAttempts.set(attemptKey, attempts);
        logger.warn(`[task-agent] task ${taskGuid} reply delivery failed (attempt ${attempts}): ${err}`);
        if (attempts < MAX_DELIVERY_ATTEMPTS) return;
        logger.error(`[task-agent] task ${taskGuid} reply dropped after ${attempts} attempts; trigger=${turn.triggerId}`);
      }
      this.deliveryAttempts.delete(attemptKey);
      this.deliveredChunks.delete(attemptKey);

      const remaining = this.deps.store.update(taskGuid, s => {
        s.pending = s.pending.filter(p => p.triggerId !== turn.triggerId);
      }).pending.length;
      if (remaining === 0) await this.setStatus(taskGuid, outcome.status, outcome.progress);
    }
  }

  private readOutcome(turn: PendingTaskTurn): { text: string; status: 3 | 4; progress: string } | undefined {
    const res = this.deps.lookup(turn.sessionId, turn.triggerId);
    if (res.state === 'completed') {
      const text = (res.output?.content ?? '').trim();
      return text.startsWith(WAITING_FOR_HUMAN_MARK)
        ? { text, status: AGENT_TASK_STATUS.waitingForHuman, progress: '待确认' }
        : { text, status: AGENT_TASK_STATUS.done, progress: '执行完成' };
    }
    if (res.state === 'failed' || res.state === 'not_found') {
      const reason = res.errorCode ?? res.error ?? res.state;
      return {
        text: `这一轮没有产出结果（${reason}）。可以在任务下评论让我重试。`,
        status: AGENT_TASK_STATUS.waitingForHuman,
        progress: '执行失败',
      };
    }
    if (this.now() - turn.startedAt > MAX_TURN_AGE_MS) {
      return {
        text: '这一轮超过 12 小时仍未结束，已停止等待。可以在任务下评论让我重试。',
        status: AGENT_TASK_STATUS.waitingForHuman,
        progress: '执行超时',
      };
    }
    return undefined;
  }
}
