import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { safeFailureSummary } from './codex-transcript.js';

const SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KimiNativeSource {
  sessionId: string;
  cwd: string;
  pid: number;
  birth: string;
}

/** Read the selected HERDR Agent's native identity. Never select a recent
 * session by directory, inspect a sibling Agent, or write to the terminal. */
export function inspectHerdrKimiSource(
  sessionName: string,
  agentName: string,
  expectedPid?: number,
): KimiNativeSource | undefined {
  try {
    const call = (args: string[]) => JSON.parse(execFileSync('herdr', ['--session', sessionName, ...args], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const agent = () => call(['agent', 'get', agentName]).result?.agent;
    const before = agent();
    const sid = before?.agent_session;
    const cwd = before?.foreground_cwd ?? before?.cwd;
    if (before?.name !== agentName || before.agent !== 'kimi' || sid?.kind !== 'id'
      || sid.source !== 'herdr:kimi' || !SESSION_ID.test(sid.value) || !isAbsolute(cwd ?? '') || !before.pane_id) return;
    const processes = () => call(['pane', 'process-info', '--pane', before.pane_id]).result?.process_info;
    const candidates = (info: any) => (info?.foreground_processes ?? []).filter((p: any) =>
      p.pid !== info.shell_pid && (p.name === 'kimi' || p.argv0 === 'kimi-code'
        || (p.argv ?? []).some((arg: unknown) => typeof arg === 'string' && basename(arg) === 'kimi')));
    const first = candidates(processes());
    if (first.length !== 1 || !Number.isSafeInteger(first[0].pid) || first[0].pid < 2
      || (expectedPid !== undefined && first[0].pid !== expectedPid) || first[0].cwd !== cwd) return;
    const pid = first[0].pid;
    const birth = () => execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const started = birth();
    const after = agent();
    const last = candidates(processes());
    if (!started || birth() !== started || last.length !== 1 || last[0].pid !== pid || last[0].cwd !== cwd
      || after?.name !== before.name || after?.agent !== 'kimi' || after?.pane_id !== before.pane_id
      || after?.agent_session?.kind !== sid.kind || after.agent_session?.source !== sid.source
      || after.agent_session?.value !== sid.value || (after.foreground_cwd ?? after.cwd) !== cwd) return;
    return { sessionId: sid.value, cwd, pid, birth: started };
  } catch { return; }
}

/** Kimi native state v2 names its owner explicitly. Require the exact
 * observed session and canonical workspace; ambiguous buckets fail closed. */
export function findKimiWireSource(source: KimiNativeSource, dataRoot = join(homedir(), '.kimi-code')): string | undefined {
  if (!SESSION_ID.test(source.sessionId) || !isAbsolute(source.cwd)
    || !Number.isSafeInteger(source.pid) || source.pid < 2 || typeof source.birth !== 'string' || !source.birth.trim()) return;
  const root = join(dataRoot, 'sessions');
  try {
    const cwd = realpathSync(source.cwd);
    const matches: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name, source.sessionId);
      const stateFile = join(dir, 'state.json');
      if (!existsSync(stateFile)) continue;
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (state?.version !== 2 || state.id !== source.sessionId || typeof state.cwd !== 'string'
        || realpathSync(state.cwd) !== cwd) continue;
      const file = join(dir, 'agents', 'main', 'wire.jsonl');
      if (existsSync(file)) matches.push(file);
    }
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return; }
}

export interface KimiNativeFailure {
  turnId: string;
  dispatchAttempt?: number;
  errorCode: string;
  summary?: string;
  retryable?: boolean;
  completedAtMs: number;
}

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
const identity = (source: KimiNativeSource) => JSON.stringify(source);

/** Failure-only observer: successful Kimi turns retain their existing
 * botmux-send delivery. A screen/AuthError string is never terminal evidence.
 * Marks are made immediately before the actual input, so old wire history
 * cannot complete a new task. Partial lines stay unread until completed. */
export class KimiNativeFailureObserver {
  private pending?: {
    source: KimiNativeSource;
    file: string;
    offset: number;
    content: string;
    markedAtMs: number;
    turnId: string;
    dispatchAttempt?: number;
    nativeTurnId?: number;
    nativePromptId?: string;
    promptAtMs?: number;
  };

  get active(): boolean { return this.pending !== undefined; }
  clear(): void { this.pending = undefined; }

  mark(source: KimiNativeSource, input: { content: string; turnId: string; dispatchAttempt?: number },
    markedAtMs = Date.now(), dataRoot?: string): void {
    this.clear();
    const file = findKimiWireSource(source, dataRoot);
    if (!file || !input.turnId || !input.content.trim()) return;
    try {
      const bytes = readFileSync(file);
      const metadata = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8'));
      if (metadata.type !== 'metadata' || metadata.protocol_version !== '1.5') return;
      this.pending = { source: { ...source }, file, offset: bytes.lastIndexOf(10) + 1,
        content: normalized(input.content), markedAtMs, turnId: input.turnId, dispatchAttempt: input.dispatchAttempt };
    } catch { /* Unrecognized native storage is not evidence. */ }
  }

  poll(source: KimiNativeSource | undefined): KimiNativeFailure | undefined {
    const pending = this.pending;
    if (!pending) return;
    if (!source || identity(source) !== identity(pending.source)) { this.clear(); return; }
    try {
      const bytes = readFileSync(pending.file);
      if (bytes.length < pending.offset) { this.clear(); return; }
      const end = bytes.lastIndexOf(10) + 1;
      const lines = bytes.subarray(pending.offset, end).toString('utf8').split('\n').filter(Boolean);
      pending.offset = end;
      for (const line of lines) {
        const row = JSON.parse(line);
        if (row.agentId !== 'main' || !Number.isFinite(row.time) || row.time < pending.markedAtMs) continue;
        if (row.type === 'turn.prompt') {
          const text = Array.isArray(row.input) ? row.input.filter((b: any) => b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text).join('\n') : '';
          if (row.origin?.kind !== 'user' || !Number.isSafeInteger(row.turnId) || row.turnId < 0
            || typeof row.promptId !== 'string' || !row.promptId || normalized(text) !== pending.content
            || (pending.nativePromptId && (pending.nativePromptId !== row.promptId || pending.nativeTurnId !== row.turnId))) { this.clear(); return; }
          pending.nativeTurnId = row.turnId;
          pending.nativePromptId = row.promptId;
          pending.promptAtMs = row.time;
        }
        if (row.type !== 'turn.ended' || !pending.nativePromptId || row.turnId !== pending.nativeTurnId
          || row.time < pending.promptAtMs!) continue;
        this.clear();
        if (row.reason !== 'failed' || typeof row.error?.code !== 'string' || !row.error.code
          || !/^[a-z0-9_.-]{1,80}$/i.test(row.error.code)) return;
        return { turnId: pending.turnId, dispatchAttempt: pending.dispatchAttempt,
          errorCode: `kimi_${row.error.code.replaceAll('.', '_')}`,
          summary: safeFailureSummary(row.error),
          ...(typeof row.error.retryable === 'boolean' ? { retryable: row.error.retryable } : {}),
          completedAtMs: row.time };
      }
    } catch { this.clear(); }
  }
}
