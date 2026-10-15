import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizePerBotEnv } from '../core/per-bot-env.js';

/** Opt-in, local launch-time resource selection. KLL never owns the terminal. */
export interface KllConfig {
  executable?: string;
  tier?: 'max' | 'strong' | 'high';
}

export function normalizeKllConfig(value: unknown): KllConfig | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('kll must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => key !== 'executable' && key !== 'tier')) throw new Error('Unknown kll option');
  if (raw.executable !== undefined && (typeof raw.executable !== 'string' || !raw.executable.trim() || raw.executable.includes('\0'))) {
    throw new Error('kll.executable must name an executable, without arguments');
  }
  if (raw.tier !== undefined && !['max', 'strong', 'high'].includes(raw.tier as string)) throw new Error('kll.tier must be max, strong or high');
  return { executable: raw.executable as string | undefined, tier: (raw.tier ?? 'strong') as KllConfig['tier'] };
}

type LaunchInput = {
  kll?: KllConfig;
  cliId: string;
  cliPathOverride?: string;
  model?: string;
  env?: Record<string, string>;
  adoptMode?: boolean;
  wrapperCli?: string;
  cliLaunchMode?: unknown;
  codexRpcInput?: boolean;
  existingAppServerEndpoint?: string;
  backendType?: string;
  /** dsh runtime variant ('tui' boots the raw TUI adapter, not the SDK runner). */
  dshRuntime?: unknown;
};

export function validateKllLaunch(input: LaunchInput): void {
  if (!input.kll || input.adoptMode) return;
  if (!['claude-code', 'codebuddy', 'kimi', 'codex', 'dsh'].includes(input.cliId)) throw new Error('KLL requires a supported native CLI adapter');
  if (input.cliId === 'codebuddy' && /WorkBuddy[^/]*\.app\//i.test(input.cliPathOverride ?? '')) throw new Error('KLL cb requires standalone CodeBuddy');
  if (input.cliId === 'dsh') {
    if (input.dshRuntime === 'tui') throw new Error('KLL dsh requires the SDK runner; the dsh-tui runtime is not supported');
  }
  if (input.wrapperCli || input.cliLaunchMode || input.codexRpcInput || input.existingAppServerEndpoint
      || (input.backendType !== undefined && !['herdr', 'pty'].includes(input.backendType))) {
    throw new Error('KLL requires a local interactive CLI without a wrapper or RPC mode');
  }
}

/** KLL owns launch-time model/provider settings; retain unrelated CLI flags. */
export function validateKllExtraArgs(input: LaunchInput, args: string[], resolution?: KllLaunchResolution): void {
  if (!input.kll || input.adoptMode) return;
  if (args.some(arg => /^(?:--model|--settings)(?:=|$)/.test(arg) || /^-m/.test(arg))) {
    throw new Error('KLL launch model and settings cannot be overridden by CLI_EXTRA_ARGS');
  }
  if (input.cliId === 'codex' && resolution?.args.length) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (/^(--(?:oss|local-provider|profile|remote)(?:=|$)|-p)/.test(arg)) {
        throw new Error('KLL launch provider cannot be overridden by CLI_EXTRA_ARGS');
      }
      const value = arg === '-c' || arg === '--config' ? args[++i]
        : arg.startsWith('--config=') ? arg.slice(9) : arg.startsWith('-c') ? arg.slice(2) : undefined;
      if (value && /^(model|model_provider|model_providers|profile|profiles|model_catalog_json|openai_base_url)(\s*=|\.)/.test(value.trim())) {
        throw new Error('KLL launch provider cannot be overridden by CLI_EXTRA_ARGS');
      }
    }
  }
}

export type KllLaunchResolution = {
  modelId: string;
  profileId: string;
  model: string | undefined;
  env: Record<string, string>;
  removeEnv: string[];
  /** Non-secret native provider overrides. Version 2 requires consumption. */
  args: string[];
};

export function applyKllLaunchArgs(args: string[], resolution?: KllLaunchResolution): string[] {
  // Config flags belong before a Codex resume/fork subcommand, just like the
  // native adapter's other process-level overrides.
  if (resolution?.args.length) args.unshift(...resolution.args);
  return args;
}

