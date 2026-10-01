#!/usr/bin/env node
/** BotMux observer/submission client for one existing native dsh Web owner. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import {
  DshLiveClient, DshLiveClientError,
  type DshFollowFrame, type DshFollowOptions, type DshPromptRequest, type DshSessionEvent,
} from './services/dsh-live-client.js';

const INPUT_PREFIX = '::botmux-dsh:';
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export class DshLiveRunnerError extends Error {
  constructor(readonly code: string) {
    super(`dsh Web runner failed (${code}).`);
    this.name = 'DshLiveRunnerError';
  }
}

/** No process ownership, session creation, identity changes, or approval answers. */
export interface DshRunnerClient {
  readonly sessionId: string;
  follow(options?: DshFollowOptions): Promise<AsyncIterable<DshFollowFrame> & { close(): void }>;
  prompt(request: DshPromptRequest): Promise<{ accepted: true }>;
  cancel(): Promise<{ accepted: true }>;
  close(): void;
}

export interface DshLiveInput {
  readonly content: string;
  readonly replyTurnId?: string;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface DshLiveFinal {
  readonly content: string;
  readonly requestId: string;
  readonly nativeSessionId: string;
  readonly nativeTurnId: string;
  readonly reason: string;
  readonly turnId?: string;
  readonly replyTurnId?: string;
  readonly usage?: Usage;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

interface Pending {
  readonly requestId: string;
  readonly replyTurnId?: string;
  readonly startedAtMs: number;
  readonly resolve: (result: DshLiveFinal) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  acknowledged: boolean;
  nativeTurn?: number;
  nativeStep?: number;
  content: string;
  usage?: Usage;
  terminal?: { reason: string; time: number };
}

export interface DshLiveRunnerOptions {
  readonly output?: RunnerControlWriter;
  readonly turnTimeoutMs?: number;
  readonly cwd?: string;
  /** Called for a fenced observer; no queued or uncertain request is resent. */
  readonly failed?: (error: DshLiveRunnerError) => void;
}

function safeFailure(error: unknown, fallback: string): DshLiveRunnerError {
  if (error instanceof DshLiveRunnerError) return error;
  if (error instanceof DshLiveClientError) return new DshLiveRunnerError(error.code);
  return new DshLiveRunnerError(fallback);
}

function usage(value: unknown): Usage | undefined {
  if (!record(value) || !integer(value.inputTokens) || !integer(value.outputTokens)) return;
  return {
    inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheReadTokens: integer(value.cacheReadTokens) ? value.cacheReadTokens : 0,
    cacheCreateTokens: integer(value.cacheWriteTokens) ? value.cacheWriteTokens : 0,
  };
}

/**
 * Correlate append user/source.rpcId inside explicit open turn AND step bounds.
 * Official agent-loop starts the turn, starts the step, and then appends every
 * claimed user message. Inbox insertion and RPC acceptance establish no turn.
 */
export class DshLiveRunner {
  #output: RunnerControlWriter;
  #timeoutMs: number;
  #state: 'new' | 'starting' | 'ready' | 'failed' | 'closed' = 'new';
  #subscription?: AsyncIterable<DshFollowFrame> & { close(): void };
  #pending?: Pending;
  #cursor = -1;
  #turn?: number;
  #step?: { turn: number; step: number };
  #truncatedBoundary = false;

  constructor(private client: DshRunnerClient, private options: DshLiveRunnerOptions = {}) {
    this.#output = options.output ?? new RunnerControlWriter();
    this.#timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > MAX_TIMEOUT_MS) {
      throw new DshLiveRunnerError('invalid_timeout');
    }
  }

  async start(): Promise<void> {
    if (this.#state !== 'new') throw new DshLiveRunnerError('already_started');
    this.#state = 'starting';
    try {
      const subscription = await this.client.follow({ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } });
      if ((this.#state as string) === 'closed') { subscription.close(); throw new DshLiveRunnerError('detached'); }
      this.#subscription = subscription;
      const iterator = subscription[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.type !== 'snapshot') throw new DshLiveRunnerError('missing_snapshot');
      this.#snapshot(first.value);
      this.#state = 'ready';
      void this.#observe(iterator);
    } catch (error) {
      const failed = safeFailure(error, 'observation_failed');
      this.#fail(failed);
      throw failed;
    }
  }

  #snapshot(frame: Extract<DshFollowFrame, { type: 'snapshot' }>): void {
    if (frame.header.id !== this.client.sessionId || !Number.isSafeInteger(frame.cursor) || frame.cursor < -1) {
      throw new DshLiveRunnerError('invalid_snapshot');
    }
    if (this.options.cwd !== undefined) {
      try {
        if (typeof frame.header.cwd !== 'string' || realpathSync(frame.header.cwd) !== realpathSync(this.options.cwd)) {
          throw new DshLiveRunnerError('owner_cwd_mismatch');
        }
      } catch { throw new DshLiveRunnerError('owner_cwd_mismatch'); }
    }
    // Official pagination can cut inside a live turn at maxMessages, even with
    // turnWindow set. Its first later step/start proves the missing parent turn.
    // This restores observation bounds only; no historical event owns a request.
    this.#truncatedBoundary = frame.hasMore;
    let previous: number | undefined;
    for (const row of frame.records) {
      if (!integer(row.event.seq) || row.event.seq > frame.cursor || (previous !== undefined && row.event.seq !== previous + 1)) {
        throw new DshLiveRunnerError('invalid_snapshot_sequence');
      }
      previous = row.event.seq;
      this.#event(row.event, true);
    }
    this.#cursor = frame.cursor;
  }

  async #observe(iterator: AsyncIterator<DshFollowFrame>): Promise<void> {
    try {
      while (this.#state === 'ready') {
        const next = await iterator.next();
        if (this.#state !== 'ready') return;
        if (next.done) throw new DshLiveRunnerError('stream_ended');
        const frame = next.value;
        if (frame.type === 'snapshot') throw new DshLiveRunnerError('duplicate_snapshot');
        // Completion and final text use durable settlements. Token frames are
        // presentation only and cannot establish ownership or completion.
        if (frame.type === 'assistant-stream') continue;
        if (frame.event.seq <= this.#cursor) continue;
        if (frame.event.seq !== this.#cursor + 1) throw new DshLiveRunnerError('sequence_gap');
        this.#cursor = frame.event.seq;
        this.#event(frame.event, false);
      }
    } catch (error) {
      if (this.#state === 'ready') this.#fail(safeFailure(error, 'observation_failed'));
    }
  }

  #event(event: DshSessionEvent, historical: boolean): void {
    const data = record(event.data) ? event.data : {};
    if (event.type === 'turn/start') {
      if (!integer(data.turn) || this.#turn !== undefined) throw new DshLiveRunnerError('invalid_turn_boundary');
      this.#turn = data.turn;
      this.#step = undefined;
      this.#truncatedBoundary = false;
      return;
    }
    if (event.type === 'step/start') {
      const missingParent = this.#turn === undefined && this.#truncatedBoundary;
      if (!integer(data.turn) || !integer(data.step) || (this.#turn !== data.turn && !missingParent)
        || this.#step !== undefined) throw new DshLiveRunnerError('invalid_step_boundary');
      if (missingParent) this.#turn = data.turn;
      this.#step = { turn: data.turn, step: data.step };
      this.#truncatedBoundary = false;
      return;
    }
    if (event.type === 'step/end') {
      const step = this.#step;
      if (step && step.turn === data.turn && step.step === data.step) this.#step = undefined;
      return;
    }
    const pending = this.#pending;
    if (!historical && pending && event.type === 'user/message' && event.surfaceOp === 'append'
      && record(data.source) && data.source.kind === 'user' && data.source.rpcId === pending.requestId) {
      if (this.#turn === undefined || this.#step?.turn !== this.#turn || pending.nativeTurn !== undefined) {
        throw new DshLiveRunnerError('unproven_turn_admission');
      }
      pending.nativeTurn = this.#turn;
      pending.nativeStep = this.#step.step;
      return;
    }
    if (!historical && pending?.nativeTurn !== undefined && data.turn === pending.nativeTurn) {
      if (event.type === 'assistant/message' && integer(data.step) && data.step >= pending.nativeStep!) {
        const message = record(data.message) ? data.message : {};
        if (Array.isArray(message.content)) {
          pending.content = message.content.filter(part => record(part) && part.type === 'text' && typeof part.text === 'string')
            .map(part => (part as { text: string }).text).join('');
        }
        const currentUsage = usage(data.usage);
        if (currentUsage) {
          const total = pending.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
          for (const key of Object.keys(total) as Array<keyof Usage>) total[key] += currentUsage[key];
          pending.usage = total;
        }
      } else if (event.type === 'tool/call') {
        this.#output.line(`🔧 ${typeof data.name === 'string' ? data.name : 'tool'}`);
      } else if (event.type === 'tool/result') {
        this.#output.line(record(data.message) && data.message.isError === true ? '✗ tool' : '✓ tool');
      } else if (event.type === 'turn/end') {
        if (!record(data.reason) || typeof data.reason.kind !== 'string'
          || !/^[a-z][a-z0-9-]{0,40}$/.test(data.reason.kind)) throw new DshLiveRunnerError('invalid_turn_end');
        pending.terminal = { reason: data.reason.kind, time: Date.now() };
        this.#settle(pending);
      }
    }
    if (event.type === 'turn/end' && this.#turn === data.turn) {
      this.#turn = undefined;
      this.#step = undefined;
      this.#truncatedBoundary = false;
    } else if (event.type === 'turn/end' && this.#turn === undefined && integer(data.turn)) {
      this.#truncatedBoundary = false;
    }
  }

  /** Serial caller queue; each request owns exactly one proven native admission. */
  submit(input: DshLiveInput): Promise<DshLiveFinal> {
    if (this.#state !== 'ready') return Promise.reject(new DshLiveRunnerError('not_ready'));
    if (this.#pending) return Promise.reject(new DshLiveRunnerError('busy'));
    if (typeof input.content !== 'string' || !input.content.trim()
      || (input.replyTurnId !== undefined && (typeof input.replyTurnId !== 'string' || !input.replyTurnId))) {
      return Promise.reject(new DshLiveRunnerError('invalid_input'));
    }
    const requestId = `botmux-${randomUUID()}`;
    return new Promise<DshLiveFinal>((resolveFinal, reject) => {
      const pending: Pending = {
        requestId, replyTurnId: input.replyTurnId, startedAtMs: Date.now(),
        resolve: resolveFinal, reject, acknowledged: false, content: '',
        timer: setTimeout(() => this.#fail(new DshLiveRunnerError('turn_timeout')), this.#timeoutMs),
      };
      this.#pending = pending;
      this.#output.line('[dsh] waiting for the native session');
      // A response can precede the HTTP acknowledgement. Keep the pending
      // identity installed before dispatch and require both durable end + ACK.
      void this.client.prompt({ requestId, content: [{ type: 'text', text: input.content }], mode: 'queue' })
        .then(ack => {
          if (this.#pending !== pending || this.#state !== 'ready') return;
          if (ack.accepted !== true) throw new DshLiveRunnerError('invalid_acceptance');
          pending.acknowledged = true;
          this.#settle(pending);
        }).catch(error => {
          if (this.#pending === pending) this.#fail(safeFailure(error, 'submission_failed'));
        });
    });
  }

  #settle(pending: Pending): void {
    if (this.#pending !== pending || !pending.acknowledged || !pending.terminal || pending.nativeTurn === undefined) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    const reason = pending.terminal.reason;
    const content = reason === 'completed' ? pending.content
      : reason === 'aborted' ? 'dsh 任务已取消。' : `dsh 任务结束（${reason}）。`;
    const result: DshLiveFinal = {
      content, requestId: pending.requestId, nativeSessionId: this.client.sessionId,
      nativeTurnId: String(pending.nativeTurn), reason,
      ...(pending.replyTurnId ? { turnId: pending.replyTurnId, replyTurnId: pending.replyTurnId } : {}),
      ...(pending.usage ? { usage: pending.usage } : {}),
      startedAtMs: pending.startedAtMs, completedAtMs: pending.terminal.time,
    };
    this.#output.marker('final', result);
    pending.resolve(result);
  }

  #fail(error: DshLiveRunnerError): void {
    if (this.#state === 'closed' || this.#state === 'failed') return;
    this.#state = 'failed';
    const pending = this.#pending; this.#pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    this.#subscription?.close();
    this.client.close();
    this.options.failed?.(error);
  }

  /** User cancellation asks the owner to cancel; its accepted reply is no final. */
  async cancel(): Promise<void> {
    if (this.#state !== 'ready') throw new DshLiveRunnerError('not_ready');
    try { await this.client.cancel(); }
    catch (error) { throw safeFailure(error, 'cancel_failed'); }
  }

  /** Detach leaves the native process and its current/queued work untouched. */
  close(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    const pending = this.#pending; this.#pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new DshLiveRunnerError('detached')); }
    this.#subscription?.close();
    this.client.close();
  }
}

export interface DshLiveConnection {
  readonly webUrl: string;
  readonly sessionId: string;
  readonly cwd?: string;
}

/** Token-bearing startup URL is read from a private file, never process argv. */
export function readDshLiveConnection(path: string): DshLiveConnection {
  let descriptor: number | undefined;
  try {
    if (!isAbsolute(path)) throw new DshLiveRunnerError('unsafe_connection_file');
    const pathStat = lstatSync(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new DshLiveRunnerError('unsafe_connection_file');
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
      || stat.size > 16_384 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new DshLiveRunnerError('unsafe_connection_file');
    }
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!record(value) || typeof value.webUrl !== 'string' || !value.webUrl
      || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256
      || /[\r\n\x00]/.test(value.sessionId)
      || (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd))) {
      throw new DshLiveRunnerError('invalid_connection_file');
    }
    return { webUrl: value.webUrl, sessionId: value.sessionId, ...(value.cwd ? { cwd: value.cwd as string } : {}) };
  } catch (error) { throw safeFailure(error, 'connection_file_unreadable'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

interface Args { connectionFile: string; cwd?: string; turnTimeoutMs: number }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { connectionFile: '', turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (typeof value !== 'string' || !value) throw new DshLiveRunnerError('invalid_arguments');
    if (key === '--connection-file') args.connectionFile = value;
    else if (key === '--cwd') args.cwd = value;
    else if (key === '--turn-timeout-ms') args.turnTimeoutMs = Number(value);
    // The existing native owner's selection is authoritative. No model RPC is
    // sent by an attach; an explicit requested selection cannot be claimed.
    else if (key === '--model') throw new DshLiveRunnerError('model_override_unsupported');
    // Existing BotMux session metadata is routing context, not model input.
    else if (!['--session-id', '--dsh-bin', '--bot-name', '--bot-open-id', '--locale', '--dsh-profile', '--bridge-patch'].includes(key)) {
      throw new DshLiveRunnerError('invalid_arguments');
    }
  }
  if (!args.connectionFile) throw new DshLiveRunnerError('missing_connection_file');
  if (!Number.isSafeInteger(args.turnTimeoutMs) || args.turnTimeoutMs < 1 || args.turnTimeoutMs > MAX_TIMEOUT_MS) {
    throw new DshLiveRunnerError('invalid_timeout');
  }
  return args;
}

/** Entry used by the source script and the standalone binary subcommand. */
export async function runDshLiveRunnerMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const output = new RunnerControlWriter();
  const args = parseArgs(argv), connection = readDshLiveConnection(args.connectionFile);
  const client = await DshLiveClient.connect(connection);
  let stopping = false;
  const runner = new DshLiveRunner(client, {
    output, cwd: args.cwd ?? connection.cwd, turnTimeoutMs: args.turnTimeoutMs,
    failed: error => { output.error(`${error.message}\n`); shutdown(1); },
  });
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    runner.close();
    process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exitCode = code;
  };
  const cancel = () => { void runner.cancel().catch(error => output.error(`${safeFailure(error, 'cancel_failed').message}\n`)); };
  process.once('SIGTERM', () => shutdown(0));
  process.on('SIGINT', cancel);
  try { await runner.start(); }
  catch (error) { if (stopping) return; throw error; }
  if (stopping) return;
  const queue: DshLiveInput[] = [];
  let draining = false, buffer = '';
  const ready = () => { if (!stopping) output.display('› '); };
  const drain = async () => {
    if (draining || stopping) return;
    draining = true;
    try {
      while (queue.length && !stopping) { await runner.submit(queue.shift()!); ready(); }
    } catch (error) {
      if (!stopping) { output.error(`${safeFailure(error, 'submission_failed').message}\n`); shutdown(1); }
    } finally { draining = false; }
  };
  const line = (input: string) => {
    if (!input.trim()) return;
    if (input.trim() === '::cancel') { cancel(); return; }
    if (!input.startsWith(INPUT_PREFIX)) { output.line('[dsh] ignoring non-frame input'); return; }
    try {
      const value: unknown = JSON.parse(Buffer.from(input.slice(INPUT_PREFIX.length), 'base64').toString('utf8'));
      if (!record(value) || value.type !== 'message' || typeof value.content !== 'string' || !value.content.trim()
        || (value.replyTurnId !== undefined && (typeof value.replyTurnId !== 'string' || !value.replyTurnId))) {
        throw new DshLiveRunnerError('invalid_input');
      }
      queue.push({ content: value.content, ...(typeof value.replyTurnId === 'string' ? { replyTurnId: value.replyTurnId } : {}) });
      void drain();
    } catch { output.line('[dsh] invalid input frame'); }
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (data: Buffer) => {
    for (const character of data.toString('utf8')) {
      if (character === '\x03') cancel();
      else if (character === '\r' || character === '\n') { line(buffer); buffer = ''; }
      else {
        buffer += character;
        if (buffer.length > MAX_INPUT_BYTES) { output.error('dsh input frame exceeded limit.\n'); shutdown(1); break; }
      }
    }
  });
  process.stdin.once('end', () => shutdown(0));
  process.stdin.resume();
  ready();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDshLiveRunnerMain().catch(error => {
    new RunnerControlWriter().error(`${safeFailure(error, 'startup_failed').message}\n`);
    process.exitCode = 1;
  });
}
