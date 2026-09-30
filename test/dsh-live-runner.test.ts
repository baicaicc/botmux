import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DshLiveRunner, readDshLiveConnection, type DshRunnerClient,
} from '../src/dsh-live-runner.js';
import type { DshFollowFrame, DshPromptRequest, DshSessionEvent } from '../src/services/dsh-live-client.js';
import { RunnerControlWriter } from '../src/adapters/cli/runner-control-channel.js';
import { WebSocket, WebSocketServer } from './helpers/node-ws.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const SESSION = 'existing-native-session';
const PRIVATE_TOKEN = 'fixture-private-startup-token';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function snapshot(records: DshSessionEvent[] = [], cursor = records.at(-1)?.seq ?? -1, hasMore = false): DshFollowFrame {
  return {
    type: 'snapshot', header: { id: SESSION, version: 4, createdAt: 1, isSeeded: false },
    cursor, records: records.map(event => ({ type: 'event', event })), hasMore,
    projections: { asOfSeq: cursor, values: {} },
  };
}

class Subscription implements AsyncIterable<DshFollowFrame> {
  queue: DshFollowFrame[] = [];
  waiter?: { resolve(value: IteratorResult<DshFollowFrame>): void; reject(error: Error): void };
  closed = false;
  closeCount = 0;
  push(value: DshFollowFrame) {
    if (this.closed) return;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ done: false, value }); }
    else this.queue.push(value);
  }
  close() { this.closeCount++; this.closed = true; this.waiter?.resolve({ done: true, value: undefined }); this.waiter = undefined; }
  fail(error: Error) { this.closed = true; this.waiter?.reject(error); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<DshFollowFrame> {
    return {
      next: async () => {
        if (this.queue.length) return { done: false, value: this.queue.shift()! };
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
      },
      return: async () => { this.close(); return { done: true, value: undefined }; },
    };
  }
}

class Client implements DshRunnerClient {
  readonly sessionId = SESSION;
  readonly subscription = new Subscription();
  readonly prompts: DshPromptRequest[] = [];
  cancelCount = 0;
  closeCount = 0;
  ack: () => Promise<{ accepted: true }> = async () => ({ accepted: true });
  async follow() { return this.subscription; }
  async prompt(request: DshPromptRequest) { this.prompts.push(request); return this.ack(); }
  async cancel(): Promise<{ accepted: true }> { this.cancelCount++; return { accepted: true }; }
  close() { this.closeCount++; }
}

function markers(output: string): Array<{ kind: string; payload: Record<string, any> }> {
  return [...output.matchAll(/\x1b\]777;botmux:([a-z][a-z0-9_-]*):([A-Za-z0-9+/=]+)\x07/g)]
    .map(match => ({ kind: match[1], payload: JSON.parse(Buffer.from(match[2], 'base64').toString('utf8')) }));
}

async function harness(options: { noSnapshot?: boolean; records?: DshSessionEvent[]; hasMore?: boolean; timeout?: number } = {}) {
  const client = new Client(), chunks: string[] = [], errors: string[] = [];
  let failed: unknown;
  const runner = new DshLiveRunner(client, {
    output: new RunnerControlWriter(chunk => chunks.push(chunk), chunk => errors.push(chunk)),
    turnTimeoutMs: options.timeout ?? 1000, failed: error => { failed = error; },
  });
  cleanup.push(() => runner.close());
  const starting = runner.start();
  if (!options.noSnapshot) { client.subscription.push(snapshot(options.records, undefined, options.hasMore)); await starting; }
  let seq = options.records?.at(-1)?.seq ?? -1;
  return {
    runner, client, chunks, errors, starting, get failed() { return failed; },
    get output() { return chunks.join(''); },
    event(type: string, data: unknown, extra: Partial<DshSessionEvent> = {}) {
      client.subscription.push({ type: 'event', event: { type, data, time: 2, seq: ++seq, ...extra } });
    },
    admit(turn = 1, requestId = client.prompts.at(-1)!.requestId) {
      this.event('turn/start', { turn });
      this.event('step/start', { turn, step: 1 });
      this.event('user/message', { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [] }, { surfaceOp: 'append' });
    },
    assistant(turn = 1, text = 'fixture final', step = 1) {
      this.event('assistant/message', {
        turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
      }, { surfaceOp: 'append' });
    },
    end(turn = 1, kind = 'completed') {
      this.event('step/end', { turn, step: 1 });
      this.event('turn/end', { turn, reason: { kind } });
    },
  };
}

