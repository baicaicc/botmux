import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { TerminalDeviceGateway } from '../src/core/terminal-device-gateway.js';
import { TerminalDeviceStore } from '../src/core/terminal-device-store.js';
import { verifyTerminalControlGrant, type TerminalControlGrantClaims } from '../src/core/terminal-control-grant.js';
import { startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const SID_C = '33333333-3333-4333-8333-333333333333';
const OWNER = 'owner-original-lark';
const ORIGIN = 'https://terminal.example.test';
const SECRET = 'test-only-loopback-signing-secret';
const COOKIE_NAME = '__Host-botmux_terminal_device';

interface Fixture {
  dataDir: string;
  store: TerminalDeviceStore;
  proxy: TerminalProxyHandle;
  gateway: TerminalDeviceGateway;
  worker: Server;
  wss: WebSocketServer;
  workerRequests: Array<{ path: string; headers: IncomingHttpHeaders; claims: TerminalControlGrantClaims | null }>;
  notifications: Array<{ sessionId: string; code: string; scope: 'read' | 'write' }>;
  resolved: string[];
  sockets: Set<Socket>;
  clients: Set<WebSocket>;
  sessions: Map<string, { ownerId: string; writeToken: string; viewToken: string }>;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const ws of f.clients) ws.terminate();
    for (const ws of f.wss.clients) ws.terminate();
    for (const socket of f.sockets) socket.destroy();
    await f.proxy.close();
    await new Promise<void>(resolve => f.wss.close(() => resolve()));
    f.worker.closeAllConnections();
    await new Promise<void>(resolve => f.worker.close(() => resolve()));
    rmSync(f.dataDir, { recursive: true, force: true });
  }
});

async function fixture(options: { notifyPairing?: () => Promise<void>; legacyCookieNames?: RegExp } = {}): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-device-gateway-'));
  const sessions = new Map([
    [SID_A, { ownerId: OWNER, writeToken: 'session-a-private-write', viewToken: 'session-a-private-view' }],
    [SID_B, { ownerId: OWNER, writeToken: 'session-b-private-write', viewToken: 'session-b-private-view' }],
    [SID_C, { ownerId: 'different-owner', writeToken: 'session-c-private-write', viewToken: 'session-c-private-view' }],
  ]);
  const store = new TerminalDeviceStore({ dataDir, botId: 'bot-under-test' });
  const notifications: Fixture['notifications'] = [];
  const resolved: string[] = [];
  const workerRequests: Fixture['workerRequests'] = [];
  const sockets = new Set<Socket>();
  function inspect(path: string, headers: IncomingHttpHeaders): TerminalControlGrantClaims | null {
    let claims: TerminalControlGrantClaims | null = null;
    for (const sid of sessions.keys()) {
      const result = verifyTerminalControlGrant(SECRET, headers['x-botmux-terminal-control'], sid);
      if (result.ok) { claims = result.claims; break; }
    }
    workerRequests.push({ path, headers, claims });
    return claims;
  }
  const worker = createServer((req, res) => {
    const claims = inspect(req.url ?? '', req.headers);
    res.writeHead(claims ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, claims }));
  });
  worker.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ server: worker });
  wss.on('connection', (ws, req) => {
    const claims = inspect(req.url ?? '', req.headers);
    if (!claims) { ws.close(1008, 'invalid native grant'); return; }
    ws.send(JSON.stringify({ path: req.url, claims }));
    ws.on('message', data => ws.send(`echo:${data.toString()}`));
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  const workerPort = (worker.address() as { port: number }).port;
  const gateway = new TerminalDeviceGateway({
    store, origin: ORIGIN, secret: () => SECRET,
    ...(options.legacyCookieNames ? { legacyCookieNames: options.legacyCookieNames } : {}),
    session: sid => sessions.get(sid) ?? null,
    notifyPairing: async (sessionId, code, scope) => {
      notifications.push({ sessionId, code, scope });
      await options.notifyPairing?.();
    },
  });
  const proxy = await startTerminalProxy({
    port: 0, host: '127.0.0.1',
    resolvePort: sid => { resolved.push(sid); return sessions.has(sid) ? workerPort : undefined; },
    authorizeRequest: request => gateway.authorize(request),
  });
  const f = { dataDir, store, proxy, gateway, worker, wss, workerRequests, notifications, resolved, sockets, clients: new Set<WebSocket>(), sessions };
  fixtures.push(f);
  return f;
}

function url(f: Fixture, rest: string, sid = SID_A): string {
  return `http://127.0.0.1:${f.proxy.port}/s/${sid}/${rest}`;
}

function request(f: Fixture, rest: string, cookie?: string, sid = SID_A, extra: RequestInit = {}): Promise<Response> {
  return fetch(url(f, rest, sid), {
    redirect: 'manual', ...extra,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...extra.headers },
  });
}

