import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mock = vi.hoisted(() => ({
  getBot: vi.fn(), sendUserMessage: vi.fn(), automate: vi.fn(), inspectReview: vi.fn(),
}));
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBot: mock.getBot,
  vcMeetingAgentConfigActive: () => false,
}));
vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/im/lark/client.js')>(),
  sendUserMessage: mock.sendUserMessage,
}));
vi.mock('../src/setup/open-platform-automation.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/setup/open-platform-automation.js')>(),
  automateOpenPlatformSetup: mock.automate,
  inspectUnderReviewConfigHints: mock.inspectReview,
}));

import { checkRequiredScopes } from '../src/im/lark/event-dispatcher.js';
import { BOTMUX_REQUIRED_SCOPES, BOTMUX_MESSAGE_NARROW_SCOPES } from '../src/setup/verify-permissions.js';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';

let dir: string;
let previousDataDir: string;
let bot: { config: { larkAppId: string; larkAppSecret: string; brand: string }; resolvedAllowedUsers: string[]; botName: string };
let info: { code: number; data?: { app: { scopes: string[] } } };
const appId = 'cli_startup_scope_test';
const allGranted = () => BOTMUX_REQUIRED_SCOPES.map(scope => scope.name);
function missing(...scopes: string[]) {
  info = { code: 0, data: { app: { scopes: allGranted().filter(scope => !scopes.includes(scope)) } } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'startup-scope-reminder-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dir;
  bot = { config: { larkAppId: appId, larkAppSecret: 'test-only', brand: 'lark' }, resolvedAllowedUsers: ['ou_admin'], botName: 'Existing bot' };
  mock.getBot.mockReset().mockReturnValue(bot);
  mock.sendUserMessage.mockReset().mockResolvedValue('message-id');
  mock.automate.mockReset().mockResolvedValue({ ok: false, reason: 'invalid_session' });
  mock.inspectReview.mockReset().mockResolvedValue('');
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    json: async () => url.includes('/auth/v3/') ? { code: 0, tenant_access_token: 'test-only' } : info,
  })));
  missing('im:chat.members:read');
});
afterEach(() => {
  config.session.dataDir = previousDataDir;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('startup scope warning delivery', () => {
  it('keeps startup errors in logs while suppressing an unchanged delivered DM', async () => {
    await checkRequiredScopes(appId);
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, `scope-notified-${appId}.json`))).toBe(true);
    const content = mock.sendUserMessage.mock.calls[0][2] as string;
    expect(content).toContain('im:chat.members:read');
    expect(content).toContain(`botmux setup configure ${appId}`);
    expect(content).toContain(`open.larksuite.com/app/${appId}`);
    expect(content).not.toContain('建议一并开通');
    expect(content).not.toMatch(/sms|phone|可选权限/i);
  });

  it('uses legitimate narrower grants and does not blame unrelated messaging features', async () => {
    missing('im:message', 'contact:user.base:readonly', 'im:chat.members:read');
    info.data!.app.scopes.push(...BOTMUX_MESSAGE_NARROW_SCOPES, 'contact:contact.base:readonly');
    await checkRequiredScopes(appId);
    const content = mock.sendUserMessage.mock.calls[0][2] as string;
    expect(content).toContain('缺少 1 项');
    expect(content).toContain('群成员读取');
    expect(content).not.toContain('收发消息');
    expect(content).not.toContain('contact:user.base:readonly');
  });

  it('reminds on changed missing scopes and admins, then clears after recovery', async () => {
    await checkRequiredScopes(appId);
    missing('im:chat.members:write_only');
    await checkRequiredScopes(appId);
    bot.resolvedAllowedUsers = ['ou_new_admin'];
    await checkRequiredScopes(appId);
    missing();
    await checkRequiredScopes(appId);
    expect(existsSync(join(dir, `scope-notified-${appId}.json`))).toBe(false);
    missing('im:chat.members:write_only');
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledTimes(4);
  });

  it('retries a failed DM and records only the subsequent successful send', async () => {
    mock.sendUserMessage.mockRejectedValueOnce(new Error('delivery offline'));
    await checkRequiredScopes(appId);
    expect(existsSync(join(dir, `scope-notified-${appId}.json`))).toBe(false);
    await checkRequiredScopes(appId);
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('delivery offline'));
  });

  it('tracks self-manage lookup failure separately and clears it when the lookup recovers', async () => {
    info = { code: 99991672 };
    await checkRequiredScopes(appId);
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledOnce();
    const content = mock.sendUserMessage.mock.calls[0][2] as string;
    expect(content).toContain('本次查询失败不能证明消息或群功能权限缺失');
    expect(content).toContain(`botmux setup configure ${appId}`);
    expect(content).not.toContain('im:message.group_at_msg.include_bot:readonly');
    missing();
    await checkRequiredScopes(appId);
    info = { code: 99991672 };
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps missing admin and inconclusive API failures visible without recording delivery', async () => {
    bot.resolvedAllowedUsers = [];
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, `scope-notified-${appId}.json`))).toBe(false);
    bot.resolvedAllowedUsers = ['ou_admin'];
    await checkRequiredScopes(appId);
    info = { code: 90001 };
    await checkRequiredScopes(appId);
    missing('im:chat.members:read');
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledOnce();
  });

  it('preserves existing under-review version deduplication', async () => {
    bot.config.brand = 'feishu';
    mock.automate.mockResolvedValue({ ok: false, reason: 'app_under_review', inReviewVersionId: 'version-1' });
    await checkRequiredScopes(appId);
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, `under-review-notified-${appId}.json`))).toBe(true);
    expect(existsSync(join(dir, `scope-notified-${appId}.json`))).toBe(false);
    mock.automate.mockResolvedValue({ ok: false, reason: 'app_under_review', inReviewVersionId: 'version-2' });
    await checkRequiredScopes(appId);
    expect(mock.sendUserMessage).toHaveBeenCalledTimes(2);
  });
});
