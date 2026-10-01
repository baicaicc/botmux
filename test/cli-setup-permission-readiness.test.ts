import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  readback: vi.fn(), validateCredentials: vi.fn(), register: vi.fn(),
  start: vi.fn(), availability: vi.fn(), automate: vi.fn(),
  detectOwners: vi.fn(), normalizeOwners: vi.fn(), reapLegacy: vi.fn(),
}));

vi.mock('../src/setup/verify-permissions.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCriticalScopesFromApplicationInfo: mocks.readback,
  validateCredentials: mocks.validateCredentials,
}));
vi.mock('../src/setup/register-app.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), tryRegisterApp: mocks.register,
}));
vi.mock('../src/core/fleet-runtime.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), startBotViaSupervisor: mocks.start,
}));
vi.mock('../src/setup/cli-availability.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), checkCliAvailability: mocks.availability,
}));
vi.mock('../src/setup/owner-identity.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectUnusableOwnerEntries: mocks.detectOwners, normalizeManagedOwnerEntries: mocks.normalizeOwners,
}));
vi.mock('../src/core/legacy-pm2-reaper.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), reapLegacyPm2: mocks.reapLegacy,
}));
vi.mock('../src/setup/open-platform-automation.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), automateOpenPlatformSetup: mocks.automate,
}));

import { cmdSetupScripted, printAddBotLiveHint } from '../src/cli.js';

const configDir = join(homedir(), '.botmux');
const botsFile = join(configDir, 'bots.json');
const bot = { larkAppId: 'cli_existing', larkAppSecret: 'saved-secret', brand: 'lark', cliId: 'codex', allowedUsers: ['owner@example.test'] };
const missingScope = { name: 'im:message.p2p_msg:readonly', desc: '私聊消息接收', critical: true };
let output: ReturnType<typeof vi.spyOn>;