async function beginPair(f: Fixture, scope: 'read' | 'write' = 'read', sid = SID_A) {
  const session = f.sessions.get(sid)!;
  const capability = scope === 'write' ? `token=${session.writeToken}` : `viewToken=${session.viewToken}`;
  const response = await request(f, `?${capability}`);
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie')!;
  const cookie = setCookie.split(';', 1)[0];
  const browserToken = cookie.slice(COOKIE_NAME.length + 1);
  const notification = f.notifications.at(-1)!;
  return { response, cookie, browserToken, notification };
}

async function paired(f: Fixture, scope: 'read' | 'write' = 'read', sid = SID_A) {
  const pair = await beginPair(f, scope, sid);
  expect(f.store.approve({ code: pair.notification.code, sessionId: sid, ownerId: f.sessions.get(sid)!.ownerId }).ok).toBe(true);
  return pair;
}

async function openWs(f: Fixture, cookie: string, scope: 'read' | 'write' = 'read', sid = SID_A) {
  const ws = new WebSocket(url(f, `?access=${scope}`, sid).replace('http:', 'ws:'), { headers: { Cookie: cookie, Origin: ORIGIN } });
  f.clients.add(ws);
  const first = await new Promise<{ path: string; claims: TerminalControlGrantClaims }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS hello timeout')), 3_000);
    ws.once('message', data => { clearTimeout(timeout); resolve(JSON.parse(data.toString())); });
    ws.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return { ws, first };
}

async function deniedWs(f: Fixture, rest: string, cookie?: string, origin: string | null = ORIGIN, sid = SID_A): Promise<number> {
  const ws = new WebSocket(url(f, rest, sid).replace('http:', 'ws:'), {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin === null ? {} : { Origin: origin }) },
  });
  f.clients.add(ws);
  ws.on('error', () => {});
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('WS rejection timeout')); }, 3_000);
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timeout);
      res.resume();
      ws.terminate();
      resolve(res.statusCode!);
    });
    ws.once('open', () => { clearTimeout(timeout); ws.terminate(); reject(new Error('forbidden WS opened')); });
  });
}

