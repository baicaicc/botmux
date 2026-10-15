import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { tmuxEnv } from '../src/setup/ensure-tmux.js';

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('private tmux server did not become ready');
    await delay(10);
  }
}

it.skipIf(process.platform !== 'linux' || spawnSync('tmux', ['-V'], { timeout: 3000 }).status !== 0)(
  'permits a real cold start but preserves an unlinked live server and its pane', async () => {
    // A short, private path with a space exercises the real stderr/proc format.
    // -D keeps this server in a child process we own, even after unlink; cleanup
    // never needs to contact the user's default server or guess a server PID.
    const socketRoot = mkdtempSync('/tmp/bmx cold-');
    vi.stubEnv('TMUX_TMPDIR', socketRoot);
    const socketPath = join(socketRoot, `tmux-${process.getuid!()}`, 'default');
    const name = 'cold-start-instance';
    const env = tmuxEnv();
    const tmux = (args: string[]) => execFileSync('tmux', args, {
      env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    let server: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> | undefined;
    try {
      expect(TmuxBackend.probeSession(name)).toBe('unknown');
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      expect(existsSync(socketPath)).toBe(false);

      server = spawn('tmux', ['-D', '-f', '/dev/null'], { env, stdio: 'ignore' });
      exited = new Promise<void>(resolve => {
        server!.once('exit', () => resolve());
        server!.once('error', () => resolve());
      });
      await waitUntil(() => existsSync(socketPath));
      tmux(['new-session', '-d', '-s', name, '-e', 'BOTMUX_CODEX_INSTANCE_BINDING=binding-a', '/bin/sleep', '60']);
      expect(Number(tmux(['display-message', '-p', '-t', name, '#{pid}']))).toBe(server.pid);
      expect(tmux(['display-message', '-p', '-t', name, '#{socket_path}'])).toBe(socketPath);
      const panePid = tmux(['display-message', '-p', '-t', name, '#{pane_pid}']);
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-b')).toThrow(/preserved/);

      unlinkSync(socketPath);
      expect(readFileSync('/proc/net/unix', 'utf8')).toContain(` ${socketPath}\n`);
      expect(TmuxBackend.probeSession(name)).toBe('unknown');
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).toThrow(/preserved/);
      expect(() => process.kill(Number(panePid), 0)).not.toThrow();

      server.kill('SIGUSR1');
      await waitUntil(() => existsSync(socketPath));
      expect(() => TmuxBackend.assertInstanceIdentity(name, 'binding-a')).not.toThrow();
      expect(tmux(['display-message', '-p', '-t', name, '#{pane_pid}'])).toBe(panePid);
    } finally {
      if (server && exited) {
        server.kill('SIGTERM');
        await Promise.race([exited, delay(3000)]);
        if (server.exitCode === null && server.signalCode === null) {
          server.kill('SIGKILL');
          await exited;
        }
      }
      vi.unstubAllEnvs();
      rmSync(socketRoot, { recursive: true, force: true });
    }
  },
);
