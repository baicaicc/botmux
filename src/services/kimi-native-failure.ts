import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { safeFailureSummary } from './codex-transcript.js';

const SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KimiNativeOwner {
  sessionId?: string;
  cwd: string;
  pid: number;
  birth: string;
}
export interface KimiNativeSource extends KimiNativeOwner { sessionId: string; }

/** Read the selected HERDR Agent's native identity. Never select a recent
 * session by directory, inspect a sibling Agent, or write to the terminal. */
export function inspectHerdrKimiOwner(
  sessionName: string,
  agentName: string,
  expectedPid?: number,
): KimiNativeOwner | undefined {
  try {
    const call = (args: string[]) => JSON.parse(execFileSync('herdr', ['--session', sessionName, ...args], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const agent = () => call(['agent', 'get', agentName]).result?.agent;
    const before = agent();
    const sid = before?.agent_session;
    const cwd = before?.foreground_cwd ?? before?.cwd;
    if (before?.name !== agentName || before.agent !== 'kimi'
      || (sid !== undefined && (sid?.kind !== 'id' || sid.source !== 'herdr:kimi' || !SESSION_ID.test(sid.value)))
      || !isAbsolute(cwd ?? '') || !before.pane_id) return;
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
      || after?.agent_session?.kind !== sid?.kind || after.agent_session?.source !== sid?.source
      || after.agent_session?.value !== sid?.value || (after.foreground_cwd ?? after.cwd) !== cwd) return;
    return { ...(sid ? {sessionId: sid.value} : {}), cwd, pid, birth: started };
  } catch { return; }
}

export function inspectHerdrKimiSource(sessionName: string, agentName: string, expectedPid?: number): KimiNativeSource | undefined {
  const owner = inspectHerdrKimiOwner(sessionName, agentName, expectedPid);
  return owner?.sessionId ? owner as KimiNativeSource : undefined;
}

/** Kimi native state v2 names its owner explicitly. Require the exact
 * observed session and canonical workspace; ambiguous buckets fail closed. */
export function findKimiWireSource(source: KimiNativeSource, dataRoot = join(homedir(), '.kimi-code'), createdAfterMs?: number): string | undefined {
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
        || realpathSync(state.cwd) !== cwd || (createdAfterMs !== undefined
          && (!Number.isFinite(state.createdAt) || state.createdAt < createdAfterMs))) continue;
      const file = join(dir, 'agents', 'main', 'wire.jsonl');
      if (existsSync(file)) matches.push(file);
    }
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return; }
}

export interface KimiNativeFailure {
  nativeSessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  errorCode: string;
  summary?: string;
  retryable?: boolean;
  completedAtMs: number;
}

const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
const sameProcess = (a: KimiNativeOwner, b: KimiNativeOwner) => a.pid === b.pid && a.birth === b.birth && a.cwd === b.cwd;

/** Failure-only observer: successful Kimi turns retain their existing
 * botmux-send delivery. A screen/AuthError string is never terminal evidence.
 * Marks are made immediately before the actual input, so old wire history
 * cannot complete a new task. Partial lines stay unread until completed. */
export class KimiNativeFailureObserver {
  private pending?: {
    source: KimiNativeOwner;
    file?: string;
    dataRoot?: string;
    requireNewStorage: boolean;
    offset: number;
    content: string;
    markedAtMs: number;
    turnId: string;
    dispatchAttempt?: number;
    nativeTurnId?: number;
    nativePromptId?: string;
    promptAtMs?: number;
    failure?: KimiNativeFailure;
  };

  get active(): boolean { return this.pending !== undefined; }
  clear(): void { this.pending = undefined; }

  mark(source: KimiNativeOwner, input: { content: string; turnId: string; dispatchAttempt?: number },
    markedAtMs = Date.now(), dataRoot?: string): void {
    this.clear();
    if (!input.turnId || !input.content.trim() || !Number.isSafeInteger(source.pid) || source.pid < 2
      || !source.birth || !isAbsolute(source.cwd) || !Number.isFinite(markedAtMs)
      || (source.sessionId !== undefined && !SESSION_ID.test(source.sessionId))) return;
    let file = source.sessionId === undefined ? undefined : findKimiWireSource(source as KimiNativeSource, dataRoot);
    try {
      let offset = 0;
      if (file) {
        const bytes = readFileSync(file);
        if (bytes.indexOf(10) < 0) file = undefined;
        else {
          const metadata = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8'));
          if (metadata.type !== 'metadata' || metadata.protocol_version !== '1.5') return;
          offset = bytes.lastIndexOf(10) + 1;
        }
      }
      this.pending = { source: { ...source }, file, dataRoot, requireNewStorage: source.sessionId === undefined, offset,
        content: normalized(input.content), markedAtMs, turnId: input.turnId, dispatchAttempt: input.dispatchAttempt };
    } catch { /* Unrecognized native storage is not evidence. */ }
  }