async function rawRequest(f: Fixture, path: string, headers: string[], method = 'GET'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(f.proxy.port, '127.0.0.1', () => {
      socket.write(`${method} /s/${SID_A}/${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    });
    f.sockets.add(socket);
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('raw request timeout')); }, 3_000);
    let received = '';
    socket.on('data', chunk => { received += chunk.toString(); });
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
    socket.once('close', () => { clearTimeout(timeout); resolve(received); });
  });
}

describe('terminal device gateway with real HTTP and WebSocket proxy', () => {
  it('serves pairing for an unpaired valid capability without resolving or contacting a worker', async () => {
    const f = await fixture();
    const pair = await beginPair(f, 'write');
    const html = await pair.response.text();
    expect(html).toContain(pair.notification.code);
    expect(html).toContain('本次只授权当前会话的查看和操作');
    expect(html).not.toContain(f.sessions.get(SID_A)!.writeToken);
    expect(pair.response.headers.get('set-cookie')).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+/);
    expect(pair.cookie).toMatch(/^__Host-botmux_terminal_device=[A-Za-z0-9_-]{43}$/);
    expect(pair.response.headers.get('cache-control')).toBe('no-store');
    expect(pair.response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(pair.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(f.notifications).toHaveLength(1);
    expect(f.resolved).toEqual([]);
    expect(f.workerRequests).toEqual([]);
  });

  it('only the original owner can approve, after which a clean session cookie grants native read access', async () => {
    const f = await fixture();
    const pair = await beginPair(f);
    expect(f.store.approve({ code: pair.notification.code, sessionId: SID_A, ownerId: 'other-lark-user' })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect((await request(f, '?access=read', pair.cookie)).status).toBe(403);
    expect((await request(f, '_device/status?access=read', pair.cookie)).status).toBe(200);
    expect(await (await request(f, '_device/status?access=read', pair.cookie)).json()).toEqual({ paired: false });
    expect(f.store.approve({ code: pair.notification.code, sessionId: SID_B, ownerId: OWNER })).toEqual({ ok: false, reason: 'session_mismatch' });
    expect(f.store.approve({ code: pair.notification.code, sessionId: SID_A, ownerId: OWNER }).ok).toBe(true);
    expect(await (await request(f, '_device/status?access=read', pair.cookie)).json()).toEqual({ paired: true });
    const response = await request(f, '?access=read', pair.cookie);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.path).toBe('/?access=read');
    expect(body.claims).toMatchObject({ scope: 'read', sessionId: SID_A, userId: OWNER });
    expect(body.claims.expiresAt - body.claims.issuedAt).toBeLessThanOrEqual(30 * 60_000);
    const { ws, first } = await openWs(f, pair.cookie);
    expect(first.claims).toMatchObject({ scope: 'read', sessionId: SID_A, userId: OWNER });
    const echoed = new Promise<string>(resolve => ws.once('message', data => resolve(data.toString())));
    ws.send('round-trip');
    expect(await echoed).toBe('echo:round-trip');
  });

  it('keeps the browser credential and short code usable when Lark notification fails, then retries delivery without changing the pair', async () => {
    let failDelivery = true;
    const f = await fixture({ notifyPairing: async () => { if (failDelivery) throw new Error('test delivery unavailable'); } });
    const pair = await beginPair(f);
    const firstPage = await pair.response.text();
    expect(firstPage).toContain('Lark 配对卡片暂未送达');
    expect(firstPage).toContain(`/term pair ${pair.notification.code}`);
    expect((await request(f, '?access=read', pair.cookie)).status).toBe(403);
    failDelivery = false;
    const retried = await request(f, `?viewToken=${f.sessions.get(SID_A)!.viewToken}`, pair.cookie);
    expect(retried.status).toBe(200);
    expect(retried.headers.get('set-cookie')!.split(';', 1)[0]).toBe(pair.cookie);
    expect(await retried.text()).not.toContain('Lark 配对卡片暂未送达');
    expect(f.notifications).toHaveLength(2);
    expect(f.notifications[1]).toEqual(pair.notification);
    const reopened = await request(f, `?viewToken=${f.sessions.get(SID_A)!.viewToken}`, pair.cookie);
    expect(reopened.status).toBe(200);
    expect(f.notifications).toHaveLength(2);
    expect(f.workerRequests).toHaveLength(0);
    expect(f.store.approve({ code: pair.notification.code, sessionId: SID_A, ownerId: OWNER }).ok).toBe(true);
    expect((await request(f, '?access=read', pair.cookie)).status).toBe(200);
  });

  it('allows approved write while read mode continues to mint a read-only grant', async () => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    const response = await request(f, '?access=write', pair.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).claims.scope).toBe('write');
    expect((await (await request(f, '?access=read', pair.cookie)).json()).claims.scope).toBe('read');
    expect((await openWs(f, pair.cookie, 'write')).first.claims.scope).toBe('write');
  });

  it('a view capability plus access=write cannot upgrade either a new or an already paired browser', async () => {
    const f = await fixture();
    const response = await request(f, `?viewToken=${f.sessions.get(SID_A)!.viewToken}&access=write`);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    const pair = f.notifications.at(-1)!;
    expect(pair.scope).toBe('read');
    expect(f.store.approve({ code: pair.code, sessionId: SID_A, ownerId: OWNER }).ok).toBe(true);
    expect((await request(f, '?access=write', cookie)).status).toBe(403);
    expect(await deniedWs(f, '?access=write', cookie)).toBe(403);
    const reopened = await request(f, `?viewToken=${f.sessions.get(SID_A)!.viewToken}&access=write`, cookie);
    expect(reopened.status).toBe(303);
    expect(reopened.headers.get('location')).toBe(`/s/${SID_A}/?access=read`);
    expect((await request(f, '?access=write', cookie)).status).toBe(403);
    expect(f.workerRequests).toHaveLength(0);
  });

  it('redeems a current session capability once into a clean 303 and reuses remembered identity for a different authorized session', async () => {
    const f = await fixture();
    const pair = await paired(f);
    const capB = f.sessions.get(SID_B)!.writeToken;
    expect((await request(f, '?access=read', pair.cookie, SID_B)).status).toBe(403);
    expect(await deniedWs(f, '?access=read', pair.cookie, ORIGIN, SID_B)).toBe(403);
    const redeemed = await request(f, `?token=${capB}&unused=do-not-reflect`, pair.cookie, SID_B);
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get('location')).toBe(`/s/${SID_B}/?access=write`);
    expect(redeemed.headers.get('location')).not.toContain(capB);
    expect(await redeemed.text()).toBe('');
    expect(redeemed.headers.get('set-cookie')).toBeNull();
    expect(f.notifications).toHaveLength(1);
    expect(f.workerRequests).toHaveLength(0);
    const response = await request(f, '?access=write', pair.cookie, SID_B);
    expect(response.status).toBe(200);
    expect((await response.json()).claims).toMatchObject({ sessionId: SID_B, scope: 'write' });
    expect((await request(f, '?access=write', pair.cookie, SID_A)).status).toBe(403);
  });

  it('requires fresh approval when a valid capability belongs to a different owner', async () => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    const response = await request(f, `?token=${f.sessions.get(SID_C)!.writeToken}`, pair.cookie, SID_C);
    expect(response.status).toBe(200);
    const newCookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    expect(newCookie).not.toBe(pair.cookie);
    expect(await deniedWs(f, '?access=write', pair.cookie, ORIGIN, SID_C)).toBe(403);
    expect((await request(f, '?access=write', newCookie, SID_C)).status).toBe(403);
    const pending = f.notifications.at(-1)!;
    expect(f.store.approve({ code: pending.code, sessionId: SID_C, ownerId: OWNER })).toEqual({ ok: false, reason: 'owner_mismatch' });
    expect(f.notifications).toHaveLength(2);
    expect(f.workerRequests).toHaveLength(0);
    expect(f.store.approve({ code: pending.code, sessionId: SID_C, ownerId: 'different-owner' }).ok).toBe(true);
    const current = await request(f, '?access=write', newCookie, SID_C);
    expect(current.status).toBe(200);
    expect((await current.json()).claims).toMatchObject({ sessionId: SID_C, userId: 'different-owner', scope: 'write' });
    expect((await request(f, '?access=write', newCookie, SID_A)).status).toBe(403);
    expect((await request(f, '?access=write', pair.cookie, SID_C)).status).toBe(403);
  });

  it.each([
    '?token=forged', '?viewToken=forged',
    '?token=session-a-private-write&token=session-a-private-write',
    '?viewToken=session-a-private-view&viewToken=session-a-private-view',
    '?token=session-a-private-write&viewToken=session-a-private-view',
    '?token=&viewToken=session-a-private-view',
  ])('rejects forged or ambiguous query credentials: %s', async rest => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    expect((await request(f, rest, pair.cookie)).status).toBe(403);
    expect(await deniedWs(f, rest, pair.cookie)).toBe(403);
    expect(f.workerRequests).toHaveLength(0);
  });

  it('rejects another session capability and unpaired direct WS upgrades even if the capability is valid', async () => {
    const f = await fixture();
    expect((await request(f, `?token=${f.sessions.get(SID_B)!.writeToken}`)).status).toBe(403);
    expect(await deniedWs(f, `?token=${f.sessions.get(SID_A)!.writeToken}`)).toBe(403);
    expect(f.notifications).toHaveLength(0);
    expect(f.resolved).toHaveLength(0);
  });

  it('ignores forged internal grants, dashboard cookies, authorization, forwarding and role headers before pairing', async () => {
    const f = await fixture();
    const response = await request(f, '?access=write', 'botmux_dashboard_token=forged', SID_A, {
      headers: {
        Authorization: 'Bearer forged', 'X-Botmux-Role': 'owner',
        'X-Botmux-Terminal-Control': 'forged', 'X-Botmux-Terminal-View': 'forged',
        'CF-Access-Jwt-Assertion': 'forged', 'X-Forwarded-Host': 'trusted.example.test',
      },
    });
    expect(response.status).toBe(403);
    expect(f.workerRequests).toHaveLength(0);
    expect(f.resolved).toHaveLength(0);
  });

  it('strips browser/internal credentials and signs its own exact scope on the loopback worker hop', async () => {
    const f = await fixture();
    const pair = await paired(f);
    const response = await request(f, '?access=read', `${pair.cookie}; botmux_dashboard_token=forged`, SID_A, {
      headers: {
        Authorization: 'Bearer forged', 'X-Botmux-Role': 'owner',
        'X-Botmux-Terminal-Control': 'forged', 'X-Botmux-Terminal-View': 'forged',
        'CF-Access-Jwt-Assertion': 'forged', Forwarded: 'host=attacker',
        'X-Forwarded-Host': 'attacker', 'X-Forwarded-Proto': 'https',
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).claims.scope).toBe('read');
    const forwarded = f.workerRequests.at(-1)!.headers;
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded.authorization).toBeUndefined();
    expect(forwarded['x-botmux-role']).toBeUndefined();
    expect(forwarded['x-botmux-terminal-view']).toBeUndefined();
    expect(forwarded['cf-access-jwt-assertion']).toBeUndefined();
    expect(forwarded.forwarded).toBeUndefined();
    expect(forwarded['x-forwarded-host']).toBeUndefined();
    expect(forwarded['x-forwarded-proto']).toBeUndefined();
    expect(forwarded['x-botmux-terminal-control']).not.toBe('forged');
  });

  it('requires the fixed origin for WS and browser revocation POST', async () => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    expect(await deniedWs(f, '?access=write', pair.cookie, null)).toBe(403);
    expect(await deniedWs(f, '?access=write', pair.cookie, 'https://attacker.test')).toBe(403);
    expect((await request(f, '?access=read', pair.cookie, SID_A, { headers: { Origin: 'https://attacker.test' } })).status).toBe(403);
    expect((await request(f, '_device/forget', pair.cookie, SID_A, { method: 'POST' })).status).toBe(403);
    expect((await request(f, '_device/forget', pair.cookie, SID_A, { method: 'POST', headers: { Origin: 'https://attacker.test' } })).status).toBe(403);
    expect(f.store.identity(pair.browserToken)).not.toBeNull();
    const forgotten = await request(f, '_device/forget', pair.cookie, SID_A, { method: 'POST', headers: { Origin: ORIGIN } });
    expect(forgotten.status).toBe(200);
    expect(forgotten.headers.get('set-cookie')).toBe(`${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    expect(f.store.identity(pair.browserToken)).toBeNull();
    expect((await request(f, '?access=read', pair.cookie)).status).toBe(403);
    expect(f.workerRequests).toHaveLength(0);
  });

  it('rejects duplicate authentication headers and duplicate device cookie values', async () => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    for (const headers of [
      ['Host: x', 'Host: y', `Cookie: ${pair.cookie}`],
      ['Host: x', `Cookie: ${pair.cookie}`, `Cookie: ${pair.cookie}`],
      ['Host: x', `Cookie: ${pair.cookie}`, `Origin: ${ORIGIN}`, `Origin: ${ORIGIN}`],
      ['Host: x', `Cookie: ${pair.cookie}`, 'Content-Length: 0', 'Content-Length: 0'],
    ]) {
      expect(await rawRequest(f, '?access=write', headers)).toMatch(/^HTTP\/1\.1 400 /);
    }
    const response = await request(f, '?access=write', `${pair.cookie}; ${pair.cookie}`);
    expect(response.status).toBe(403);
    expect(await deniedWs(f, '?access=write', `${pair.cookie}; ${pair.cookie}`)).toBe(403);
    expect(f.workerRequests).toHaveLength(0);
  });

  it('refuses request bodies and unsupported routes before contacting a worker', async () => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    for (const headers of [
      ['Host: x', `Cookie: ${pair.cookie}`, 'Transfer-Encoding: chunked'],
      ['Host: x', `Cookie: ${pair.cookie}`, 'Content-Length: 1'],
    ]) {
      expect(await rawRequest(f, '?access=write', headers)).toMatch(/^HTTP\/1\.1 400 /);
    }
    expect((await request(f, 'api/sessions', pair.cookie)).status).toBe(404);
    expect((await request(f, '_device/status', pair.cookie, SID_A, { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(405);
    expect((await request(f, '?access=write', pair.cookie, SID_A, { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(405);
    expect(f.workerRequests).toHaveLength(0);
  });

  it('does not allow an Upgrade header without a WS handshake to bypass authorization on a pipelined HTTP request', async () => {
    const f = await fixture();
    const pair = await paired(f);
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect(f.proxy.port, '127.0.0.1', () => {
        socket.write(
          `GET /s/${SID_A}/?access=read HTTP/1.1\r\nHost: x\r\nCookie: ${pair.cookie}\r\nOrigin: ${ORIGIN}\r\nUpgrade: websocket\r\nConnection: keep-alive\r\n\r\n`
          + `GET /s/${SID_B}/?token=${f.sessions.get(SID_B)!.writeToken} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
        );
      });
      f.sockets.add(socket);
      let raw = '';
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('pipelined HTTP guard timeout')); }, 3_000);
      socket.on('data', chunk => { raw += chunk.toString(); });
      socket.once('error', error => { clearTimeout(timeout); reject(error); });
      socket.once('close', () => { clearTimeout(timeout); resolve(raw); });
    });
    expect(received).toMatch(/^HTTP\/1\.1 /);
    expect(f.workerRequests.length).toBeLessThanOrEqual(1);
    expect(f.workerRequests.some(req => req.path.includes(SID_B))).toBe(false);
    expect(f.resolved).not.toContain(SID_B);
  });

  it('survives gateway and proxy restart using the same private store and keeps session permissions scoped', async () => {
    const f = await fixture();
    const pair = await paired(f);
    await f.proxy.close();
    f.store = new TerminalDeviceStore({ dataDir: f.dataDir, botId: 'bot-under-test' });
    f.gateway = new TerminalDeviceGateway({
      store: f.store, origin: ORIGIN, secret: () => SECRET,
      session: sid => f.sessions.get(sid) ?? null,
      notifyPairing: async (sessionId, code, scope) => { f.notifications.push({ sessionId, code, scope }); },
    });
    const port = (f.worker.address() as { port: number }).port;
    f.proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => port, authorizeRequest: req => f.gateway.authorize(req) });
    const response = await request(f, '?access=read', pair.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).claims).toMatchObject({ scope: 'read', sessionId: SID_A });
    expect((await request(f, '?access=write', pair.cookie)).status).toBe(403);
    expect((await request(f, '?access=read', pair.cookie, SID_B)).status).toBe(403);
    expect(f.notifications).toHaveLength(1);
  });

  it('revoking a remembered device closes its existing stream and prevents new HTTP and WS access', async () => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    const { ws } = await openWs(f, pair.cookie, 'write');
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('revoked WS stayed open')), 7_000);
      ws.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    expect(f.store.revoke(pair.browserToken)).toBe(true);
    await closed;
    expect((await request(f, '?access=write', pair.cookie)).status).toBe(403);
    expect(await deniedWs(f, '?access=write', pair.cookie)).toBe(403);
    expect(f.workerRequests).toHaveLength(1);
  });

  it('revoking one session closes only that stream while another authorized session and device identity remain valid', async () => {
    const f = await fixture();
    const pair = await paired(f, 'write');
    const redeemed = await request(f, `?token=${f.sessions.get(SID_B)!.writeToken}`, pair.cookie, SID_B);
    expect(redeemed.status).toBe(303);
    const a = await openWs(f, pair.cookie, 'write');
    const b = await openWs(f, pair.cookie, 'write', SID_B);
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('session-revoked WS stayed open')), 7_000);
      a.ws.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    expect(f.store.revokeSession({ sessionId: SID_A, ownerId: OWNER })).toBeGreaterThan(0);
    await closed;
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect(f.store.identity(pair.browserToken)).not.toBeNull();
    expect((await request(f, '?access=write', pair.cookie)).status).toBe(403);
    expect((await request(f, '?access=write', pair.cookie, SID_B)).status).toBe(200);
    const echoed = new Promise<string>(resolve => b.ws.once('message', data => resolve(data.toString())));
    b.ws.send('still-authorized');
    expect(await echoed).toBe('echo:still-authorized');
  });
});

describe('deployment-wide device identity (legacy per-bot cookies)', () => {
  const LEGACY = '__Host-botmux_terminal_device_abcdef012345';

  it('accepts a paired device under a legacy per-bot cookie name and clears that name on forget', async () => {
    const f = await fixture({ legacyCookieNames: /^__Host-botmux_terminal_device_[0-9a-f]{12}$/ });
    const pair = await paired(f);
    const legacyCookie = `${LEGACY}=${pair.browserToken}`;
    const { first } = await openWs(f, `unrelated=1; ${legacyCookie}`);
    expect(first.claims.scope).toBe('read');
    // A stale current-name cookie does not hide a valid legacy one.
    expect((await request(f, '', `${COOKIE_NAME}=${'A'.repeat(43)}; ${legacyCookie}`)).status).toBe(200);
    const forget = await request(f, '_device/forget', legacyCookie, SID_A, { method: 'POST', headers: { Origin: ORIGIN } });
    expect(forget.status).toBe(200);
    expect(forget.headers.get('set-cookie')).toBe(`${LEGACY}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    expect(f.store.identity(pair.browserToken)).toBeNull();
    expect((await request(f, '', legacyCookie)).status).toBe(403);
  });

  it('ignores legacy cookie names unless configured, and names outside the pattern', async () => {
    const plain = await fixture();
    const token = (await paired(plain)).browserToken;
    expect((await request(plain, '', `${LEGACY}=${token}`)).status).toBe(403);
    const f = await fixture({ legacyCookieNames: /^__Host-botmux_terminal_device_[0-9a-f]{12}$/ });
    const other = (await paired(f)).browserToken;
    expect((await request(f, '', `__Host-other=${other}`)).status).toBe(403);
  });
});
