import { config } from '../config.js';
import { getOwnerOpenId } from '../bot-registry.js';
import { TerminalDeviceStore } from './terminal-device-store.js';
import type { TerminalControlScope } from './terminal-control-grant.js';

const stores = new Map<string, TerminalDeviceStore>();

/**
 * Deployment principal used instead of per-bot owner open_ids when
 * BOTMUX_TERMINAL_DEVICE_SHARED=1. Lark open_ids differ per app, so a shared
 * browser identity cannot be bound to one of them. Setting the flag declares
 * that every bot sharing this data dir belongs to the same person: one Lark
 * confirmation (still by that bot's real owner) pairs the browser for all
 * bots. Session grants stay per session and still need that session's link.
 */
export const TERMINAL_DEVICE_SHARED_OWNER = 'botmux-deployment';

export function terminalDeviceSharedAcrossBots(): boolean {
  return process.env.BOTMUX_TERMINAL_DEVICE_SHARED === '1';
}

/** Owner key the device store compares; the real owner still approves in Lark. */
export function terminalDeviceOwnerKey(ownerOpenId: string): string {
  return terminalDeviceSharedAcrossBots() ? TERMINAL_DEVICE_SHARED_OWNER : ownerOpenId;
}

export function terminalDeviceStoreForBot(larkAppId: string): TerminalDeviceStore | null {
  if (process.env.BOTMUX_TERMINAL_DEVICE_PAIRING !== '1') return null;
  const shared = terminalDeviceSharedAcrossBots();
  const botId = shared ? TERMINAL_DEVICE_SHARED_OWNER : larkAppId;
  const key = JSON.stringify([config.session.dataDir, botId]);
  let store = stores.get(key);
  if (!store) {
    store = new TerminalDeviceStore({ dataDir: config.session.dataDir, botId });
    // Keep browsers paired under the former per-bot stores (no forced re-pair).
    if (shared) store.importLegacyStores(TERMINAL_DEVICE_SHARED_OWNER);
    stores.set(key, store);
  }
  return store;
}

/** Called only inside the original, bot-scoped Lark session route. */
export function approveTerminalDevice(input: { larkAppId: string; sessionId: string; code: string; operatorId?: string }): { ok: boolean; message: string } {
  const ownerId = getOwnerOpenId(input.larkAppId);
  if (!ownerId || input.operatorId !== ownerId) return { ok: false, message: '只有当前 Bot 的所有者可以确认设备配对。' };
  const store = terminalDeviceStoreForBot(input.larkAppId);
  if (!store) return { ok: false, message: '当前入口尚未开启设备配对。' };
  try {
    const result = store.approve({ code: input.code, sessionId: input.sessionId, ownerId: terminalDeviceOwnerKey(ownerId) });
    return result.ok
      ? { ok: true, message: '设备配对成功，此浏览器中等待确认的会话页面会自动进入。' }
      : { ok: false, message: '配对码已过期、已使用或不属于当前会话，请重新打开原 Lark 链接。' };
  } catch { return { ok: false, message: '设备授权暂时不可用，请稍后重试。' }; }
}

export function buildTerminalDevicePairingCard(input: { rootId: string; sessionId: string; code: string; scope: TerminalControlScope }): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '确认浏览器设备配对' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: `浏览器短码：**${input.code}**\n请核对浏览器页面上的短码。\n当前会话 \`${input.sessionId.slice(0, 8)}\` 的入口为${input.scope === 'write' ? '查看和操作' : '只读查看'}。配对此浏览器后，同一入口的其他话题无需重复确认；各会话权限仍由各自的 Lark 链接决定。配对码 5 分钟内有效。` },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '确认配对' }, value: { action: 'terminal_device_approve', root_id: input.rootId, session_id: input.sessionId, code: input.code } }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `也可以在原会话发送 /term pair ${input.code}。只确认自己正在打开的浏览器。` }] },
    ],
  });
}