describe('existing-owner dsh runner', () => {
  it('requires the follow opening snapshot before dispatching any prompt', async () => {
    const h = await harness({ noSnapshot: true });
    await expect(h.runner.start()).rejects.toMatchObject({ code: 'already_started' });
    await expect(h.runner.submit({ content: 'before ready' })).rejects.toMatchObject({ code: 'not_ready' });
    expect(h.client.prompts).toHaveLength(0);
    h.client.subscription.push(snapshot()); await h.starting;
    const result = h.runner.submit({ content: 'synthetic request', replyTurnId: 'reply-1' });
    h.admit(); h.assistant(); h.end();
    expect(await result).toMatchObject({ nativeSessionId: SESSION, nativeTurnId: '1', turnId: 'reply-1', reason: 'completed' });
  });

  it('shares one native session across turns and excludes historical and unrelated native output', async () => {
    const h = await harness({ records: [
      { seq: 10, time: 1, type: 'turn/start', data: { turn: 7 } },
      { seq: 11, time: 1, type: 'step/start', data: { turn: 7, step: 1 } },
      { seq: 12, time: 1, type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'historical' }] } } },
      { seq: 13, time: 1, type: 'step/end', data: { turn: 7, step: 1 } },
      { seq: 14, time: 1, type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } },
    ] });
    const first = h.runner.submit({ content: 'synthetic one', replyTurnId: 'one' });
    h.event('turn/start', { turn: 8 }); h.event('step/start', { turn: 8, step: 1 });
    h.event('user/message', { source: { kind: 'user', rpcId: 'native-ui' } }, { surfaceOp: 'append' });
    h.assistant(8, 'unrelated UI answer'); h.end(8);
    await vi.waitFor(() => expect(markers(h.output)).toHaveLength(0));
    h.admit(9); h.assistant(9, 'first owned'); h.end(9);
    expect((await first).content).toBe('first owned');
    const second = h.runner.submit({ content: 'synthetic two', replyTurnId: 'two' });
    h.admit(10); h.assistant(10, 'second owned'); h.end(10);
    expect((await second).content).toBe('second owned');
    expect(h.client.prompts.map(prompt => prompt.requestId)[0]).not.toBe(h.client.prompts[1].requestId);
    expect(markers(h.output).map(marker => marker.payload.replyTurnId)).toEqual(['one', 'two']);
    expect(h.client.closeCount).toBe(0);
  });

  it('maps its rpcId in a batch of user messages under the same proven step', async () => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic batch' });
    h.event('agent/inbox/spliced', { inserted: [{ source: { kind: 'user', rpcId: h.client.prompts[0].requestId } }] });
    h.event('turn/start', { turn: 20 }); h.event('step/start', { turn: 20, step: 1 });
    for (const rpcId of ['native-before', h.client.prompts[0].requestId, 'native-after']) {
      h.event('user/message', { source: { kind: 'user', rpcId } }, { surfaceOp: 'append' });
    }
    h.assistant(20, 'batched answer'); h.end(20);
    expect(await result).toMatchObject({ nativeTurnId: '20', content: 'batched answer' });
  });

  it('attaches to a 500-message tail inside a long active turn without requiring its missing turn/start', async () => {
    const history: DshSessionEvent[] = [];
    const append = (type: string, data: unknown) => history.push({ seq: history.length, time: 1, type, data });
    append('turn/start', { turn: 7 });
    for (let step = 1; step <= 600; step++) {
      append('step/start', { turn: 7, step });
      append('assistant/message', { turn: 7, step, message: { content: [{ type: 'text', text: 'historical' }] } });
      if (step < 600) append('step/end', { turn: 7, step });
    }
    // Official paginate stops at the 500th appended message before it reaches
    // turn/start. The tail begins after that message's own step/start.
    const cut = history.findIndex(event => event.type === 'assistant/message'
      && (event.data as { step: number }).step === 101);
    const records = history.slice(cut);
    expect(records.filter(event => event.type === 'assistant/message')).toHaveLength(500);
    expect(records.some(event => event.type === 'turn/start')).toBe(false);
    const h = await harness({ records, hasMore: true });
    h.event('step/end', { turn: 7, step: 600 });
    h.event('step/start', { turn: 7, step: 601 });
    await vi.waitFor(() => expect(h.client.subscription.queue).toHaveLength(0));
    expect(h.failed).toBeUndefined(); expect(markers(h.output)).toHaveLength(0);
    const result = h.runner.submit({ content: 'synthetic long-turn request' });
    h.event('user/message', { source: { kind: 'user', rpcId: h.client.prompts[0].requestId } }, { surfaceOp: 'append' });
    h.assistant(7, 'fresh owned answer', 601);
    h.event('step/end', { turn: 7, step: 601 });
    h.event('turn/end', { turn: 7, reason: { kind: 'completed' } });
    expect(await result).toMatchObject({ nativeTurnId: '7', content: 'fresh owned answer' });
  });

  it('waits for a live step/start to prove a truncated snapshot with no retained phase boundary', async () => {
    const h = await harness({ hasMore: true, records: [
      { seq: 900, time: 1, type: 'tool/result', data: { turn: 7, step: 600 } },
    ] });
    const result = h.runner.submit({ content: 'synthetic next step' });
    h.event('step/end', { turn: 7, step: 600 });
    h.event('step/start', { turn: 7, step: 601 });
    h.event('user/message', { source: { kind: 'user', rpcId: h.client.prompts[0].requestId } }, { surfaceOp: 'append' });
    h.assistant(7, 'proven live step', 601);
    h.event('step/end', { turn: 7, step: 601 });
    h.event('turn/end', { turn: 7, reason: { kind: 'completed' } });
    expect(await result).toMatchObject({ nativeTurnId: '7', content: 'proven live step' });
  });

  it('keeps complete snapshot and established turn boundaries strict', async () => {
    for (const truncated of [false, true]) {
      const h = await harness(truncated ? { hasMore: true, records: [
        { seq: 900, time: 1, type: 'step/start', data: { turn: 7, step: 600 } },
        { seq: 901, time: 1, type: 'step/end', data: { turn: 7, step: 600 } },
      ] } : {});
      const result = h.runner.submit({ content: 'synthetic invalid parent' });
      const failure = result.catch(error => error);
      h.event('step/start', { turn: 8, step: 1 });
      expect(await failure).toMatchObject({ code: 'invalid_step_boundary' });
      expect(markers(h.output)).toHaveLength(0); expect(h.client.cancelCount).toBe(0);
    }
  });

  it('waits for HTTP acceptance when all durable events precede its ACK', async () => {
    const h = await harness();
    let acknowledge!: (value: { accepted: true }) => void;
    h.client.ack = () => new Promise(resolve => { acknowledge = resolve; });
    const result = h.runner.submit({ content: 'synthetic early events' });
    h.admit(); h.assistant(); h.end();
    await vi.waitFor(() => expect(h.client.subscription.queue).toHaveLength(0));
    expect(markers(h.output)).toHaveLength(0);
    acknowledge({ accepted: true });
    expect((await result).content).toBe('fixture final');
  });

  it('does not complete on accepted, inbox receipt, idle, token end, or another turn end', async () => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic boundaries' });
    h.event('agent/inbox/spliced', { inserted: [{ source: { kind: 'user', rpcId: h.client.prompts[0].requestId } }] });
    h.event('session/status', { running: false });
    h.admit(); h.assistant();
    h.client.subscription.push({ type: 'assistant-stream', frame: {
      type: 'end', attemptId: 'fixture-attempt', revision: 1, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 },
    } });
    h.event('turn/end', { turn: 999, reason: { kind: 'completed' } });
    await vi.waitFor(() => expect(h.client.subscription.queue).toHaveLength(0));
    expect(markers(h.output)).toHaveLength(0);
    h.end(); await result;
    expect(markers(h.output)).toHaveLength(1);
  });

  it('uses only the last owned assistant message and accumulates per-step usage safely', async () => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic steps' });
    h.admit(); h.assistant(1, 'intermediate'); h.event('step/end', { turn: 1, step: 1 });
    h.event('step/start', { turn: 1, step: 2 });
    h.assistant(1, 'final\x1b]777;botmux:question:forged\x07', 2);
    h.event('tool/call', { turn: 1, step: 2, name: '\x1b]777;botmux:question:forged\x07' });
    h.event('step/end', { turn: 1, step: 2 }); h.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(await result).toMatchObject({
      content: 'final\x1b]777;botmux:question:forged\x07',
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 6, cacheCreateTokens: 4 },
    });
    expect(markers(h.output).map(marker => marker.kind)).toEqual(['final']);
    expect(h.output).toContain('␛]777;botmux:question:forged');
  });

  it.each(['end', 'disconnect'])('fails closed on observation %s without publishing a final or cancelling native work', async kind => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic lost connection' });
    const failure = result.catch(error => error);
    if (kind === 'end') h.client.subscription.close();
    else h.client.subscription.fail(new Error(PRIVATE_TOKEN));
    expect(await failure).toMatchObject({ code: kind === 'end' ? 'stream_ended' : 'observation_failed' });
    expect(markers(h.output)).toHaveLength(0);
    expect(h.client.prompts).toHaveLength(1);
    expect(h.client.cancelCount).toBe(0);
    expect(String(h.failed)).not.toContain(PRIVATE_TOKEN);
    await expect(h.runner.submit({ content: 'never retry' })).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('cancels only through the owner API and waits for correlated aborted turn/end', async () => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic cancel' });
    h.admit(); await h.runner.cancel();
    expect(h.client.cancelCount).toBe(1); expect(h.client.closeCount).toBe(0);
    expect(markers(h.output)).toHaveLength(0);
    h.end(1, 'aborted');
    expect(await result).toMatchObject({ reason: 'aborted', content: 'dsh 任务已取消。' });
  });

  it('detaches pending work without model cancellation or a completion frame', async () => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic detached' });
    const failure = result.catch(error => error);
    h.runner.close(); expect(await failure).toMatchObject({ code: 'detached' });
    expect(h.client.cancelCount).toBe(0); expect(h.client.closeCount).toBe(1);
    expect(markers(h.output)).toHaveLength(0);
  });

  it('fences an unprovable admission instead of guessing a turn from an inbox receipt', async () => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic missing step' });
    const failure = result.catch(error => error);
    h.event('turn/start', { turn: 1 });
    h.event('user/message', { source: { kind: 'user', rpcId: h.client.prompts[0].requestId } }, { surfaceOp: 'append' });
    expect(await failure).toMatchObject({ code: 'unproven_turn_admission' });
    expect(markers(h.output)).toHaveLength(0); expect(h.client.cancelCount).toBe(0);
  });

  it('fences a durable sequence gap and timeout without resending or killing the owner', async () => {
    const h = await harness(), result = h.runner.submit({ content: 'synthetic gap' });
    const failure = result.catch(error => error);
    h.event('turn/start', { turn: 1 }, { seq: 100 }); expect(await failure).toMatchObject({ code: 'sequence_gap' });
    const timed = await harness({ timeout: 15 });
    await expect(timed.runner.submit({ content: 'synthetic timeout' })).rejects.toMatchObject({ code: 'turn_timeout' });
    expect(markers(h.output)).toHaveLength(0); expect(markers(timed.output)).toHaveLength(0);
    expect(timed.client.cancelCount).toBe(0); expect(timed.client.prompts).toHaveLength(1);
  });

  it('sanitizes ambiguous submission failure and never writes the startup URL or credentials', async () => {
    const h = await harness(); h.client.ack = async () => { throw new Error(PRIVATE_TOKEN); };
    await expect(h.runner.submit({ content: 'synthetic rejected' })).rejects.toMatchObject({ code: 'submission_failed' });
    expect(h.output + h.errors.join('') + String(h.failed)).not.toContain(PRIVATE_TOKEN);
    expect(markers(h.output)).toHaveLength(0);
  });

  it('requires a private same-owner connection file and gives safe errors for invalid contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-live-binding-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'connection.json');
    writeFileSync(path, JSON.stringify({ webUrl: 'http://127.0.0.1:1/?token=' + PRIVATE_TOKEN, sessionId: SESSION }), { mode: 0o600 });
    expect(readDshLiveConnection(path).sessionId).toBe(SESSION);
    const link = join(directory, 'connection-link.json'); symlinkSync(path, link);
    expect(() => readDshLiveConnection(link)).toThrow('unsafe_connection_file');
    expect(() => readDshLiveConnection('relative.json')).toThrow('unsafe_connection_file');
    chmodSync(path, 0o644);
    expect(() => readDshLiveConnection(path)).toThrow('unsafe_connection_file');
    chmodSync(path, 0o600); writeFileSync(path, PRIVATE_TOKEN);
    expect(() => readDshLiveConnection(path)).toThrow('connection_file_unreadable');
  });
});

