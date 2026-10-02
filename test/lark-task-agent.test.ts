import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TriggerRequest, TriggerResponse } from '../src/services/trigger-types.js';
import type { LarkTask, LarkTaskApi, LarkTaskComment } from '../src/services/lark-task-agent/api.js';
import {
  LarkTaskAgent,
  WAITING_FOR_HUMAN_MARK,
  chunkCommentText,
} from '../src/services/lark-task-agent/bridge.js';
import { createTaskAgentStore, type TaskAgentStore } from '../src/services/lark-task-agent/store.js';

const APP = 'cli_bot';
const OWNER = 'ou_owner';
const STRANGER = 'ou_stranger';
const GUID = 'task-guid-1';

class FakeApi implements LarkTaskApi {
  task: LarkTask = {
    guid: GUID,
    summary: '整理周报',
    description: '把本周的进展汇总成三条',
    url: 'https://example.invalid/task',
    status: 'todo',
    agentTaskStatus: 1,
    creator: { id: OWNER, type: 'user' },
    members: [{ id: APP, type: 'app', role: 'assignee' }],
  };
  comments: LarkTaskComment[] = [];
  statuses: Array<{ status: number; progress: string }> = [];
  registered = 0;
  failRegistrations = 0;
  failNextComments = 0;
  private seq = 0;

  async register(): Promise<void> {
    this.registered++;
    if (this.failRegistrations > 0) {
      this.failRegistrations--;
      throw new Error('Request failed with status code 500');
    }
  }
  async getTask(): Promise<LarkTask> { return this.task; }
  async listComments(): Promise<LarkTaskComment[]> { return [...this.comments]; }
  async createComment(_guid: string, content: string): Promise<string> {
    if (this.failNextComments > 0) {
      this.failNextComments--;
      throw new Error('lark unavailable');
    }
    const id = `bot-comment-${++this.seq}`;
    this.comments.push({ id, content, createdAt: this.seq, creator: { id: APP, type: 'app' } });
    return id;
  }
  async setAgentStatus(_guid: string, status: 1 | 2 | 3 | 4, progress: string): Promise<void> {
    this.statuses.push({ status, progress });
  }

  userComment(id: string, content: string, author = OWNER): void {
    this.comments.push({ id, content, createdAt: 1000 + this.comments.length, creator: { id: author, type: 'user' } });
  }
  botComments(): string[] {
    return this.comments.filter(c => c.creator?.type === 'app').map(c => c.content);
  }
}

interface Harness {
  api: FakeApi;
  store: TaskAgentStore;
  agent: LarkTaskAgent;
  triggers: TriggerRequest[];
  results: Map<string, TriggerResponse>;
  triggerResponse: (req: TriggerRequest) => TriggerResponse;
}

let dir = '';

function harness(storeFile = join(dir, 'state.json')): Harness {
  const api = new FakeApi();
  const store = createTaskAgentStore(storeFile);
  const triggers: TriggerRequest[] = [];
  const results = new Map<string, TriggerResponse>();
  const h = {
    api,
    store,
    triggers,
    results,
    triggerResponse: (req: TriggerRequest): TriggerResponse => ({
      ok: true,
      triggerId: `trg-${triggers.length}`,
      target: { kind: 'turn', sessionId: req.target.sessionId ?? 'session-1' },
    }),
  } as Harness;
  h.agent = new LarkTaskAgent({
    larkAppId: APP,
    api,
    store,
    trigger: async (req) => {
      triggers.push(req);
      return h.triggerResponse(req);
    },
    lookup: (_sessionId, triggerId) => results.get(triggerId) ?? { ok: true, state: 'running' },
    canOperate: openId => openId === OWNER,
    // Never let a real interval fire inside a test.
    pollIntervalMs: 3_600_000,
    sleep: async () => {},
  });
  return h;
}