type ExecuteResolver = (bin: string, args: string[], env: NodeJS.ProcessEnv) => string;
const executeResolver: ExecuteResolver = (bin, args, env) => execFileSync(bin, args, {
  encoding: 'utf8', env, timeout: 15_000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

/** No resolution for adoption or reattachment; those already have a model. */
export function resolveKllLaunch(
  input: LaunchInput,
  options: { reattach?: boolean; selectedProfileId?: string; execute?: ExecuteResolver } = {},
): KllLaunchResolution | undefined {
  if (!input.kll || input.adoptMode || options.reattach) return undefined;
  validateKllLaunch(input);
  const directory = mkdtempSync(join(tmpdir(), 'botmux-kll-'));
  const envFile = join(directory, 'env.json');
  const selector = input.model || options.selectedProfileId || input.kll.tier || 'strong';
  const args = ['resolve', input.cliId, selector, '--json', '--launch-env-file', envFile];
  try {
    let stdout: string;
    try {
      stdout = (options.execute ?? executeResolver)(input.kll.executable ?? 'kll', args, {
        ...process.env, ...sanitizePerBotEnv(input.env),
      });
    } catch {
      // exec errors contain argv/stdout/stderr; never relay them to logs or IM.
      throw new Error('KLL resolution failed; the native CLI was not started');
    }
    let result: any;
    let values: unknown;
    try {
      result = JSON.parse(stdout);
      const stat = lstatSync(envFile);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024
          || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      values = JSON.parse(readFileSync(envFile, 'utf8'));
    } catch {
      throw new Error('KLL returned an invalid result or protected environment file');
    }
    // AllInOne's existing catalog names the Codex terminal route codex-herdr and
    // the dsh runner route dsh-harness; BotMux keeps its native adapter/session
    // identity throughout.
    const expectedAgent = input.cliId === 'codex' ? 'codex-herdr' : input.cliId === 'dsh' ? 'dsh-harness' : input.cliId;
    if (![1, 2].includes(result?.schemaVersion) || result.agent !== expectedAgent
        || typeof result.modelId !== 'string' || !result.modelId
        || typeof result.profileRef?.id !== 'string' || !result.profileRef.id
        || (result.cliModel !== null && (typeof result.cliModel !== 'string' || !result.cliModel))
        || !Array.isArray(result.launch?.removeEnv)
        || !result.launch.removeEnv.every((key: unknown) => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        || !values || typeof values !== 'object' || Array.isArray(values)
        || !Object.entries(values).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'))) {
      throw new Error('KLL returned an incompatible launch contract');
    }
    let providerArgs: string[] = [];
    if (result.schemaVersion === 2) {
      providerArgs = result.launch.args;
      const configArgs = Array.isArray(providerArgs) && providerArgs[0] === '--no-daemon' ? providerArgs.slice(1) : providerArgs;
      if (input.cliId !== 'codex' || !Array.isArray(providerArgs) || !providerArgs.length
          || providerArgs.length > 33 || !Array.isArray(configArgs) || !configArgs.length || configArgs.length % 2 !== 0
          || !configArgs.every((value: unknown, index: number) => typeof value === 'string'
            && !value.includes('\0') && (index % 2 === 0 ? value === '--config'
              : /^(model|model_provider|model_providers\.[a-z0-9_-]+)=/.test(value)))) {
        throw new Error('KLL returned an incompatible launch contract');
      }
      const secrets = Object.entries(values).filter(([key]) => /KEY|TOKEN|SECRET/.test(key)).map(([, value]) => value as string).filter(Boolean);
      if (providerArgs.some(arg => secrets.some(secret => arg.includes(secret)))) {
        throw new Error('KLL provider arguments must not contain credentials');
      }
    } else if (result.launch.args !== undefined) {
      throw new Error('KLL provider arguments require launch contract version 2');
    }
    // dsh routes are per-model: without a native cliModel the runner would fall
    // back to the profile's own provider default, which KLL must never do.
    if (input.cliId === 'dsh' && typeof result.cliModel !== 'string') {
      throw new Error('KLL returned no dsh route model; the native CLI was not started');
    }
    const env = sanitizePerBotEnv(input.env);
    const removeEnv = new Set<string>(result.launch.removeEnv);
    if (input.cliId === 'claude-code') {
      for (const key of Object.keys(env)) {
        if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_OAUTH')) removeEnv.add(key);
      }
    }
    for (const key of removeEnv) {
      delete env[key];
      // Claude merges lower-priority settings.env too. Empty these keys in its
      // --settings file so a user's old provider cannot reappear at startup.
      if (input.cliId === 'claude-code' && (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_OAUTH'))) env[key] = '';
    }
    // KLL strips every DSH_*/DEEPSEEK_* key it observed, including the daemon's
    // own process-level DSH_HOME. That home is where botmux's dsh profiles and
    // sessions live and what the adapter bound into the sandbox, so it leaves
    // the removal set the worker applies to the child environment. The KLL home
    // pointer in the env file below is not consumed for the same reason.
    if (input.cliId === 'dsh') removeEnv.delete('DSH_HOME');
    const overrides = values as Record<string, string>;
    // KLL's dsh env names its own dsh home (where KLL's web profiles live).
    // BotMux's SDK runner keeps the process-level DSH_HOME it already bound
    // into the sandbox and where its profiles/sessions live, so that value is
    // deliberately not consumed; every other reserved key stays a hard error.
    if (input.cliId === 'dsh' && typeof overrides.DSH_HOME === 'string') delete overrides.DSH_HOME;
    const sanitized = sanitizePerBotEnv(overrides);
    if (Object.keys(sanitized).length !== Object.keys(overrides).length) throw new Error('KLL environment contains reserved session variables');
    Object.assign(env, sanitized);
    return { modelId: result.modelId, profileId: result.profileRef.id, model: result.cliModel ?? undefined, env, removeEnv: [...removeEnv], args: providerArgs };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
