import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn(),
}));
import {execFileSync} from 'node:child_process';
import {findKimiWireSource, inspectHerdrKimiOwner, inspectHerdrKimiSource, KimiNativeFailureObserver, type KimiNativeSource} from '../src/services/kimi-native-failure.js';

describe('Kimi native failure observation', () => {
  let root: string;
  let source: KimiNativeSource;
  let file: string;
  let observer: KimiNativeFailureObserver;
  const content = 'Reply only the QA nonce. Do not use tools.';
  const prompt = (extra = {}) => ({type: 'turn.prompt', agentId: 'main', input: [{type: 'text', text: content}],
    origin: {kind: 'user'}, promptId: 'msg_qa', turnId: 0, time: 1001, ...extra});
  const ended = (extra = {}) => ({type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'failed',
    error: {code: 'provider.auth_error', message: "403 You've reached your weekly (7-day) usage limit.",
      details: {statusCode: 403}, retryable: false}, time: 1010, ...extra});
  const append = (...rows: unknown[]) => appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const mark = () => observer.mark(source, {content, turnId: 'lark-qa', dispatchAttempt: 3}, 1000, root);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-native-failure-')));
    source = {sessionId: 'session_11111111-2222-4333-8444-555555555555', cwd: root, pid: 100, birth: 'known birth'};
    const dir = join(root, 'sessions', 'wd_qa_hash', source.sessionId);
    mkdirSync(join(dir, 'agents', 'main'), {recursive: true});
    writeFileSync(join(dir, 'state.json'), JSON.stringify({version: 2, id: source.sessionId, cwd: source.cwd}));
    file = join(dir, 'agents', 'main', 'wire.jsonl');
    writeFileSync(file, JSON.stringify({type: 'metadata', protocol_version: '1.5', created_at: 900}) + '\n');
    observer = new KimiNativeFailureObserver();
  });
  afterEach(() => {rmSync(root, {recursive: true, force: true});});

  it('waits for exact native turn.ended, emits the failed turn once, and leaves the wire unchanged', () => {
    mark();
    append(prompt(), {type: 'turn.step.interrupted', agentId: 'main', turnId: 0, reason: 'error',
      message: 'provider.auth_error 403 weekly limit', time: 1002});
    expect(observer.poll(source)).toBeUndefined();
    append(ended());
    const before = readFileSync(file);
    const failure = observer.poll(source)!;
    expect(failure).toEqual({nativeSessionId: source.sessionId, turnId: 'lark-qa', dispatchAttempt: 3,
      errorCode: 'kimi_provider_auth_error', summary: "provider.auth_error: 403 You've reached your weekly (7-day) usage limit.",
      retryable: false, completedAtMs: 1010});
    expect(observer.acknowledge(failure, source)).toBe(true);
    expect(observer.poll(source)).toBeUndefined();
    expect(readFileSync(file)).toEqual(before);
  });

  it('ignores old history and an old-timestamp record appended after the mark', () => {
    append(prompt({time: 950}), ended({time: 960}));
    mark();
    expect(observer.poll(source)).toBeUndefined();
    append(prompt({time: 970}), ended({time: 980}));
    expect(observer.poll(source)).toBeUndefined();
    append(prompt(), ended());
    expect(observer.poll(source)?.turnId).toBe('lark-qa');
  });

  it('holds partial terminal lines without advancing past them', () => {
    mark(); append(prompt());
    const terminal = JSON.stringify(ended());
    appendFileSync(file, terminal.slice(0, 40));
    expect(observer.poll(source)).toBeUndefined();
    appendFileSync(file, terminal.slice(40) + '\n');
    const failure = observer.poll(source)!;
    expect(failure.errorCode).toBe('kimi_provider_auth_error');
    expect(observer.acknowledge(failure, source)).toBe(true);
    expect(observer.poll(source)).toBeUndefined();
  });

  it('does not attribute a different local prompt or a superseding prompt to the Lark task', () => {
    mark(); append(prompt({input: [{type: 'text', text: 'a different local task'}]}), ended());
    expect(observer.poll(source)).toBeUndefined(); expect(observer.active).toBe(false);
    mark(); append(prompt(), prompt({promptId: 'msg_other', turnId: 1}), ended());
    expect(observer.poll(source)).toBeUndefined(); expect(observer.active).toBe(false);
  });

  it('ignores subagent terminals and a different native turn id', () => {
    mark(); append(prompt(), ended({agentId: 'agent-1'}), ended({turnId: 1}));
    expect(observer.poll(source)).toBeUndefined();
    append(ended()); expect(observer.poll(source)?.turnId).toBe('lark-qa');
  });

  it('rejects reuse of the same native prompt id for a different turn', () => {
    mark(); append(prompt(), prompt({turnId: 1}), ended({turnId: 1}));
    expect(observer.poll(source)).toBeUndefined(); expect(observer.active).toBe(false);
  });

  it.each(['pid', 'birth', 'sessionId', 'cwd'] as const)('fences changes to %s without delivering stale errors', field => {
    mark(); append(prompt(), ended());
    const changed = {...source, [field]: field === 'pid' ? 101 : 'changed'};
    expect(observer.poll(changed)).toBeUndefined();
    expect(observer.poll(source)).toBeUndefined();
  });

  it('does not invent a failure from a completed turn or error-looking progress', () => {
    mark(); append(prompt(), {type: 'turn.step.interrupted', agentId: 'main', turnId: 0,
      message: 'provider.auth_error 403', time: 1002}, ended({reason: 'completed'}));
    expect(observer.poll(source)).toBeUndefined(); expect(observer.active).toBe(false);
    mark(); append(prompt(), ended({error: 'provider.auth_error 403'}));
    expect(observer.poll(source)).toBeUndefined();
  });

  it('requires verified state and declines an ambiguous session in two workspace buckets', () => {
    const state = join(root, 'sessions', 'wd_qa_hash', source.sessionId, 'state.json');
    writeFileSync(state, JSON.stringify({version: 2, id: source.sessionId, cwd: '/wrong/workspace'}));
    expect(findKimiWireSource(source, root)).toBeUndefined();
    writeFileSync(state, JSON.stringify({version: 2, id: source.sessionId, cwd: root}));
    const duplicate = join(root, 'sessions', 'wd_duplicate', source.sessionId);
    mkdirSync(join(duplicate, 'agents', 'main'), {recursive: true});
    writeFileSync(join(duplicate, 'state.json'), readFileSync(state));
    writeFileSync(join(duplicate, 'agents', 'main', 'wire.jsonl'), '');
    expect(findKimiWireSource(source, root)).toBeUndefined();
  });

  it('fails closed on truncated/unknown native storage and redacts provider secrets', () => {
    mark(); writeFileSync(file, '');
    expect(observer.poll(source)).toBeUndefined();
    writeFileSync(file, JSON.stringify({type: 'metadata', protocol_version: 'unknown'}) + '\n');
    mark(); expect(observer.active).toBe(false);
    writeFileSync(file, JSON.stringify({type: 'metadata', protocol_version: '1.5'}) + '\n');
    mark(); append(prompt(), ended({error: {code: 'provider.auth_error', message: '403 Bearer TEST_SECRET_VALUE_123456789'}}));
    expect(observer.poll(source)?.summary).not.toContain('TEST_SECRET_VALUE_123456789');
  });

  it.each([false, true])('binds first-turn storage after submit when native ID was already published: %s', published => {
    const dir = join(root, 'sessions', 'wd_qa_hash', source.sessionId);
    rmSync(dir, {recursive: true});
    const owner = {cwd: source.cwd, pid: source.pid, birth: source.birth};
    observer.mark(published ? source : owner, {content, turnId: 'lark-qa'}, 1000, root);
    expect(observer.active).toBe(true);
    expect(observer.poll(undefined)).toBeUndefined();
    expect(observer.poll(owner)).toBeUndefined();
    expect(observer.active).toBe(true);
    expect(observer.poll(source)).toBeUndefined();
    mkdirSync(join(dir, 'agents', 'main'), {recursive: true});
    writeFileSync(join(dir, 'state.json'), JSON.stringify({version: 2, id: source.sessionId, cwd: root, createdAt: 1000}));
    const metadata = JSON.stringify({type: 'metadata', protocol_version: '1.5', created_at: 1000});
    writeFileSync(file, '');
    expect(observer.poll(source)).toBeUndefined();
    appendFileSync(file, metadata.slice(0, 30));
    expect(observer.poll(source)).toBeUndefined();
    expect(observer.active).toBe(true);
    appendFileSync(file, metadata.slice(30) + '\n');
    append(prompt(), ended());
    const failure = observer.poll(source)!;
    expect(failure.nativeSessionId).toBe(source.sessionId);
    expect(observer.acknowledge(failure, undefined)).toBe(false);
    expect(observer.poll(undefined)).toBeUndefined();
    expect(observer.poll(source)).toBe(failure);
    expect(observer.acknowledge(failure, source)).toBe(true);
    expect(observer.poll(source)).toBeUndefined();
  });

  it.each(['state', 'metadata'])('never promotes pre-submit %s into first-turn storage', old => {
    const dir = join(root, 'sessions', 'wd_qa_hash', source.sessionId);
    rmSync(dir, {recursive: true});
    observer.mark({cwd: root, pid: source.pid, birth: source.birth}, {content, turnId: 'lark-qa'}, 1000, root);
    mkdirSync(join(dir, 'agents', 'main'), {recursive: true});
    writeFileSync(join(dir, 'state.json'), JSON.stringify({version: 2, id: source.sessionId, cwd: root,
      createdAt: old === 'state' ? 999 : 1000}));
    writeFileSync(file, JSON.stringify({type: 'metadata', protocol_version: '1.5',
      created_at: old === 'metadata' ? 999 : 1000}) + '\n');
    append(prompt(), ended());
    expect(observer.poll(source)).toBeUndefined();
  });

  it.each([false, true])('waits for a pre-verified native ID to publish missing or partial wire: %s', partial => {
    const header = JSON.stringify({type: 'metadata', protocol_version: '1.5', created_at: 900});
    if (partial) writeFileSync(file, header.slice(0, 20));
    else rmSync(file);
    mark();
    expect(observer.active).toBe(true);
    expect(observer.poll(source)).toBeUndefined();
    writeFileSync(file, header + '\n');
    append(prompt({time: 950}), ended({time: 960}));
    expect(observer.poll(source)).toBeUndefined();
    append(prompt(), ended());
    const failure = observer.poll(source)!;
    expect(failure.turnId).toBe('lark-qa');
    expect(observer.acknowledge(failure, source)).toBe(true);
    expect(observer.poll(source)).toBeUndefined();
  });

  it('retains a parsed terminal until fresh owner confirmation, then consumes it once', () => {
    mark(); append(prompt(), ended());
    const failure = observer.poll(source)!;
    expect(observer.acknowledge(failure, undefined)).toBe(false);
    expect(observer.acknowledge(failure, {cwd: root, pid: source.pid, birth: source.birth})).toBe(false);
    expect(observer.poll(undefined)).toBeUndefined();
    expect(observer.active).toBe(true);
    expect(observer.poll(source)).toBe(failure);
    expect(observer.acknowledge(failure, source)).toBe(true);
    expect(observer.acknowledge(failure, source)).toBe(false);
    expect(observer.active).toBe(false);
  });

  it('rejects confirmed owner changes while retaining a terminal for confirmation', () => {
    mark(); append(prompt(), ended());
    const failure = observer.poll(source)!;
    expect(observer.acknowledge(failure, {...source, birth: 'different birth'})).toBe(false);
    expect(observer.active).toBe(false);
    expect(observer.poll(source)).toBeUndefined();
  });
});

