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
};

export function validateKllLaunch(input: LaunchInput): void {
  if (!input.kll || input.adoptMode) return;
  if (!['claude-code', 'codebuddy', 'kimi', 'codex'].includes(input.cliId)) throw new Error('KLL requires a supported native CLI adapter');
  if (input.cliId === 'codebuddy' && /WorkBuddy[^/]*\.app\//i.test(input.cliPathOverride ?? '')) throw new Error('KLL cb requires standalone CodeBuddy');
  if (input.wrapperCli || input.cliLaunchMode || input.codexRpcInput || input.existingAppServerEndpoint
      || (input.backendType !== undefined && !['herdr', 'pty'].includes(input.backendType))) {
    throw new Error('KLL requires a local interactive CLI without a wrapper or RPC mode');
  }
}

/** KLL owns launch-time model/provider settings; retain unrelated CLI flags. */
export function validateKllExtraArgs(input: LaunchInput, args: string[]): void {
  if (!input.kll || input.adoptMode) return;
  if (args.some(arg => /^(?:--model|--settings)(?:=|$)/.test(arg) || /^-m/.test(arg))) {
    throw new Error('KLL launch model and settings cannot be overridden by CLI_EXTRA_ARGS');
  }
}

export type KllLaunchResolution = {
  modelId: string;
  profileId: string;
  model: string | undefined;
  env: Record<string, string>;
  removeEnv: string[];
};

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
    // AllInOne's existing catalog names the Codex terminal route codex-herdr;
    // BotMux keeps its native codex adapter/session identity throughout.
    const expectedAgent = input.cliId === 'codex' ? 'codex-herdr' : input.cliId;
    if (result?.schemaVersion !== 1 || result.agent !== expectedAgent
        || typeof result.modelId !== 'string' || !result.modelId
        || typeof result.profileRef?.id !== 'string' || !result.profileRef.id
        || (result.cliModel !== null && (typeof result.cliModel !== 'string' || !result.cliModel))
        || !Array.isArray(result.launch?.removeEnv)
        || !result.launch.removeEnv.every((key: unknown) => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        || !values || typeof values !== 'object' || Array.isArray(values)
        || !Object.entries(values).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'))) {
      throw new Error('KLL returned an incompatible launch contract');
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
    const overrides = values as Record<string, string>;
    const sanitized = sanitizePerBotEnv(overrides);
    if (Object.keys(sanitized).length !== Object.keys(overrides).length) throw new Error('KLL environment contains reserved session variables');
    Object.assign(env, sanitized);
    return { modelId: result.modelId, profileId: result.profileRef.id, model: result.cliModel ?? undefined, env, removeEnv: [...removeEnv] };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
