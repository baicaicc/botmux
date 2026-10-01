import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { normalizeKllConfig, resolveKllLaunch, validateKllLaunch, validateKllExtraArgs } from '../src/services/kll-launch.js';
import { resolveSessionLaunchModel } from '../src/core/session-model.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';

const result = { schemaVersion: 1, agent: 'claude-code', modelId: 'glm5.3', profileRef: { id: 'profile-glm' }, cliModel: 'glm-5.3', launch: { removeEnv: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] } };
const input = { kll: { tier: 'strong' as const }, cliId: 'claude-code', backendType: 'herdr' };
const dshResult = { schemaVersion: 1, agent: 'dsh-harness', modelId: 'glm-5.3', profileRef: { id: 'profile-dsh' }, cliModel: 'glm-5.3', launch: { removeEnv: ['ALLINONE_DSH_API_KEY', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'DSH_LIVE_CONNECTION_FILE'] } };
function resolver(response: unknown = result, env: Record<string, string> = { ANTHROPIC_API_KEY: 'new-secret', ANTHROPIC_BASE_URL: 'https://selected.example' }) {
  let path = '';
  return { execute: vi.fn((_bin: string, args: string[]) => {
    path = args.at(-1)!;
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, JSON.stringify(env), { mode: 0o600, flag: 'wx' });
    return JSON.stringify(response);
  }), cleaned: () => !existsSync(dirname(path)) };
}