describe('HERDR Kimi source fencing', () => {
  const agent = {name: 'qa-agent', agent: 'kimi', pane_id: 'qa:p1', cwd: '/tmp/qa', foreground_cwd: '/tmp/qa',
    agent_session: {kind: 'id', source: 'herdr:kimi', value: 'session_11111111-2222-4333-8444-555555555555'}};
  const info = {shell_pid: 99, foreground_processes: [{pid: 100, name: 'kimi', argv0: 'kimi-code', cwd: '/tmp/qa'}]};
  const exec = vi.mocked(execFileSync);
  beforeEach(() => {exec.mockReset();});
  const responses = (lastAgent = agent, lastInfo = info, lastBirth = 'known birth') => {
    exec.mockReturnValueOnce(JSON.stringify({result: {agent}}))
      .mockReturnValueOnce(JSON.stringify({result: {process_info: info}})).mockReturnValueOnce('known birth')
      .mockReturnValueOnce(JSON.stringify({result: {agent: lastAgent}}))
      .mockReturnValueOnce(JSON.stringify({result: {process_info: lastInfo}})).mockReturnValueOnce(lastBirth);
  };
  it('reads the precise native session with PID birth/workspace and never issues a terminal mutation', () => {
    responses();
    expect(inspectHerdrKimiSource('qa', 'qa-agent', 100)).toEqual({sessionId: agent.agent_session.value,
      cwd: '/tmp/qa', pid: 100, birth: 'known birth'});
    expect(exec.mock.calls.every(([bin, args]) => bin === 'ps' || (bin === 'herdr' && (args?.includes('get') || args?.includes('process-info'))))).toBe(true);
  });
  it('declines a changed native session, process, or PID birth', () => {
    responses({...agent, agent_session: {...agent.agent_session, value: 'session_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}});
    expect(inspectHerdrKimiSource('qa', 'qa-agent', 100)).toBeUndefined();
    exec.mockReset(); responses(agent, {...info, foreground_processes: [{...info.foreground_processes[0], pid: 101}]});
    expect(inspectHerdrKimiSource('qa', 'qa-agent', 100)).toBeUndefined();
    exec.mockReset(); responses(agent, info, 'new birth');
    expect(inspectHerdrKimiSource('qa', 'qa-agent', 100)).toBeUndefined();
  });

  it('pins a cold physical owner with no native ID, and treats ID publication during sampling as unknown', () => {
    const {agent_session, ...cold} = agent;
    exec.mockReturnValueOnce(JSON.stringify({result: {agent: cold}}))
      .mockReturnValueOnce(JSON.stringify({result: {process_info: info}})).mockReturnValueOnce('known birth')
      .mockReturnValueOnce(JSON.stringify({result: {agent: cold}}))
      .mockReturnValueOnce(JSON.stringify({result: {process_info: info}})).mockReturnValueOnce('known birth');
    expect(inspectHerdrKimiOwner('qa', 'qa-agent', 100)).toEqual({cwd: '/tmp/qa', pid: 100, birth: 'known birth'});
    exec.mockReset();
    exec.mockReturnValueOnce(JSON.stringify({result: {agent: cold}}))
      .mockReturnValueOnce(JSON.stringify({result: {process_info: info}})).mockReturnValueOnce('known birth')
      .mockReturnValueOnce(JSON.stringify({result: {agent}}))
      .mockReturnValueOnce(JSON.stringify({result: {process_info: info}})).mockReturnValueOnce('known birth');
    expect(inspectHerdrKimiOwner('qa', 'qa-agent', 100)).toBeUndefined();
  });
});