async function cliFixture(options: { delaySnapshot?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-live-runner-cli-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const calls: Array<{ method: string; request: Record<string, any> }> = [], mux: Record<string, any>[] = [];
  const sockets: Array<InstanceType<typeof WebSocket>> = [];
  let ownerClosed = false, origin = '', activeSocket: InstanceType<typeof WebSocket> | undefined, streamId = '', seq = -1;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/?token=' + PRIVATE_TOKEN) {
      response.writeHead(303, { location: './', 'set-cookie': 'native=fixture; HttpOnly; SameSite=Strict' }); response.end(); return;
    }
    if (request.headers.cookie !== 'native=fixture') { response.writeHead(401); response.end(PRIVATE_TOKEN); return; }
    let body = ''; for await (const part of request) body += part.toString();
    const envelope = JSON.parse(body), value = envelope.payload.args.request;
    calls.push({ method: envelope.method, request: value });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { accepted: true } } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
      sockets.push(ws); activeSocket = ws;
      ws.on('message', data => {
        const value = JSON.parse(data.toString()); mux.push(value);
        if (value.type === 'open') {
          streamId = value.streamId;
          if (!options.delaySnapshot) ws.send(JSON.stringify({ type: 'item', streamId, value: snapshot() }));
        }
      });
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  server.on('close', () => { ownerClosed = true; });
  cleanup.push(async () => {
    sockets.forEach(socket => socket.terminate());
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  });
  const connectionFile = join(directory, 'connection.json');
  writeFileSync(connectionFile, JSON.stringify({ webUrl: origin + '/?token=' + PRIVATE_TOKEN, sessionId: SESSION }), { mode: 0o600 });
  const child = spawnTsScript(resolve('src/dsh-live-runner.ts'), ['--connection-file', connectionFile, '--session-id', 'botmux-session'], {
    cwd: resolve('.'), stdio: 'pipe',
  }) as ChildProcessWithoutNullStreams;
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); }); child.stderr.on('data', data => { stderr += data.toString(); });
  cleanup.push(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await vi.waitFor(() => options.delaySnapshot
    ? expect(mux.some(frame => frame.type === 'open')).toBe(true) : expect(stdout).toContain('›'), { timeout: 10_000 });
  return {
    child, calls, mux, origin, connectionFile,
    get stdout() { return stdout; }, get stderr() { return stderr; }, get ownerClosed() { return ownerClosed; },
    input(content: string, replyTurnId = 'cli-reply') {
      child.stdin.write('::botmux-dsh:' + Buffer.from(JSON.stringify({ type: 'message', content, replyTurnId })).toString('base64') + '\n');
    },
    event(type: string, data: unknown, extra: Partial<DshSessionEvent> = {}) {
      activeSocket!.send(JSON.stringify({ type: 'item', streamId, value: {
        type: 'event', event: { type, data, seq: ++seq, time: 2, ...extra },
      } }));
    },
    terminateStream() { activeSocket!.send(JSON.stringify({ type: 'end', streamId })); },
  };
}