function savedBots(): Array<Record<string, unknown>> { return JSON.parse(readFileSync(botsFile, 'utf8')); }
function lastJson(): any { return JSON.parse(String(output.mock.calls.at(-1)![0])); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readback.mockReset();
  mocks.register.mockReset();
  mocks.readback.mockResolvedValue({ ok: true, granted: [], missingCritical: [missingScope] });
  mocks.validateCredentials.mockResolvedValue({ ok: true, tenantAccessToken: 'test-token' });
  mocks.availability.mockReturnValue({ available: true });
  mocks.detectOwners.mockResolvedValue([]);
  mocks.normalizeOwners.mockImplementation(async entries => entries);
  mocks.reapLegacy.mockReturnValue({ found: false, unresolved: false });
  mocks.start.mockReturnValue({ ok: true, state: 'started', name: 'botmux-0' });
  mocks.automate.mockResolvedValue({ ok: false, reason: 'unsupported_brand', message: 'manual' });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(botsFile, JSON.stringify([]));
  process.exitCode = undefined;
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('setup permission readback gates only the new bot activation', () => {
  it('BYO add saves credentials, reports real missing scopes and does not start an unready bot', async () => {
    await cmdSetupScripted(['add', '--app-id', bot.larkAppId, '--app-secret', bot.larkAppSecret, '--brand', 'lark', '--cli', 'codex', '--allowed-users', 'owner@example.test', '--json']);
    const result = lastJson();
    expect(result).toMatchObject({
      ok: false, partial: true, appId: bot.larkAppId,
      permissions: {
        status: 'missing', missing: [{ name: missingScope.name, feature: missingScope.desc }],
        deeplink: `https://open.larksuite.com/app/${bot.larkAppId}/auth`,
      },
      live: { ok: false, reason: 'permissions_incomplete' },
      continueCommand: `botmux setup configure ${bot.larkAppId}`,
    });
    expect(savedBots()).toHaveLength(1);
    expect(savedBots()[0]).toMatchObject({ larkAppId: bot.larkAppId, larkAppSecret: bot.larkAppSecret });
    expect(JSON.stringify(result)).not.toContain(bot.larkAppSecret);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('SDK create-app persists its original app and gives configure recovery when creation did not make permissions live', async () => {
    mocks.register.mockResolvedValue({ ok: true, appId: 'cli_created', appSecret: 'created-secret', brand: 'lark' });
    await cmdSetupScripted(['add', '--create-app', '--brand', 'lark', '--cli', 'codex', '--allowed-users', 'owner@example.test', '--json']);
    const result = lastJson();
    expect(result).toMatchObject({ ok: false, appId: 'cli_created', permissions: { status: 'missing' }, continueCommand: 'botmux setup configure cli_created' });
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(savedBots()).toHaveLength(1);
    expect(savedBots()[0]).toMatchObject({ larkAppId: 'cli_created', larkAppSecret: 'created-secret' });
    expect(mocks.readback).toHaveBeenCalledWith('cli_created', 'created-secret', 'lark');
  });

  it('JSON configure never triggers another QR or creates a replacement app', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    await cmdSetupScripted(['configure', bot.larkAppId, '--json']);
    expect(lastJson()).toMatchObject({ ok: false, permissions: { status: 'missing' }, next: `botmux setup configure ${bot.larkAppId}` });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.automate).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(savedBots()).toEqual([bot]);
  });

  it('configure skips SDK authorization when the saved app is already ready and starts only that bot', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    mocks.readback.mockResolvedValue({ ok: true, granted: [missingScope.name], missingCritical: [] });
    await cmdSetupScripted(['configure', bot.larkAppId, '--json']);
    expect(lastJson()).toMatchObject({ ok: true, permissions: { status: 'ready' }, live: { ok: true, state: 'started' }, next: 'live' });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.automate).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start.mock.calls[0][0]).toBe(bot.larkAppId);
    expect(savedBots()).toEqual([bot]);
  });

  it('explicit Lark configure repairs the exact saved app, then requires a second successful readback', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    mocks.readback.mockResolvedValueOnce({ ok: true, granted: [], missingCritical: [missingScope] })
      .mockResolvedValueOnce({ ok: true, granted: [missingScope.name], missingCritical: [] });
    mocks.register.mockResolvedValue({ ok: true, appId: bot.larkAppId, appSecret: bot.larkAppSecret, brand: 'lark' });
    await cmdSetupScripted(['configure', bot.larkAppId]);
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith({ appId: bot.larkAppId, scopeNames: [missingScope.name] });
    expect(mocks.readback).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(savedBots()).toEqual([bot]);
  });

  it('successful SDK authorization with still-missing scopes never reports a live bot', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    mocks.register.mockResolvedValue({ ok: true, appId: bot.larkAppId, appSecret: bot.larkAppSecret, brand: 'lark' });
    await cmdSetupScripted(['configure', bot.larkAppId]);
    expect(mocks.readback).toHaveBeenCalledTimes(2);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(savedBots()).toEqual([bot]);
  });

  it('unverified network state blocks activation without starting another authorization request', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    mocks.readback.mockResolvedValue({ ok: false, error: 'network', message: 'scope readback timeout' });
    await cmdSetupScripted(['configure', bot.larkAppId, '--json']);
    expect(lastJson()).toMatchObject({ ok: false, permissions: { status: 'unverified', error: 'network' }, live: { ok: false } });
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(savedBots()).toEqual([bot]);
  });

  it('explicit self_manage repair requests only the verification prerequisite before reading permissions again', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    mocks.readback.mockResolvedValueOnce({ ok: false, error: 'need_self_manage', message: 'missing application:application:self_manage' })
      .mockResolvedValueOnce({ ok: true, granted: [], missingCritical: [] });
    mocks.register.mockResolvedValue({ ok: true, appId: bot.larkAppId, appSecret: bot.larkAppSecret, brand: 'lark' });
    await cmdSetupScripted(['configure', bot.larkAppId]);
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith({ appId: bot.larkAppId, scopeNames: ['application:application:self_manage'] });
    expect(mocks.readback).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(savedBots()).toEqual([bot]);
  });

  it('a Feishu automation success still cannot activate scopes that are awaiting publication or approval', async () => {
    mocks.automate.mockResolvedValue({
      ok: true, scopeCount: 2, skippedScopeCount: 0, versionId: 'draft-version',
      versionWarning: 'version remains draft', redirectConfigured: true, sessionSource: 'botmux_cache',
    });
    await cmdSetupScripted(['add', '--app-id', bot.larkAppId, '--app-secret', bot.larkAppSecret, '--brand', 'feishu', '--cli', 'codex', '--allowed-users', 'owner@example.test', '--open-platform-auto', '--json']);
    expect(lastJson()).toMatchObject({
      ok: false, openPlatform: { status: 'ready_with_warnings' },
      permissions: { status: 'missing' }, live: { ok: false, reason: 'permissions_incomplete' },
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(savedBots()[0]).toMatchObject({ larkAppId: bot.larkAppId, larkAppSecret: bot.larkAppSecret });
  });

  it('a changed secret is surfaced for manual verification and cannot overwrite the existing config or start the app', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    mocks.register.mockResolvedValue({ ok: true, appId: bot.larkAppId, appSecret: 'different-secret', brand: 'lark' });
    await cmdSetupScripted(['configure', bot.larkAppId]);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.readback).toHaveBeenCalledTimes(1);
    expect(savedBots()).toEqual([bot]);
    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(errors).toContain('人工核验');
    expect(errors).not.toContain('different-secret');
  });

  it('a mismatched SDK app cannot activate or replace the original saved bot', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    mocks.register.mockResolvedValue({ ok: true, appId: 'cli_wrong_app', appSecret: bot.larkAppSecret, brand: 'lark' });
    await cmdSetupScripted(['configure', bot.larkAppId]);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.readback).toHaveBeenCalledTimes(1);
    expect(savedBots()).toEqual([bot]);
    expect(process.exitCode).toBe(1);
  });

  it('interactive auto-start uses the same live-scope gate without SDK mutation', async () => {
    writeFileSync(botsFile, JSON.stringify([bot]));
    await printAddBotLiveHint(bot.larkAppId);
    expect(mocks.readback).toHaveBeenCalledWith(bot.larkAppId, bot.larkAppSecret, 'lark');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('fully ready add can activate without authorizing or creating another app', async () => {
    mocks.readback.mockResolvedValue({ ok: true, granted: [missingScope.name], missingCritical: [] });
    await cmdSetupScripted(['add', '--app-id', bot.larkAppId, '--app-secret', bot.larkAppSecret, '--brand', 'lark', '--cli', 'codex', '--allowed-users', 'owner@example.test', '--json']);
    expect(lastJson()).toMatchObject({ ok: true, permissions: { status: 'ready' }, live: { ok: true }, next: 'live' });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
