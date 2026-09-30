import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', owner: 'ou_owner' as string | undefined }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dataDir; } } } }));
vi.mock('../src/bot-registry.js', () => ({ getOwnerOpenId: () => state.owner }));
import { approveTerminalDevice, buildTerminalDevicePairingCard, terminalDeviceStoreForBot } from '../src/core/terminal-device-pairing.js';

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
