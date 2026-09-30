import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearScopeProblemNotification, notifyScopeProblemOnce } from '../src/services/scope-notification-store.js';
import { logger } from '../src/utils/logger.js';

let dir: string;
const state = {
  larkAppId: 'cli_scope_test', adminOpenId: 'ou_admin', problem: 'missing-critical' as const,
  missingScopes: ['im:chat.members:read', 'im:message'],
};
const recordPath = () => join(dir, 'scope-notified-cli_scope_test.json');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scope-notification-'));
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('persisted scope reminders', () => {
  it('waits for a successful send and saves a private record', async () => {
    let resolve!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const pending = notifyScopeProblemOnce(dir, state, send);
    expect(existsSync(recordPath())).toBe(false);
    resolve(true);
    expect(await pending).toBe('delivered');
    expect(statSync(recordPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toMatchObject(state);
  });

  it('suppresses the same state in a fresh process, independent of elapsed time', async () => {
    await notifyScopeProblemOnce(dir, state, async () => true);
    const record = JSON.parse(readFileSync(recordPath(), 'utf8'));
    writeFileSync(recordPath(), JSON.stringify({ ...record, notifiedAt: 1 }));
    const helper = new URL('../src/services/scope-notification-store.ts', import.meta.url).href;
    const script = `import { notifyScopeProblemOnce } from ${JSON.stringify(helper)};
      const result = await notifyScopeProblemOnce(${JSON.stringify(dir)}, ${JSON.stringify(state)}, async () => {
        throw new Error('duplicate delivery after restart');
      }); console.log(JSON.stringify({ result }));`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim().split('\n').at(-1)!)).toEqual({ result: 'unchanged' });
  });

  it('retries failed delivery without writing notification state', async () => {
    const send = vi.fn(async () => false);
    expect(await notifyScopeProblemOnce(dir, state, send)).toBe('failed');
    expect(existsSync(recordPath())).toBe(false);
    send.mockResolvedValue(true);
    expect(await notifyScopeProblemOnce(dir, state, send)).toBe('delivered');
    expect(await notifyScopeProblemOnce(dir, state, send)).toBe('unchanged');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not mark a thrown send as delivered', async () => {
    await expect(notifyScopeProblemOnce(dir, state, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(existsSync(recordPath())).toBe(false);
    expect(await notifyScopeProblemOnce(dir, state, async () => true)).toBe('delivered');
  });

  it('normalizes the missing set and reminds again when scopes, admin or app changes', async () => {
    const send = vi.fn(async () => true);
    await notifyScopeProblemOnce(dir, state, send);
    expect(await notifyScopeProblemOnce(dir, { ...state, missingScopes: [...state.missingScopes].reverse().concat('im:message') }, send)).toBe('unchanged');
    expect(await notifyScopeProblemOnce(dir, { ...state, missingScopes: ['im:message'] }, send)).toBe('delivered');
    expect(await notifyScopeProblemOnce(dir, { ...state, adminOpenId: 'ou_new_admin', missingScopes: ['im:message'] }, send)).toBe('delivered');
    expect(await notifyScopeProblemOnce(dir, { ...state, larkAppId: 'cli_other' }, send)).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('clears a recovered condition so the same failure can notify later', async () => {
    const send = vi.fn(async () => true);
    await notifyScopeProblemOnce(dir, state, send);
    clearScopeProblemNotification(dir, state.larkAppId, 'self-manage');
    expect(await notifyScopeProblemOnce(dir, state, send)).toBe('unchanged');
    clearScopeProblemNotification(dir, state.larkAppId, 'missing-critical');
    expect(existsSync(recordPath())).toBe(false);
    expect(await notifyScopeProblemOnce(dir, state, send)).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(['{broken', JSON.stringify({ ...state, missingScopes: ['im:message', 7], notifiedAt: 1 })])('logs corrupt state and still delivers (%s)', async (contents) => {
    writeFileSync(recordPath(), contents);
    const send = vi.fn(async () => true);
    expect(await notifyScopeProblemOnce(dir, state, send)).toBe('delivered');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cannot read scope notification state'));
    expect(await notifyScopeProblemOnce(dir, state, send)).toBe('unchanged');
    expect(send).toHaveBeenCalledOnce();
  });

  it('logs persistence failures and continues retrying the visible warning', async () => {
    const blockedDir = join(dir, 'not-a-directory');
    writeFileSync(blockedDir, 'occupied');
    const send = vi.fn(async () => true);
    expect(await notifyScopeProblemOnce(blockedDir, state, send)).toBe('delivered');
    expect(await notifyScopeProblemOnce(blockedDir, state, send)).toBe('delivered');
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('notification state could not be saved'));
  });

  it('reports a failed recovery cleanup instead of silently claiming it cleared', () => {
    mkdirSync(recordPath());
    clearScopeProblemNotification(dir, state.larkAppId, 'missing-critical');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('scope warning state could not be cleared'));
  });
});
