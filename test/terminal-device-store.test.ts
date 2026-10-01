import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalDeviceStore, TerminalDeviceStoreError,
  TERMINAL_DEVICE_PAIR_TTL_MS, TERMINAL_DEVICE_PENDING_LIMIT,
  TERMINAL_DEVICE_SESSION_TTL_MS, TERMINAL_DEVICE_TTL_MS,
  type TerminalDeviceScope,
} from '../src/core/terminal-device-store.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let dataDir: string;
let now: number;
let store: TerminalDeviceStore;
const ownerId = 'owner-a';
const sessionId = 'session-a';
const botId = 'bot-a';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'terminal-device-'));
  now = 1_800_000_000_000;
  store = new TerminalDeviceStore({ dataDir, botId, now: () => now });
});
afterEach(() => {
  vi.mocked(renameSync).mockClear();
  rmSync(dataDir, { recursive: true, force: true });
});

function filePath(forBot = botId): string {
  return join(dataDir, 'terminal-devices', `${createHash('sha256').update(forBot).digest('hex')}.json`);
}

function pair(scope: TerminalDeviceScope = 'read', sid = sessionId, owner = ownerId): string {
  const pending = store.startPair({ sessionId: sid, scope, ownerId: owner });
  expect(store.approve({ code: pending.code, sessionId: sid, ownerId: owner }).ok).toBe(true);
  return pending.browserToken;
}

function input(browserToken: string, scope: TerminalDeviceScope = 'read', sid = sessionId, owner = ownerId) {
  return { browserToken, sessionId: sid, scope, ownerId: owner };
}