describe('dsh live runner process', () => {
  it('detaches normally on SIGTERM while the opening snapshot is still pending', async () => {
    const h = await cliFixture({ delaySnapshot: true });
    h.child.kill('SIGTERM'); await vi.waitFor(() => expect(h.child.exitCode).toBe(0));
    expect(h.calls).toHaveLength(0); expect(markers(h.stdout)).toHaveLength(0);
    expect(h.stdout).not.toContain('›'); expect(h.ownerClosed).toBe(false);
  });

  it('dispatches to the bound owner, emits correlated OSC final, and detaches on EOF', async () => {
    const h = await cliFixture(); h.input('fixture process request');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]).toMatchObject({ method: 'session/prompt', request: { sessionId: SESSION, mode: 'queue' } });
    h.event('turn/start', { turn: 1 }); h.event('step/start', { turn: 1, step: 1 });
    h.event('user/message', { source: { kind: 'user', rpcId: h.calls[0].request.requestId } }, { surfaceOp: 'append' });
    h.event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'process fixture result' }] } }, { surfaceOp: 'append' });
    h.event('step/end', { turn: 1, step: 1 }); h.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await vi.waitFor(() => expect(markers(h.stdout)).toHaveLength(1));
    expect(markers(h.stdout)[0].payload).toMatchObject({ content: 'process fixture result', turnId: 'cli-reply', nativeSessionId: SESSION });
    h.child.stdin.end();
    await vi.waitFor(() => expect(h.child.exitCode).toBe(0));
    expect(h.calls.map(call => call.method)).toEqual(['session/prompt']);
    expect(h.mux.filter(frame => frame.type === 'open').map(frame => frame.endpoint)).toEqual(['session/follow']);
    expect(h.ownerClosed).toBe(false);
    expect(h.stdout + h.stderr).not.toContain(PRIVATE_TOKEN);
    expect(h.child.spawnargs.join(' ')).not.toContain(PRIVATE_TOKEN);
    expect(readFileSync(h.connectionFile, 'utf8')).toContain(PRIVATE_TOKEN);
  });

  it('maps ::cancel and SIGINT to native cancel while SIGTERM only detaches', async () => {
    const h = await cliFixture(); h.child.stdin.write('::cancel\n');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.child.kill('SIGINT'); await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls.map(call => call.method)).toEqual(['session/cancel', 'session/cancel']);
    expect(h.child.exitCode).toBeNull();
    h.child.kill('SIGTERM'); await vi.waitFor(() => expect(h.child.exitCode).toBe(0));
    expect(h.calls).toHaveLength(2); expect(markers(h.stdout)).toHaveLength(0);
    expect(h.ownerClosed).toBe(false);
  });

  it('exits on stream end without fake completion or resending an uncertain prompt', async () => {
    const h = await cliFixture(); h.input('fixture incomplete request');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.terminateStream(); await vi.waitFor(() => expect(h.child.exitCode).toBe(1));
    expect(markers(h.stdout)).toHaveLength(0);
    expect(h.calls.map(call => call.method)).toEqual(['session/prompt']);
    expect(h.ownerClosed).toBe(false); expect(h.stdout + h.stderr).not.toContain(PRIVATE_TOKEN);
  });
});
