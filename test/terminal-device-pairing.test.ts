import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', owner: 'ou_owner' as string | undefined }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dataDir; } } } }));
vi.mock('../src/bot-registry.js', () => ({ getOwnerOpenId: () => state.owner }));
import { approveTerminalDevice, buildTerminalDevicePairingCard, terminalDeviceOwnerKey, terminalDeviceStoreForBot, TERMINAL_DEVICE_SHARED_OWNER } from '../src/core/terminal-device-pairing.js';
import { TerminalDeviceStore } from '../src/core/terminal-device-store.js';

beforeEach(() => {
  state.dataDir = mkdtempSync(join(tmpdir(), 'terminal-device-pairing-'));
  state.owner = 'ou_owner';
  vi.stubEnv('BOTMUX_TERMINAL_DEVICE_PAIRING', '1');
});
afterEach(() => { rmSync(state.dataDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('original Lark session approval', () => {
  const sessionId = 'session-A';
  function pending() {
    const store = terminalDeviceStoreForBot('bot-A')!;
    const pair = store.startPair({ sessionId, scope: 'read', ownerId: 'ou_owner' });
    return { store, pair };
  }
  it('requires the current owner even when another operator knows the code', () => {
    const { store, pair } = pending();
    const result = approveTerminalDevice({ larkAppId: 'bot-A', sessionId, code: pair.code, operatorId: 'ou_other' });
    expect(result.ok).toBe(false);
    expect(store.identity(pair.browserToken)).toBeNull();
    expect(approveTerminalDevice({ larkAppId: 'bot-A', sessionId, code: pair.code, operatorId: 'ou_owner' }).ok).toBe(true);
  });
  it('rejects the same code from another session or bot and accepts it only once', () => {
    const { pair } = pending();
    expect(approveTerminalDevice({ larkAppId: 'bot-A', sessionId: 'session-B', code: pair.code, operatorId: 'ou_owner' }).ok).toBe(false);
    expect(approveTerminalDevice({ larkAppId: 'bot-B', sessionId, code: pair.code, operatorId: 'ou_owner' }).ok).toBe(false);
    expect(approveTerminalDevice({ larkAppId: 'bot-A', sessionId, code: pair.code, operatorId: 'ou_owner' }).ok).toBe(true);
    expect(approveTerminalDevice({ larkAppId: 'bot-A', sessionId, code: pair.code, operatorId: 'ou_owner' }).ok).toBe(false);
  });
  it('fails closed when owner resolution changes or pairing is disabled', () => {
    const { store, pair } = pending();
    state.owner = undefined;
    expect(approveTerminalDevice({ larkAppId: 'bot-A', sessionId, code: pair.code, operatorId: 'ou_owner' }).ok).toBe(false);
    state.owner = 'ou_new_owner';
    expect(approveTerminalDevice({ larkAppId: 'bot-A', sessionId, code: pair.code, operatorId: 'ou_new_owner' }).ok).toBe(false);
    vi.stubEnv('BOTMUX_TERMINAL_DEVICE_PAIRING', '0');
    expect(terminalDeviceStoreForBot('bot-A')).toBeNull();
    expect(store.identity(pair.browserToken)).toBeNull();
  });
  it('shares the same store instance between the gateway and Lark approvals', () => {
    expect(terminalDeviceStoreForBot('bot-A')).toBe(terminalDeviceStoreForBot('bot-A'));
    expect(terminalDeviceStoreForBot('bot-A')).not.toBe(terminalDeviceStoreForBot('bot-B'));
  });
  it('puts the exact session and short code on the confirmation card', () => {
    const card = JSON.parse(buildTerminalDevicePairingCard({ rootId: 'original-thread', sessionId, code: 'ABCDEFGH', scope: 'read' }));
    const action = card.elements[1].actions[0].value;
    expect(action).toEqual({ action: 'terminal_device_approve', root_id: 'original-thread', session_id: sessionId, code: 'ABCDEFGH' });
    expect(card.elements[0].content).toContain('查看');
    expect(card.elements[0].content).not.toContain('查看和操作');
  });
});

describe('deployment-wide identity (BOTMUX_TERMINAL_DEVICE_SHARED=1)', () => {
  it('pairs once via one bot and the device is known to every bot; grants stay per session', () => {
    vi.stubEnv('BOTMUX_TERMINAL_DEVICE_SHARED', '1');
    const kimi = terminalDeviceStoreForBot('bot-kimi')!;
    expect(terminalDeviceStoreForBot('bot-codebuddy')).toBe(kimi);
    const ownerKey = terminalDeviceOwnerKey('ou_owner');
    expect(ownerKey).toBe(TERMINAL_DEVICE_SHARED_OWNER);
    const pair = kimi.startPair({ sessionId: 'kimi-session', scope: 'read', ownerId: ownerKey });
    // Still only that bot's real owner may confirm in Lark.
    expect(approveTerminalDevice({ larkAppId: 'bot-kimi', sessionId: 'kimi-session', code: pair.code, operatorId: 'ou_other' }).ok).toBe(false);
    expect(approveTerminalDevice({ larkAppId: 'bot-kimi', sessionId: 'kimi-session', code: pair.code, operatorId: 'ou_owner' }).ok).toBe(true);
    const codebuddy = terminalDeviceStoreForBot('bot-codebuddy')!;
    expect(codebuddy.identity(pair.browserToken)).not.toBeNull();
    expect(codebuddy.access({ browserToken: pair.browserToken, sessionId: 'cb-session', scope: 'read', ownerId: ownerKey })).toBeNull();
    expect(codebuddy.grant({ browserToken: pair.browserToken, sessionId: 'cb-session', scope: 'read', ownerId: ownerKey })).not.toBeNull();
    // One revoke (device settings in any bot) removes the identity everywhere.
    expect(codebuddy.revoke(pair.browserToken)).toBe(true);
    expect(kimi.identity(pair.browserToken)).toBeNull();
  });

  it('keeps browsers paired under the former per-bot store', () => {
    const legacy = new TerminalDeviceStore({ dataDir: state.dataDir, botId: 'bot-codebuddy' });
    const pair = legacy.startPair({ sessionId: 'cb-session', scope: 'write', ownerId: 'ou_owner' });
    expect(legacy.approve({ code: pair.code, sessionId: 'cb-session', ownerId: 'ou_owner' }).ok).toBe(true);
    vi.stubEnv('BOTMUX_TERMINAL_DEVICE_SHARED', '1');
    const shared = terminalDeviceStoreForBot('bot-kimi')!;
    expect(shared.identity(pair.browserToken)).not.toBeNull();
    expect(shared.access({ browserToken: pair.browserToken, sessionId: 'cb-session', scope: 'write', ownerId: TERMINAL_DEVICE_SHARED_OWNER })).not.toBeNull();
  });

  it('keeps per-bot owner keys when sharing is off', () => {
    expect(terminalDeviceOwnerKey('ou_owner')).toBe('ou_owner');
  });
});