describe('single-session terminal browser pairing', () => {
  it('starts unpaired and approves only the pinned owner and session, once', () => {
    const pending = store.startPair({ sessionId, scope: 'read', ownerId });
    expect(pending.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(pending.browserToken).toHaveLength(43);
    expect(store.identity(pending.browserToken)).toBeNull();
    expect(store.access(input(pending.browserToken))).toBeNull();
    expect(store.approve({ code: pending.code, sessionId: 'session-b', ownerId }))
      .toEqual({ ok: false, reason: 'session_mismatch' });
    expect(store.approve({ code: pending.code, sessionId, ownerId: 'owner-b' }))
      .toEqual({ ok: false, reason: 'owner_mismatch' });
    const approved = store.approve({ code: ` ${pending.code.toLowerCase()} `, sessionId, ownerId });
    expect(approved).toMatchObject({ ok: true, ownerId, expiresAt: now + TERMINAL_DEVICE_TTL_MS });
    expect(store.approve({ code: pending.code, sessionId, ownerId }))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(store.access(input(pending.browserToken))).toMatchObject({
      ownerId, expiresAt: now + TERMINAL_DEVICE_SESSION_TTL_MS,
    });
    expect(store.access(input(pending.browserToken, 'write'))).toBeNull();
  });

  it('keeps other sessions and owners forbidden until their own capability grants access', () => {
    const token = pair();
    expect(store.identity(token)).toMatchObject({ ownerId });
    expect(store.access(input(token, 'read', 'session-b'))).toBeNull();
    expect(store.access(input(token, 'read', sessionId, 'owner-b'))).toBeNull();
    expect(store.grant(input(token, 'write', 'session-b', 'owner-b'))).toBeNull();
    expect(store.grant(input(token, 'read', 'session-b'))).toMatchObject({ ownerId });
    expect(store.access(input(token, 'read', 'session-b'))).toBeTruthy();
    expect(store.access(input(token, 'write', 'session-b'))).toBeNull();
    expect(store.access(input(token, 'write'))).toBeNull();
  });

  it('write permits observation, while read grants never elevate input rights', () => {
    const token = pair('write');
    expect(store.access(input(token))).toBeTruthy();
    expect(store.access(input(token, 'write'))).toBeTruthy();
    store.grant(input(token, 'read', 'session-b'));
    expect(store.access(input(token, 'write', 'session-b'))).toBeNull();
    store.grant(input(token, 'write', 'session-b'));
    expect(store.access(input(token, 'write', 'session-b'))).toBeTruthy();
  });

  it('reuses a pending request only for the same browser, session, scope and owner', () => {
    const first = store.startPair({ sessionId, scope: 'read', ownerId });
    now += 30_000;
    expect(store.startPair({ sessionId, scope: 'read', ownerId, browserToken: first.browserToken }))
      .toEqual(first);
    const write = store.startPair({ sessionId, scope: 'write', ownerId, browserToken: first.browserToken });
    expect(write.code).not.toBe(first.code);
    expect(write.browserToken).toBe(first.browserToken);
    const secondSession = store.startPair({ sessionId: 'session-b', scope: 'read', ownerId, browserToken: first.browserToken });
    expect(secondSession.code).not.toBe(first.code);
    expect(secondSession.browserToken).toBe(first.browserToken);
    const otherOwner = store.startPair({ sessionId, scope: 'read', ownerId: 'owner-b', browserToken: first.browserToken });
    expect(otherOwner.browserToken).not.toBe(first.browserToken);
  });

  it('rejects attacker chosen or malformed credentials and rotates unknown supplied tokens', () => {
    const chosen = randomBytes(32).toString('base64url');
    const pending = store.startPair({ sessionId, scope: 'read', ownerId, browserToken: chosen });
    expect(pending.browserToken).not.toBe(chosen);
    store.approve({ code: pending.code, sessionId, ownerId });
    expect(store.identity(chosen)).toBeNull();
    for (const token of ['', 'known-device-id', pending.code, pending.browserToken + '=', pending.browserToken.slice(0, -1)]) {
      expect(store.identity(token)).toBeNull();
      expect(store.access(input(token, 'write'))).toBeNull();
    }
  });

  it('expires the five minute approval code exactly at its fixed boundary', () => {
    const pending = store.startPair({ sessionId, scope: 'write', ownerId });
    now = pending.expiresAt;
    expect(store.approve({ code: pending.code, sessionId, ownerId })).toEqual({ ok: false, reason: 'expired' });
    expect(store.identity(pending.browserToken)).toBeNull();
    const renewed = store.startPair({ sessionId, scope: 'write', ownerId, browserToken: pending.browserToken });
    expect(renewed.browserToken).not.toBe(pending.browserToken);
    expect(renewed.expiresAt).toBe(now + TERMINAL_DEVICE_PAIR_TTL_MS);
  });

  it('keeps device and session expiries fixed across repeated visits and restart', () => {
    const token = pair('write');
    const identity = store.identity(token)!;
    const access = store.access(input(token, 'write'))!;
    now += 10 * 24 * 60 * 60_000;
    expect(store.grant(input(token, 'write'))!.expiresAt).toBe(access.expiresAt);
    store = new TerminalDeviceStore({ dataDir, botId, now: () => now });
    expect(store.identity(token)).toEqual(identity);
    expect(store.access(input(token, 'write'))).toEqual(access);
    now = access.expiresAt;
    expect(store.identity(token)).toEqual(identity);
    expect(store.access(input(token, 'write'))).toBeNull();
    expect(store.grant(input(token, 'read'))!.expiresAt).toBe(now + TERMINAL_DEVICE_SESSION_TTL_MS);
    expect(store.access(input(token, 'write'))).toBeNull();
  });

  it('expires the remembered device after 180 days and does not resurrect it through a pending approval', () => {
    const token = pair('read');
    const identity = store.identity(token)!;
    now = identity.expiresAt - 10_000;
    const pending = store.startPair({ sessionId: 'session-b', scope: 'write', ownerId, browserToken: token });
    expect(pending.browserToken).toBe(token);
    expect(pending.expiresAt).toBe(identity.expiresAt);
    now = identity.expiresAt;
    expect(store.identity(token)).toBeNull();
    expect(store.access(input(token))).toBeNull();
    expect(store.grant(input(token, 'write'))).toBeNull();
    expect(store.approve({ code: pending.code, sessionId: 'session-b', ownerId }))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('approving another session preserves the remembered device expiry', () => {
    const token = pair();
    const identity = store.identity(token)!;
    now += 10 * 24 * 60 * 60_000;
    const pending = store.startPair({ sessionId: 'session-b', scope: 'write', ownerId, browserToken: token });
    expect(pending.browserToken).toBe(token);
    expect(store.approve({ code: pending.code, sessionId: 'session-b', ownerId }))
      .toEqual({ ok: true, ...identity });
    expect(store.identity(token)).toEqual(identity);
  });

  it('isolates bots even when they share the runtime data directory', () => {
    const pending = store.startPair({ sessionId, scope: 'write', ownerId });
    const otherBot = new TerminalDeviceStore({ dataDir, botId: 'bot-b', now: () => now });
    expect(otherBot.approve({ code: pending.code, sessionId, ownerId }))
      .toEqual({ ok: false, reason: 'not_found' });
    store.approve({ code: pending.code, sessionId, ownerId });
    expect(otherBot.identity(pending.browserToken)).toBeNull();
    expect(otherBot.access(input(pending.browserToken))).toBeNull();
    pair();
    const otherPending = otherBot.startPair({ sessionId, scope: 'write', ownerId });
    otherBot.approve({ code: otherPending.code, sessionId, ownerId });
    expect(store.identity(otherPending.browserToken)).toBeNull();
    expect(store.identity(pending.browserToken)).toBeTruthy();
  });

  it('revoke invalidates one browser identity, every grant and its pending requests durably', () => {
    const token = pair('write');
    const other = pair('read');
    store.grant(input(token, 'write', 'session-b'));
    const pending = store.startPair({ sessionId: 'session-c', scope: 'write', ownerId, browserToken: token });
    expect(store.revoke(token)).toBe(true);
    expect(store.revoke(token)).toBe(false);
    store = new TerminalDeviceStore({ dataDir, botId, now: () => now });
    expect(store.identity(token)).toBeNull();
    expect(store.access(input(token, 'write', 'session-b'))).toBeNull();
    expect(store.approve({ code: pending.code, sessionId: 'session-c', ownerId }))
      .toEqual({ ok: false, reason: 'not_found' });
    expect(store.access(input(other))).toBeTruthy();
  });

  it('revokeSession clears only that owner/session permissions and leaves device identity intact', () => {
    const token = pair('write');
    const otherDevice = pair('read');
    const otherOwner = pair('write', sessionId, 'owner-b');
    store.grant(input(token, 'write', 'session-b'));
    const pending = store.startPair({ sessionId, scope: 'read', ownerId, browserToken: token });
    expect(store.revokeSession({ sessionId, ownerId })).toBe(3);
    expect(store.identity(token)).toBeTruthy();
    expect(store.identity(otherDevice)).toBeTruthy();
    expect(store.access(input(token))).toBeNull();
    expect(store.access(input(otherDevice))).toBeNull();
    expect(store.access(input(token, 'write', 'session-b'))).toBeTruthy();
    expect(store.access(input(otherOwner, 'write', sessionId, 'owner-b'))).toBeTruthy();
    expect(store.approve({ code: pending.code, sessionId, ownerId }))
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('caps live pending requests at 100 and recovers capacity after expiry', () => {
    for (let n = 0; n < TERMINAL_DEVICE_PENDING_LIMIT; n++) {
      store.startPair({ sessionId: `session-${n}`, scope: 'read', ownerId });
    }
    expect(() => store.startPair({ sessionId, scope: 'read', ownerId }))
      .toThrowError(new TerminalDeviceStoreError('pending_limit'));
    now += TERMINAL_DEVICE_PAIR_TTL_MS;
    expect(store.startPair({ sessionId, scope: 'read', ownerId }).code).toHaveLength(8);
  });

  it('writes only credential hashes to a 0600 atomic file under a 0700 directory', () => {
    const pending = store.startPair({ sessionId, scope: 'write', ownerId });
    let disk = readFileSync(filePath(), 'utf8');
    expect(disk).not.toContain(pending.browserToken);
    expect(disk).not.toContain('browserToken');
    store.approve({ code: pending.code, sessionId, ownerId });
    disk = readFileSync(filePath(), 'utf8');
    expect(disk).not.toContain(pending.browserToken);
    expect(disk).toContain(createHash('sha256').update(pending.browserToken).digest('hex'));
    expect(statSync(filePath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'terminal-devices')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dataDir, 'terminal-devices'))).toEqual([filePath().split('/').at(-1)]);
  });

  it('fails closed on corruption, invalid scope, bot mismatch or inconsistent records', () => {
    const token = pair('write');
    const original = readFileSync(filePath(), 'utf8');
    const mutators = [
      () => '{broken',
      (state: any) => { state.botId = 'bot-b'; return JSON.stringify(state); },
      (state: any) => { state.grants[0].scope = 'owner'; return JSON.stringify(state); },
      (state: any) => { state.devices.push(state.devices[0]); return JSON.stringify(state); },
      (state: any) => { state.grants[0].ownerId = 'owner-b'; return JSON.stringify(state); },
      (state: any) => { state.grants[0].expiresAt = state.devices[0].expiresAt + 1; return JSON.stringify(state); },
    ];
    for (const mutate of mutators) {
      writeFileSync(filePath(), mutate(JSON.parse(original)), 'utf8');
      const fresh = new TerminalDeviceStore({ dataDir, botId, now: () => now });
      expect(() => fresh.access(input(token, 'write'))).toThrowError(new TerminalDeviceStoreError('invalid_state'));
      writeFileSync(filePath(), original, 'utf8');
      expect(() => fresh.identity(token)).toThrowError(new TerminalDeviceStoreError('store_unavailable'));
    }
  });

  it('propagates a failed revoke and rejects old disk privileges for the rest of that store lifetime', () => {
    const token = pair('write');
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('simulated storage failure'); });
    expect(() => store.revoke(token)).toThrowError(new TerminalDeviceStoreError('store_unavailable'));
    expect(() => store.access(input(token, 'write'))).toThrowError(new TerminalDeviceStoreError('store_unavailable'));
    expect(() => store.identity(token)).toThrowError(new TerminalDeviceStoreError('store_unavailable'));
    expect(readdirSync(join(dataDir, 'terminal-devices'))).toHaveLength(1);
  });

  it('does not acknowledge approval or mint a credential after failed persistence', () => {
    const pending = store.startPair({ sessionId, scope: 'write', ownerId });
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('simulated storage failure'); });
    expect(() => store.approve({ code: pending.code, sessionId, ownerId }))
      .toThrowError(new TerminalDeviceStoreError('store_unavailable'));
    const restarted = new TerminalDeviceStore({ dataDir, botId, now: () => now });
    expect(restarted.identity(pending.browserToken)).toBeNull();
    expect(restarted.access(input(pending.browserToken, 'write'))).toBeNull();
  });
});