const assigned = { taskGuid: GUID, eventTypes: ['task_create', 'task_assignees_update'] };
const commented = { taskGuid: GUID, eventTypes: ['task_comment_create'] };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'task-agent-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('LarkTaskAgent', () => {
  it('starts one session for an assigned task and writes the result back', async () => {
    const h = harness();
    await h.agent.handleEvent(assigned);

    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0].target).toEqual({ kind: 'turn', botId: APP });
    expect(h.triggers[0].options).toEqual({ asyncReturnSessionId: true, idempotencyKey: `lark-task:${GUID}` });
    expect(h.triggers[0].instruction).toContain('整理周报');
    expect(h.triggers[0].instruction).toContain('把本周的进展汇总成三条');
    expect(h.api.statuses).toEqual([{ status: 2, progress: '正在执行' }]);

    await h.agent.pollOnce();
    expect(h.api.botComments()).toEqual([]);

    h.results.set('trg-1', { ok: true, state: 'completed', output: { content: '周报已整理好。' } });
    await h.agent.pollOnce();
    expect(h.api.botComments()).toEqual(['周报已整理好。']);
    expect(h.api.statuses.at(-1)).toEqual({ status: 4, progress: '执行完成' });
    expect(h.store.listPending()).toEqual([]);
    h.agent.stop();
  });

  it('ignores a repeated start event once the task has a session', async () => {
    const h = harness();
    await h.agent.handleEvent(assigned);
    await h.agent.handleEvent({ taskGuid: GUID, eventTypes: ['task_assignees_update'] });
    expect(h.triggers).toHaveLength(1);
    h.agent.stop();
  });

  it('does nothing for a task the bot is not the assignee of', async () => {
    const h = harness();
    h.api.task.members = [{ id: 'cli_other', type: 'app', role: 'assignee' }, { id: APP, type: 'app', role: 'follower' }];
    await h.agent.handleEvent(assigned);
    expect(h.triggers).toHaveLength(0);
    expect(h.api.statuses).toEqual([]);
  });

  it('does not restart a task that is already done or in progress', async () => {
    const h = harness();
    h.api.task.agentTaskStatus = 4;
    await h.agent.handleEvent(assigned);
    h.api.task.agentTaskStatus = 1;
    h.api.task.status = 'done';
    await h.agent.handleEvent(assigned);
    expect(h.triggers).toHaveLength(0);
  });

  it('refuses a task created by a user who may not operate the bot, once', async () => {
    const h = harness();
    h.api.task.creator = { id: STRANGER, type: 'user' };
    await h.agent.handleEvent(assigned);
    await h.agent.handleEvent(assigned);
    h.api.userComment('c-1', '快点做', STRANGER);
    await h.agent.handleEvent(commented);
    expect(h.triggers).toHaveLength(0);
    expect(h.api.botComments()).toHaveLength(1);
    expect(h.api.botComments()[0]).toContain('授权用户');
  });

  it('continues the same session on an authorized comment and ignores its own', async () => {
    const h = harness();
    await h.agent.handleEvent(assigned);
    h.results.set('trg-1', { ok: true, state: 'completed', output: { content: '第一版结果' } });
    await h.agent.pollOnce();

    // The bot's own reply comes back as a comment event.
    await h.agent.handleEvent(commented);
    expect(h.triggers).toHaveLength(1);

    h.api.userComment('c-1', '再精简一点');
    h.api.userComment('c-2', '路过看看', STRANGER);
    await h.agent.handleEvent(commented);
    expect(h.triggers).toHaveLength(2);
    expect(h.triggers[1].target).toEqual({ kind: 'turn', botId: APP, sessionId: 'session-1' });
    expect(h.triggers[1].options).toEqual({ asyncReturnSessionId: true, turnIdempotencyKey: 'lark-task-comment:c-1' });
    expect(h.triggers[1].instruction).toContain('再精简一点');
    expect(h.triggers[1].instruction).not.toContain('路过看看');
    expect(h.api.statuses.at(-1)).toEqual({ status: 2, progress: '正在执行' });

    // Same comments delivered again must not dispatch twice.
    await h.agent.handleEvent(commented);
    expect(h.triggers).toHaveLength(2);
    h.agent.stop();
  });

  it('opens a new session with full context when the old one is gone', async () => {
    const h = harness();
    await h.agent.handleEvent(assigned);
    h.results.set('trg-1', { ok: true, state: 'completed', output: { content: '完成' } });
    await h.agent.pollOnce();

    h.triggerResponse = (req) => req.target.sessionId
      ? { ok: false, errorCode: 'session_not_found', error: 'gone' }
      : { ok: true, triggerId: 'trg-new', target: { kind: 'turn', sessionId: 'session-2' } };
    h.api.userComment('c-1', '改成英文');
    await h.agent.handleEvent(commented);

    expect(h.triggers).toHaveLength(3);
    expect(h.triggers[2].target).toEqual({ kind: 'turn', botId: APP });
    expect(h.triggers[2].options?.idempotencyKey).toBe(`lark-task:${GUID}:c-1`);
    expect(h.triggers[2].instruction).toContain('整理周报');
    expect(h.triggers[2].instruction).toContain('改成英文');
    expect(h.store.get(GUID)?.sessionId).toBe('session-2');
    h.agent.stop();
  });

  it('marks the task as waiting when the agent asks for a decision or fails', async () => {
    const h = harness();
    await h.agent.handleEvent(assigned);
    h.results.set('trg-1', { ok: true, state: 'completed', output: { content: `${WAITING_FOR_HUMAN_MARK}发给谁？` } });
    await h.agent.pollOnce();
    expect(h.api.statuses.at(-1)).toEqual({ status: 3, progress: '待确认' });

    h.api.userComment('c-1', '发给全组');
    await h.agent.handleEvent(commented);
    h.results.set('trg-2', { ok: true, state: 'failed', errorCode: 'no_output' as TriggerResponse['errorCode'] });
    await h.agent.pollOnce();
    expect(h.api.botComments().at(-1)).toContain('no_output');
    expect(h.api.statuses.at(-1)).toEqual({ status: 3, progress: '执行失败' });
  });

  it('reports a dispatch that could not start', async () => {
    const h = harness();
    h.triggerResponse = () => ({ ok: false, errorCode: 'trigger_failed', error: 'worker unavailable' });
    await h.agent.handleEvent(assigned);
    expect(h.api.botComments()[0]).toContain('worker unavailable');
    expect(h.api.statuses.at(-1)).toEqual({ status: 3, progress: '未能开始' });
    expect(h.store.listPending()).toEqual([]);
  });

  it('retries a failed reply without repeating chunks already posted', async () => {
    const h = harness();
    await h.agent.handleEvent(assigned);
    const long = `${'甲'.repeat(2800)}\n${'乙'.repeat(100)}`;
    h.results.set('trg-1', { ok: true, state: 'completed', output: { content: long } });

    h.api.failNextComments = 0;
    const realCreate = h.api.createComment.bind(h.api);
    let calls = 0;
    h.api.createComment = async (guid, content) => {
      if (++calls === 2) throw new Error('lark unavailable');
      return realCreate(guid, content);
    };
    await h.agent.pollOnce();
    expect(h.api.botComments()).toHaveLength(1);
    expect(h.store.listPending()).toEqual([GUID]);

    await h.agent.pollOnce();
    expect(h.api.botComments()).toEqual(['甲'.repeat(2800), '乙'.repeat(100)]);
    expect(h.store.listPending()).toEqual([]);
  });

  it('settles a turn left pending by a restart', async () => {
    const file = join(dir, 'restart.json');
    const first = harness(file);
    await first.agent.handleEvent(assigned);
    first.agent.stop();

    const second = harness(file);
    second.results.set('trg-1', { ok: true, state: 'completed', output: { content: '重启后补发' } });
    await second.agent.start();
    expect(second.api.registered).toBe(1);
    await second.agent.pollOnce();
    expect(second.api.botComments()).toEqual(['重启后补发']);
    expect(second.api.statuses.at(-1)).toEqual({ status: 4, progress: '执行完成' });
  });
});

describe('LarkTaskAgent registration', () => {
  it('retries a registration that fails at first', async () => {
    const h = harness();
    h.api.failRegistrations = 2;
    await h.agent.start();
    expect(h.api.registered).toBe(3);
  });

  it('gives up after three attempts without throwing', async () => {
    const h = harness();
    h.api.failRegistrations = 10;
    await expect(h.agent.start()).resolves.toBeUndefined();
    expect(h.api.registered).toBe(3);
  });
});

describe('chunkCommentText', () => {
  it('keeps short text whole and splits long text on a line break when it can', () => {
    expect(chunkCommentText('短文本')).toEqual(['短文本']);
    expect(chunkCommentText('')).toEqual([]);
    const chunks = chunkCommentText(`${'a'.repeat(60)}\n${'b'.repeat(60)}`, 100);
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
    expect(chunkCommentText('c'.repeat(250), 100).map(c => c.length)).toEqual([100, 100, 50]);
  });
});