describe('KLL native launch selection', () => {
  it.each(['--model', '--model=other', '-m', '-m=other', '-mother', '--settings', '--settings=/tmp/other.json'])('rejects extra CLI overrides of its selected model/provider: %s', flag => {
    expect(() => validateKllExtraArgs(input, [flag, 'other'])).toThrow('cannot be overridden');
  });
  it('retains unrelated extra args and ordinary/adopted CLI override behavior', () => {
    expect(() => validateKllExtraArgs(input, ['--verbose', '--add-dir', '/tmp/project'])).not.toThrow();
    expect(() => validateKllExtraArgs({ ...input, kll: undefined }, ['--model', 'other'])).not.toThrow();
    expect(() => validateKllExtraArgs({ ...input, adoptMode: true }, ['--settings', '/tmp/other.json'])).not.toThrow();
  });
  it('is opt-in and validates config without silently accepting misspellings', () => {
    expect(normalizeKllConfig(undefined)).toBeUndefined();
    expect(normalizeKllConfig(false)).toBeUndefined();
    expect(normalizeKllConfig({})).toEqual({ tier: 'strong', executable: undefined });
    expect(() => normalizeKllConfig({ tier: 's' })).toThrow();
    expect(() => normalizeKllConfig({ tiers: 'strong' })).toThrow();
  });
  it.each([{ ...input, kll: undefined }, { ...input, adoptMode: true }])('does not resolve direct or adopted sessions', cfg => {
    const execute = vi.fn();
    expect(resolveKllLaunch(cfg, { execute })).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not resolve an already-running persistent CLI', () => {
    const execute = vi.fn();
    expect(resolveKllLaunch(input, { reattach: true, execute })).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps credentials in the protected file and overrides old provider settings', () => {
    const fake = resolver();
    const selected = resolveKllLaunch({ ...input, env: { ANTHROPIC_AUTH_TOKEN: 'old-secret', ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-model', HTTP_PROXY: 'http://proxy' } }, fake)!;
    expect(fake.execute.mock.calls[0][1].slice(0, 5)).toEqual(['resolve', 'claude-code', 'strong', '--json', '--launch-env-file']);
    expect(fake.execute.mock.calls[0][1].join(' ')).not.toMatch(/new-secret|old-secret/);
    expect(selected.model).toBe('glm-5.3');
    expect(selected.env).toEqual({ ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_API_KEY: 'new-secret', ANTHROPIC_BASE_URL: 'https://selected.example', HTTP_PROXY: 'http://proxy' });
    expect(fake.cleaned()).toBe(true);
  });
  it('gives an explicit model priority over a previous selection and a tier', () => {
    const fake = resolver();
    resolveKllLaunch({ ...input, model: 'explicit-model' }, { ...fake, selectedProfileId: 'previous-model' });
    expect(fake.execute.mock.calls[0][1][2]).toBe('explicit-model');
  });
  it('reuses the selected model on restart, without selecting another tier candidate', () => {
    const fake = resolver();
    resolveKllLaunch(input, { ...fake, selectedProfileId: 'previous-model' });
    expect(fake.execute.mock.calls[0][1][2]).toBe('previous-model');
  });
  it('keeps standalone CodeBuddy identity and native model semantics', () => {
    const fake = resolver({ ...result, agent: 'codebuddy', cliModel: null }, {} as any);
    const selected = resolveKllLaunch({ ...input, cliId: 'codebuddy' }, fake)!;
    expect(selected.model).toBeUndefined();
    expect(fake.execute.mock.calls[0][1][1]).toBe('codebuddy');
  });
  it('maps the existing Codex catalog route while preserving the codex adapter identity', () => {
    const fake = resolver({ ...result, agent: 'codex-herdr', cliModel: null }, {} as any);
    const selected = resolveKllLaunch({ ...input, cliId: 'codex' }, fake)!;
    expect(selected.model).toBeUndefined();
    expect(fake.execute.mock.calls[0][1][1]).toBe('codex');
  });
  it('maps dsh onto the harness catalog route and keeps credentials env-only', () => {
    const fake = resolver(dshResult, { ALLINONE_DSH_API_KEY: 'dsh-secret', DSH_HOME: '/allinone/.runtime/dsh-home' });
    const selected = resolveKllLaunch({ ...input, cliId: 'dsh', env: { DEEPSEEK_API_KEY: 'old-secret', HTTP_PROXY: 'http://proxy' } }, fake)!;
    expect(fake.execute.mock.calls[0][1][1]).toBe('dsh');
    expect(fake.execute.mock.calls[0][1].join(' ')).not.toMatch(/dsh-secret|old-secret/);
    expect(selected.modelId).toBe('glm-5.3');
    expect(selected.model).toBe('glm-5.3');
    expect(selected.env).toEqual({ HTTP_PROXY: 'http://proxy', ALLINONE_DSH_API_KEY: 'dsh-secret' });
    expect(selected.removeEnv).toContain('DEEPSEEK_API_KEY');
    expect(selected.removeEnv).toContain('DSH_LIVE_CONNECTION_FILE');
    // BotMux's own process-level dsh home survives; KLL's home pointer is not consumed.
    expect(selected.removeEnv).not.toContain('DSH_HOME');
    expect(fake.cleaned()).toBe(true);
  });
  it.each([
    { env: { DSH_LIVE_CONNECTION_FILE: '/dsh-home/botmux/live/connection.json' } },
    { dshRuntime: 'tui' },
  ])('rejects dsh runtimes KLL cannot own: %j', changes => {
    const execute = vi.fn();
    expect(() => resolveKllLaunch({ ...input, cliId: 'dsh', ...changes }, { execute })).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a dsh selection without a native route model', () => {
    const fake = resolver({ ...dshResult, cliModel: null }, { ALLINONE_DSH_API_KEY: 'k' });
    expect(() => resolveKllLaunch({ ...input, cliId: 'dsh' }, fake)).toThrow('no dsh route model');
    expect(fake.cleaned()).toBe(true);
  });
  it('still rejects reserved KLL environment beyond the dsh home pointer', () => {
    const fake = resolver(dshResult, { ALLINONE_DSH_API_KEY: 'k', DSH_HOME: '/kll-home', BOTMUX_SESSION: 'hijack' });
    expect(() => resolveKllLaunch({ ...input, cliId: 'dsh' }, fake)).toThrow('reserved session variables');
    expect(fake.cleaned()).toBe(true);
  });
  it.each([
    { wrapperCli: 'aiden x claude' }, { codexRpcInput: true }, { backendType: 'mojo' }, { backendType: 'tmux' }, { backendType: 'zellij' }, { cliId: 'gemini' },
    { cliId: 'codebuddy', cliPathOverride: '/Applications/WorkBuddy.app/Contents/Resources/codebuddy' },
  ])('rejects a conflicting runtime before launch', changes => {
    const execute = vi.fn();
    expect(() => resolveKllLaunch({ ...input, ...changes }, { execute })).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ ...result, agent: 'codex' }, { ...result, schemaVersion: 2 }, { ...result, cliModel: 42 }])('rejects invalid JSON contracts and cleans secrets', response => {
    const fake = resolver(response);
    expect(() => resolveKllLaunch(input, fake)).toThrow('incompatible launch contract');
    expect(fake.cleaned()).toBe(true);
  });
  it('does not expose subprocess errors or fall back to direct launch', () => {
    expect(() => resolveKllLaunch(input, { execute: () => { throw new Error('api_key=secret-in-stderr'); } })).toThrow('KLL resolution failed; the native CLI was not started');
  });
  it('rejects missing or world-readable credential files', () => {
    expect(() => resolveKllLaunch(input, { execute: () => JSON.stringify(result) })).toThrow('protected environment file');
    expect(() => resolveKllLaunch(input, { execute: (_bin, args) => {
      writeFileSync(args.at(-1)!, '{}', { mode: 0o644 });
      chmodSync(args.at(-1)!, 0o644);
      return JSON.stringify(result);
    } })).toThrow('protected environment file');
  });
  it('feeds selected model and protected settings through the real Claude adapter without changing native session identity', () => {
    const fake = resolver();
    const selected = resolveKllLaunch(input, fake)!;
    const directory = mkdtempSync(join(tmpdir(), 'kll-adapter-test-'));
    try {
      const settingsFilePath = join(directory, 'settings.json');
      const adapter = createClaudeCodeAdapter('/native/claude');
      const args = adapter.buildArgs({ sessionId: 'native-session', resume: false, workingDir: directory,
        model: selected.model, settingsEnv: selected.env, settingsFilePath });
      expect(adapter.id).toBe('claude-code');
      expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'native-session']);
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'glm-5.3']);
      expect(args).toContain(settingsFilePath);
      expect(args.join(' ')).not.toContain('new-secret');
      expect(JSON.parse(readFileSync(settingsFilePath, 'utf8')).env).toEqual(selected.env);
      expect(statSync(settingsFilePath).mode & 0o777).toBe(0o600);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('preserves ordinary native selection and existing explicit model priorities', () => {
    const ds = { session: { cliId: 'claude-code' as const, model: 'glm-5.3', kllProfileId: 'profile-glm' } };
    expect(resolveSessionLaunchModel(ds, { cliId: 'claude-code' })).toBeUndefined();
    expect(resolveSessionLaunchModel(ds, { cliId: 'claude-code', kll: {} })).toBe('profile-glm');
    expect(resolveSessionLaunchModel(ds, { cliId: 'claude-code', kll: {}, model: 'new-explicit' })).toBe('new-explicit');
    expect(resolveSessionLaunchModel({ ...ds, spawnModelOverride: 'trigger' }, { cliId: 'claude-code', kll: {}, model: 'bot' })).toBe('trigger');
    expect(() => validateKllLaunch({ ...input, adoptMode: true, wrapperCli: 'external' })).not.toThrow();
  });
});