  poll(source: KimiNativeOwner | undefined): KimiNativeFailure | undefined {
    const pending = this.pending;
    if (!pending) return;
    // An incomplete HERDR sample is not evidence of a different owner. Native
    // identity can be published between the inspector's two reads.
    if (!source) return;
    if (!sameProcess(source, pending.source)
      || (pending.source.sessionId !== undefined && source.sessionId !== undefined
        && source.sessionId !== pending.source.sessionId)) { this.clear(); return; }
    if (pending.source.sessionId !== undefined && source.sessionId === undefined) return;
    if (pending.failure) return pending.failure;
    try {
      if (!pending.file) {
        // Fresh Kimi creates state/wire only after its first input. The owner
        // was pinned before that input. An ID first observed after submit also
        // requires new state/header timestamps; a pre-verified exact ID can
        // publish its wire later. Neither case selects by directory recency.
        if (!source.sessionId) return;
        if (!SESSION_ID.test(source.sessionId)) { this.clear(); return; }
        pending.source.sessionId = source.sessionId;
        const file = findKimiWireSource(source as KimiNativeSource, pending.dataRoot,
          pending.requireNewStorage ? pending.markedAtMs : undefined);
        if (!file) return;
        const bytes = readFileSync(file);
        if (bytes.indexOf(10) < 0) return;
        const metadata = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString('utf8'));
        if (metadata.type !== 'metadata' || metadata.protocol_version !== '1.5' || (pending.requireNewStorage
          && (!Number.isFinite(metadata.created_at) || metadata.created_at < pending.markedAtMs))) { this.clear(); return; }
        pending.file = file;
      }
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
          const wireText = normalized(text);
          // A valid, text-only empty prompt cannot prove the tracked input.
          // Skip it only before binding; other prompts retain the exact guards.
          if (!pending.nativePromptId && row.origin?.kind === 'user'
            && Number.isSafeInteger(row.turnId) && row.turnId >= 0
            && typeof row.promptId === 'string' && row.promptId
            && Array.isArray(row.input) && row.input.every((b: any) => b?.type === 'text' && typeof b.text === 'string')
            && !wireText) continue;
          if (row.origin?.kind !== 'user' || !Number.isSafeInteger(row.turnId) || row.turnId < 0
            || typeof row.promptId !== 'string' || !row.promptId || wireText !== pending.content
            || (pending.nativePromptId && (pending.nativePromptId !== row.promptId || pending.nativeTurnId !== row.turnId))) { this.clear(); return; }
          pending.nativeTurnId = row.turnId;
          pending.nativePromptId = row.promptId;
          pending.promptAtMs = row.time;
        }
        if (row.type !== 'turn.ended' || !pending.nativePromptId || row.turnId !== pending.nativeTurnId
          || row.time < pending.promptAtMs!) continue;
        if (row.reason !== 'failed' || typeof row.error?.code !== 'string' || !row.error.code
          || !/^[a-z0-9_.-]{1,80}$/i.test(row.error.code)) { this.clear(); return; }
        pending.failure = { nativeSessionId: pending.source.sessionId!, turnId: pending.turnId, dispatchAttempt: pending.dispatchAttempt,
          errorCode: `kimi_${row.error.code.replaceAll('.', '_')}`,
          summary: safeFailureSummary(row.error),
          ...(typeof row.error.retryable === 'boolean' ? { retryable: row.error.retryable } : {}),
          completedAtMs: row.time };
        return pending.failure;
      }
    } catch { this.clear(); }
  }

  /** Consume only after the worker's fresh owner/turn/generation fence. A
   * missing fresh observation leaves the terminal available for a later tick. */
  acknowledge(failure: KimiNativeFailure, source: KimiNativeOwner | undefined): boolean {
    const pending = this.pending;
    if (!pending || pending.failure !== failure || !source) return false;
    if (!sameProcess(source, pending.source) || (source.sessionId !== undefined
      && source.sessionId !== failure.nativeSessionId)) { this.clear(); return false; }
    if (source.sessionId !== failure.nativeSessionId) return false;
    this.clear();
    return true;
  }
}
