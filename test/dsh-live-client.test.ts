import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshLiveClient } from '../src/services/dsh-live-client.js';
import { WebSocket, WebSocketServer } from './helpers/node-ws.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

type Frame = Record<string, any>;
const SESSION = 'same-live-session';
const TOKEN = 'fixture-private-launch-token';
const COOKIE = 'dsh-session=fixture-private-cookie';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function snapshot(sessionId = SESSION, cursor = 0): Frame {
  return {
    type: 'snapshot',
    header: { id: sessionId, version: 1, createdAt: 1, isSeeded: false, cwd: '/fixture/workspace' },
    cursor, records: [], hasMore: false, projections: { asOfSeq: cursor, values: {} },
    assistantStream: { revision: 0 },
  };
}
function event(seq: number, type = 'turn/end'): Frame {
  return { type: 'event', event: { type, seq, time: 2, data: { reason: 'completed' } } };
}

async function fixture(options: {
  noSnapshot?: boolean;
  snapshot?: Frame;
  authStatus?: number;
  location?: string;
  remoteError?: Frame;
  wrongRpcId?: boolean;
  pendingRpc?: boolean;
  stallUpgrade?: boolean;
} = {}) {
  const rpc: { path: string; envelope: Frame; headers: IncomingHttpHeaders }[] = [];
  const mux: Frame[] = [];
  const upgrades: { path: string; headers: IncomingHttpHeaders }[] = [];
  const sockets = new Map<string, InstanceType<typeof WebSocket>>();
  const openIds: string[] = [];
  const allSockets: InstanceType<typeof WebSocket>[] = [];
  const stalledSockets: Socket[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/?token=' + TOKEN) {
      response.writeHead(options.authStatus ?? 303, {
        location: options.location ?? './', 'set-cookie': COOKIE + '; HttpOnly; SameSite=Strict',
      });
      response.end(); return;
    }
    if (request.headers.cookie !== COOKIE || request.headers.origin !== origin) {
      response.writeHead(401); response.end('private error: ' + TOKEN); return;
    }
    let body = '';
    for await (const part of request) body += part.toString();
    const envelope = JSON.parse(body) as Frame;
    rpc.push({ path: request.url!, envelope, headers: request.headers });
    if (options.pendingRpc) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      type: 'server-response', rpcId: options.wrongRpcId ? 'unrelated-rpc' : envelope.rpcId,
      result: options.remoteError
        ? { ok: false, error: options.remoteError } : { ok: true, value: { accepted: true } },
    }));
  });
  const wss = new WebSocketServer({ noServer: true });
  let origin = '';
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ path: request.url!, headers: request.headers });
    if (options.stallUpgrade) { stalledSockets.push(socket); return; }
    if (request.url !== '/api/remote.mux' || request.headers.cookie !== COOKIE
      || request.headers.origin !== origin) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      allSockets.push(ws);
      ws.on('message', data => {
        const frame = JSON.parse(data.toString()) as Frame;
        mux.push(frame);
        if (frame.type !== 'open') return;
        sockets.set(frame.streamId, ws); openIds.push(frame.streamId);
        if (!options.noSnapshot) ws.send(JSON.stringify({
          type: 'item', streamId: frame.streamId, value: options.snapshot ?? snapshot(),
        }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  cleanup.push(async () => {
    allSockets.forEach(socket => socket.terminate());
    stalledSockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  return {
    origin, webUrl: origin + '/?token=' + TOKEN, rpc, mux, upgrades, openIds, sockets,
    send(streamId: string, frame: Frame) { sockets.get(streamId)!.send(JSON.stringify(frame)); },
    item(streamId: string, value: Frame) { sockets.get(streamId)!.send(JSON.stringify({ type: 'item', streamId, value })); },
    async client(timeoutMs = 1000) {
      const client = await DshLiveClient.connect({ webUrl: origin + '/?token=' + TOKEN, sessionId: SESSION, timeoutMs });
      cleanup.push(() => client.close()); return client;
    },
  };
}

describe('official dsh live Web client', () => {
  it('uses scoped cookie + exact unary/mux envelopes for the same already-live session', async () => {
    const host = await fixture(), client = await host.client();
    const stream = await client.follow({ assistantStream: true, maxMessages: 20 });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(snapshot());
    expect(host.upgrades).toHaveLength(1);
    expect(host.upgrades[0]).toMatchObject({
      path: '/api/remote.mux', headers: { cookie: COOKIE, origin: host.origin },
    });
    expect(host.mux[0]).toEqual({
      type: 'open', streamId: stream.streamId, endpoint: 'session/follow',
      payload: { args: { request: {
        assistantStream: true, maxMessages: 20, address: { kind: 'session', sessionId: SESSION },
      } } },
    });
    const accepted = await client.prompt({
      requestId: 'durable-request-1', content: [{ type: 'text', text: 'local fixture only' }],
    });
    expect(accepted).toEqual({ accepted: true });
    expect(accepted).not.toHaveProperty('completed');
    expect(host.rpc[0]).toMatchObject({
      path: '/api/session/prompt', headers: { cookie: COOKIE, origin: host.origin },
      envelope: {
        type: 'client-request', method: 'session/prompt',
        payload: { args: { request: {
          sessionId: SESSION, requestId: 'durable-request-1', mode: 'queue',
          content: [{ type: 'text', text: 'local fixture only' }],
        } } },
      },
    });
    expect(host.rpc[0]!.envelope.rpcId).not.toBe('durable-request-1');
    expect(() => Object.assign(client, { sessionId: 'foreign-session' })).toThrow();
    host.item(stream.streamId, event(1, 'user/message'));
    expect((await iterator.next()).value).toEqual(event(1, 'user/message'));
    for (const [revision, type] of [[1, 'start'], [2, 'chunk']] as const) {
      const value = { type: 'assistant-stream', frame: {
        type, attemptId: 'attempt-1', revision, startedAfterSeq: 1, turn: 1, step: 1,
        index: 0, time: 3, chunk: { type: 'text', text: 'visible fixture text' },
      } };
      host.item(stream.streamId, value); expect((await iterator.next()).value).toEqual(value);
    }
    host.item(stream.streamId, event(2, 'assistant/message'));
    expect((await iterator.next()).value).toEqual(event(2, 'assistant/message'));
    const settlement = { type: 'assistant-stream', frame: {
      type: 'end', attemptId: 'attempt-1', revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 },
    } };
    host.item(stream.streamId, settlement); expect((await iterator.next()).value).toEqual(settlement);
    await iterator.return!();
    await vi.waitFor(() => expect(host.mux.at(-1)).toEqual({ type: 'cancel', streamId: stream.streamId }));
    expect(host.rpc).toHaveLength(1);
    expect(host.mux.map(frame => frame.endpoint).filter(Boolean)).toEqual(['session/follow']);
  });

  it('rejects a different session snapshot before a caller can send to it', async () => {
    const host = await fixture({ snapshot: snapshot('another-session') }), client = await host.client();
    await expect(client.follow()).rejects.toMatchObject({ code: 'session_mismatch' });
    expect(host.rpc).toEqual([]);
  });

  it('keeps stream IDs isolated and treats error-without-end and unexpected end as observation failures', async () => {
    const host = await fixture(), client = await host.client();
    const first = await client.follow(), second = await client.follow();
    const a = first[Symbol.asyncIterator](), b = second[Symbol.asyncIterator]();
    await a.next(); await b.next();
    const pending = a.next();
    host.send(first.streamId, {
      type: 'error', streamId: first.streamId,
      error: { code: 'session/writer-held', message: TOKEN + COOKIE, details: { secret: TOKEN } },
    });
    await expect(pending).rejects.toMatchObject({ code: 'session/writer-held' });
    host.item(second.streamId, event(1));
    expect((await b.next()).value).toEqual(event(1));
    const ending = b.next();
    host.send(second.streamId, { type: 'end', streamId: second.streamId });
    await expect(ending).rejects.toMatchObject({ code: 'stream_ended' });
    expect(host.upgrades).toHaveLength(1);
  });

  it('locally settles unsubscribe without an acknowledgement and cancels a turn only explicitly', async () => {
    const host = await fixture(), client = await host.client();
    const stream = await client.follow(), iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    stream.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(host.mux.at(-1)).toEqual({ type: 'cancel', streamId: stream.streamId }));
    expect(host.rpc).toEqual([]);
    await expect(client.cancel()).resolves.toEqual({ accepted: true });
    expect(host.rpc[0]).toMatchObject({
      path: '/api/session/cancel',
      envelope: { method: 'session/cancel', payload: { args: { request: { sessionId: SESSION } } } },
    });
    client.close();
    expect(host.rpc).toHaveLength(1);
  });

  it.each([
    ['durable_sequence_gap', event(2)],
    ['assistant_revision_gap', { type: 'assistant-stream', frame: {
      type: 'start', attemptId: 'attempt', revision: 2, startedAfterSeq: 0, turn: 1, step: 1,
    } }],
  ])('fails %s while another same-session subscription remains usable', async (code, value) => {
    const host = await fixture(), client = await host.client();
    const first = await client.follow(), second = await client.follow();
    const a = first[Symbol.asyncIterator](), b = second[Symbol.asyncIterator]();
    await a.next(); await b.next();
    const pending = a.next(); host.item(first.streamId, value as Frame);
    await expect(pending).rejects.toMatchObject({ code });
    host.item(second.streamId, event(1));
    expect((await b.next()).value).toEqual(event(1));
    await vi.waitFor(() => expect(host.mux).toContainEqual({ type: 'cancel', streamId: first.streamId }));
  });

  it('times out a missing opening snapshot and sends cancel rather than uplink end', async () => {
    const host = await fixture({ noSnapshot: true }), client = await host.client(80);
    await expect(client.follow()).rejects.toMatchObject({ code: 'snapshot_timeout' });
    await vi.waitFor(() => expect(host.mux.at(-1)).toEqual({ type: 'cancel', streamId: host.openIds[0] }));
    expect(host.mux.some(frame => frame.type === 'end')).toBe(false);
  });

  it('aborts a subscription without touching the owner or another observer', async () => {
    const host = await fixture(), client = await host.client();
    const abort = new AbortController();
    const first = await client.follow({}, abort.signal), second = await client.follow();
    const a = first[Symbol.asyncIterator](), b = second[Symbol.asyncIterator]();
    await a.next(); await b.next();
    const pending = a.next(); abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    host.item(second.streamId, event(1));
    expect((await b.next()).value).toEqual(event(1));
    expect(host.rpc).toEqual([]);
  });

  it('reports physical disconnect and reconnects only on an explicit new follow with a new snapshot', async () => {
    const host = await fixture(), client = await host.client();
    const first = await client.follow(), a = first[Symbol.asyncIterator]();
    await a.next();
    const pending = a.next(); host.sockets.get(first.streamId)!.terminate();
    await expect(pending).rejects.toMatchObject({ code: 'connection_closed' });
    expect(host.rpc).toEqual([]); expect(host.upgrades).toHaveLength(1);
    const second = await client.follow(), b = second[Symbol.asyncIterator]();
    expect((await b.next()).value).toEqual(snapshot());
    expect(second.streamId).not.toBe(first.streamId);
    expect(host.upgrades).toHaveLength(2);
  });

  it('sanitizes auth/RPC failures and does not expose cookies or token URLs through inspection', async () => {
    const badAuth = await fixture({ authStatus: 401 });
    const authError = await DshLiveClient.connect({ webUrl: badAuth.webUrl, sessionId: SESSION }).catch(error => error);
    expect(authError).toMatchObject({ code: 'authentication_failed', status: 401 });
    expect(String(authError)).not.toContain(TOKEN);
    const host = await fixture({ remoteError: {
      code: 'session/not-found', message: TOKEN + COOKIE, details: { privateUrl: badAuth.webUrl },
    } }), client = await host.client();
    const error = await client.cancel().catch(error => error);
    expect(error).toMatchObject({ code: 'session/not-found' });
    const publicText = String(error) + JSON.stringify(error) + JSON.stringify(client);
    expect(publicText).not.toContain(TOKEN);
    expect(publicText).not.toContain(COOKIE);
    expect(publicText).not.toContain(host.origin);
    const redirect = await fixture({ location: 'http://example.invalid/?token=' + TOKEN });
    await expect(DshLiveClient.connect({ webUrl: redirect.webUrl, sessionId: SESSION }))
      .rejects.toMatchObject({ code: 'authentication_failed' });
    await expect(DshLiveClient.connect({ webUrl: 'https://example.invalid/?token=' + TOKEN, sessionId: SESSION }))
      .rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects mismatched RPC correlation instead of accepting an unrelated receipt', async () => {
    const host = await fixture({ wrongRpcId: true }), client = await host.client();
    await expect(client.cancel()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('redacts unrecognized remote error codes as well as error messages/details', async () => {
    const host = await fixture({ remoteError: { code: TOKEN, message: COOKIE, details: {} } });
    const client = await host.client();
    const error = await client.cancel().catch(error => error);
    expect(error).toMatchObject({ code: 'remote_error' });
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('aborts while the shared WebSocket handshake is still pending', async () => {
    const host = await fixture({ stallUpgrade: true }), client = await host.client();
    const abort = new AbortController(), opening = client.follow({}, abort.signal);
    await vi.waitFor(() => expect(host.upgrades).toHaveLength(1));
    abort.abort();
    await expect(opening).rejects.toMatchObject({ code: 'cancelled' });
    expect(host.mux).toEqual([]); expect(host.rpc).toEqual([]);
  });

  it('rejects malformed assistant settlement before passing it to a consumer', async () => {
    const host = await fixture(), client = await host.client();
    const follow = await client.follow({ assistantStream: true }), iterator = follow[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    host.item(follow.streamId, { type: 'assistant-stream', frame: {
      type: 'end', attemptId: 'attempt', revision: 1, index: 0,
      outcome: { kind: 'committed', eventType: 'assistant/message' },
    } });
    await expect(pending).rejects.toMatchObject({ code: 'invalid_follow_frame' });
  });

  it('rejects later use of a closed client without new network operations', async () => {
    const host = await fixture(), client = await host.client();
    client.close();
    await expect(client.follow()).rejects.toMatchObject({ code: 'client_closed' });
    await expect(client.cancel()).rejects.toMatchObject({ code: 'client_closed' });
    await expect(client.prompt({ requestId: 'not-sent', content: [{ type: 'text', text: 'fixture' }] }))
      .rejects.toMatchObject({ code: 'client_closed' });
    expect(host.upgrades).toEqual([]); expect(host.rpc).toEqual([]);
  });

  it('keeps headers and passive attach working in the runtime-aware TS subprocess', async () => {
    const host = await fixture();
    const child = spawnTsEvalWithRepoImports([
      "import { DshLiveClient } from './src/services/dsh-live-client.js';",
      'const client = await DshLiveClient.connect({webUrl:process.env.DSH_QA_WEB_URL,sessionId:"same-live-session"});',
      'const follow = await client.follow();',
      'for await (const frame of follow) { console.log(JSON.stringify({type:frame.type,id:frame.header.id})); break; }',
      'client.close();',
    ].join('\n'), {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      env: { ...process.env, DSH_QA_WEB_URL: host.webUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanup.push(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => { stdout += data.toString(); });
    child.stderr!.on('data', data => { stderr += data.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ type: 'snapshot', id: SESSION });
    expect(stdout + stderr).not.toContain(TOKEN);
    expect(stdout + stderr).not.toContain(COOKIE);
    expect(host.rpc).toEqual([]);
  });
});
