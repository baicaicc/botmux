import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from './helpers/node-ws.js';
import { spawnTsScript } from './helpers/ts-runner.js';

describe('dsh adapter entry with a per-bot live connection', () => {
  it('uses the bound Web owner without launching the legacy dsh child; EOF detaches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'botmux-dsh-entry-'));
    const token = 'private-fixture-token', cookie = 'dsh-session=private-fixture-cookie';
    const sessionId = 'bound-native-session';
    let auth = 0, prompts = 0, subscriptions = 0, cancellations = 0;
    const server = createServer((request, response) => {
      if (request.url === '/?token=' + token) {
        auth++; response.writeHead(303, { location: './', 'set-cookie': cookie + '; HttpOnly' });
        response.end(); return;
      }
      if (request.method === 'POST') prompts++;
      response.writeHead(404); response.end();
    });
    const ws = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/api/remote.mux' || request.headers.cookie !== cookie) { socket.destroy(); return; }
      ws.handleUpgrade(request, socket, head, client => ws.emit('connection', client));
    });
    ws.on('connection', client => {
      client.on('message', bytes => {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === 'open') {
          subscriptions++;
          expect(frame.endpoint).toBe('session/follow');
          expect(frame.payload.args.request.address).toEqual({ kind: 'session', sessionId });
          client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: {
            type: 'snapshot', header: { id: sessionId, version: 1, createdAt: 1, isSeeded: false, cwd: root },
            cursor: 0, records: [], hasMore: false, projections: { asOfSeq: 0, values: {} },
            assistantStream: { revision: 0 },
          } }));
        } else if (frame.type === 'cancel') cancellations++;
      });
    });
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
    const port = (server.address() as AddressInfo).port;
    const file = join(root, 'connection.json');
    await writeFile(file, JSON.stringify({ webUrl: `http://127.0.0.1:${port}/?token=${token}`, sessionId, cwd: root }), { mode: 0o600 });
    const child = spawnTsScript(resolve('src/dsh-runner.ts'), [
      '--session-id', 'botmux-routing-id', '--cwd', root,
      '--dsh-bin', '/never-spawn-this-dsh', '--dsh-profile', 'botmux', '--bridge-patch', '/unused-legacy-patch',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_LIVE_CONNECTION_FILE: file } });
    let output = '', errors = '';
    child.stdout!.on('data', value => { output += value.toString(); });
    child.stderr!.on('data', value => { errors += value.toString(); });
    const finished = new Promise<number | null>((yes, no) => { child.once('exit', yes); child.once('error', no); });
    try {
      for (let i = 0; i < 100 && !output.includes('› '); i++) {
        if (child.exitCode !== null) break;
        await new Promise(yes => setTimeout(yes, 30));
      }
      expect(output, errors).toContain('› ');
      child.stdin!.end();
      const timeout = setTimeout(() => child.kill('SIGTERM'), 3000);
      try { expect(await finished).toBe(0); } finally { clearTimeout(timeout); }
      expect(auth).toBe(1); expect(subscriptions).toBe(1); expect(prompts).toBe(0);
      expect(cancellations).toBe(1);
      expect(server.listening).toBe(true);
      expect(output + errors).not.toContain(token);
      expect(output + errors).not.toContain(cookie);
      expect(output + errors).not.toContain('never-spawn-this-dsh');
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      for (const client of ws.clients) client.terminate();
      await new Promise<void>(yes => ws.close(() => yes()));
      await new Promise<void>(yes => server.close(() => yes()));
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
