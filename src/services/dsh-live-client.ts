import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type WS from 'ws';

// The literal relative CJS entry bypasses Bun's browser ws alias and is bundled
// by --compile. Source and dist services are both two levels below node_modules.
// Loading is lazy so importing the legacy SDK path does not need this transport.
let socketConstructor: typeof WS | undefined;
function headerWebSocket(): typeof WS {
  if (!socketConstructor) {
    try {
      // Bun's bundler recognizes the global literal require; Node ESM uses the
      // equivalent module-relative loader. Both load the same CJS implementation.
      socketConstructor = (typeof require === 'function'
        ? require('../../node_modules/ws/index.js')
        : createRequire(import.meta.url)('../../node_modules/ws/index.js')) as typeof WS;
    } catch { throw new DshLiveClientError('websocket_unavailable'); }
  }
  return socketConstructor;
}

/** Official @deepseek-ai/dsh 0.2.0-rc.2 Web HostRPC wire. No ACP owner is created. */
export interface DshSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: unknown;
  readonly surfaceOp?: unknown;
}

export interface DshEventFrame {
  readonly type: 'event';
  readonly event: DshSessionEvent;
}

export interface DshFollowSnapshot {
  readonly type: 'snapshot';
  readonly header: {
    readonly id: string;
    readonly version: number;
    readonly createdAt: number;
    readonly isSeeded: boolean;
    readonly cwd?: string;
    readonly [key: string]: unknown;
  };
  readonly cursor: number;
  readonly records: readonly DshEventFrame[];
  readonly hasMore: boolean;
  readonly projections: { readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> };
  readonly assistantStream?: {
    readonly revision: number;
    readonly activeAttempt?: {
      readonly attemptId: string;
      readonly startedAfterSeq: number;
      readonly turn: number;
      readonly step: number;
      readonly nextIndex: number;
      readonly stream: readonly unknown[];
    };
  };
}

export type DshAssistantStreamFrame = {
  readonly type: 'start';
  readonly attemptId: string;
  readonly revision: number;
  readonly startedAfterSeq: number;
  readonly turn: number;
  readonly step: number;
} | {
  readonly type: 'chunk';
  readonly attemptId: string;
  readonly revision: number;
  readonly index: number;
  readonly time: number;
  readonly chunk: unknown;
} | {
  readonly type: 'end';
  readonly attemptId: string;
  readonly revision: number;
  readonly index: number;
  readonly outcome: {
    readonly kind: 'committed';
    readonly eventType: 'assistant/message' | 'assistant/attempt';
    readonly seq: number;
  } | { readonly kind: 'abandoned' };
};

export type DshFollowFrame = DshFollowSnapshot | DshEventFrame | {
  readonly type: 'assistant-stream';
  readonly frame: DshAssistantStreamFrame;
};

export interface DshFollowOptions {
  readonly assistantStream?: true;
  readonly maxMessages?: number;
  readonly turnWindow?: { readonly minMessages: number; readonly minTurns: number };
}

export interface DshPromptRequest {
  /** Correlation persisted on the exact user message; not the transport rpcId. */
  readonly requestId: string;
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly mode?: 'queue' | 'steer';
  readonly clientTimeZone?: string;
}

export interface DshLiveClientOptions {
  /** Private startup URL from the bound native owner. Never put this in logs. */
  readonly webUrl: string;
  readonly sessionId: string;
  readonly timeoutMs?: number;
}

/** Remote details/messages can contain credentials or prompts; expose codes only. */
export class DshLiveClientError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super('dsh Web client failed (' + code + ').');
    this.name = 'DshLiveClientError';
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const failure = (code: string, status?: number) => new DshLiveClientError(code, status);
const remoteCodes = new Set([
  'gateway/bad-request', 'gateway/cancelled', 'gateway/internal', 'gateway/result-invalid',
  'gateway/input-invalid', 'gateway/context-unavailable', 'gateway/context-not-found',
  'gateway/method-unavailable', 'gateway/signature-invalid', 'gateway/arguments-invalid',
  'session/not-found', 'session/writer-held', 'session/conflict', 'session/agent-busy',
  'session/provider-credentials-unavailable', 'session/provider-models-unavailable', 'session/model-unavailable',
  'session/projections-unavailable', 'session/invalid-time-zone', 'session/workspace-attach-failed',
  'session/attachment-invalid', 'session/queue-item-not-found', 'session/steer-unavailable',
  'session/title-invalid', 'session/fork-unavailable', 'agent-preset/conflict',
  'workspace/not-found', 'subagent/not-found', 'subagent/catalog-diagnostic',
]);
const safeRemoteCode = (value: unknown): string =>
  typeof value === 'string' && remoteCodes.has(value) ? value : 'remote_error';
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw failure('cancelled'); }
  const abort = deferred<T>();
  const onAbort = () => abort.reject(failure('cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  try { return await Promise.race([promise, abort.promise]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function startupUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw failure('invalid_url'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || !url.port || Number(url.port) < 1 || url.username || url.password || url.pathname !== '/' || url.hash
    || url.searchParams.size !== 1 || url.searchParams.getAll('token').length !== 1
    || !url.searchParams.get('token')) throw failure('invalid_url');
  return url;
}

function eventFrame(value: unknown): value is DshEventFrame {
  return record(value) && value.type === 'event' && record(value.event)
    && id(value.event.type) && integer(value.event.seq) && value.event.seq >= 0
    && typeof value.event.time === 'number' && Number.isFinite(value.event.time)
    && Object.hasOwn(value.event, 'data');
}

function followFrame(value: unknown, sessionId: string): DshFollowFrame {
  if (!record(value)) throw failure('invalid_follow_frame');
  if (value.type === 'snapshot') {
    if (record(value.header) && value.header.id !== sessionId) throw failure('session_mismatch');
    if (!record(value.header) || value.header.id !== sessionId
      || !integer(value.header.version) || typeof value.header.createdAt !== 'number'
      || typeof value.header.isSeeded !== 'boolean' || !integer(value.cursor)
      || !Array.isArray(value.records) || !value.records.every(eventFrame)
      || typeof value.hasMore !== 'boolean' || !record(value.projections)
      || !integer(value.projections.asOfSeq) || !record(value.projections.values)
      || (value.assistantStream !== undefined
        && (!record(value.assistantStream) || !integer(value.assistantStream.revision)))) {
      throw failure('invalid_follow_snapshot');
    }
    return value as unknown as DshFollowSnapshot;
  }
  if (eventFrame(value)) return value;
  if (value.type === 'assistant-stream' && assistantFrame(value.frame)) {
    return value as unknown as DshFollowFrame;
  }
  throw failure('invalid_follow_frame');
}
function assistantFrame(frame: unknown): frame is DshAssistantStreamFrame {
  if (!record(frame) || !id(frame.attemptId) || !integer(frame.revision) || frame.revision < 1) return false;
  if (frame.type === 'start') return integer(frame.startedAfterSeq) && integer(frame.turn) && integer(frame.step);
  if (frame.type === 'chunk') return integer(frame.index) && frame.index >= 0
    && typeof frame.time === 'number' && Number.isFinite(frame.time) && Object.hasOwn(frame, 'chunk');
  return frame.type === 'end' && integer(frame.index) && frame.index >= 0 && record(frame.outcome)
    && (frame.outcome.kind === 'abandoned' || (frame.outcome.kind === 'committed'
      && ['assistant/message', 'assistant/attempt'].includes(String(frame.outcome.eventType))
      && integer(frame.outcome.seq) && frame.outcome.seq >= 0));
}

/** One bounded logical subscription. End/error mean observation ended, not task completion. */
export class DshFollowSubscription implements AsyncIterable<DshFollowFrame> {
  #queue: DshFollowFrame[] = [];
  #waiting?: { resolve(value: IteratorResult<DshFollowFrame>): void; reject(error: Error): void };
  #ended = false;
  #error?: Error;
  #opening = deferred<void>();
  #opened = false;
  #cursor = -1;
  #revision?: number;
  #iterated = false;
  #cleanup?: () => void;

  constructor(readonly streamId: string, private stop: () => void) {
    // A server error can arrive before follow() reaches its await.
    void this.#opening.promise.catch(() => {});
  }

  /** Transport-internal hooks; consumers only iterate or close. */
  opening(): Promise<void> { return this.#opening.promise; }
  cleanup(callback: () => void): void { this.#cleanup = callback; }
  push(frame: DshFollowFrame): void {
    if (this.#ended) return;
    if (!this.#opened) {
      if (frame.type !== 'snapshot') { this.close(failure('missing_snapshot')); return; }
      this.#opened = true;
      this.#cursor = frame.cursor;
      this.#revision = frame.assistantStream?.revision;
      this.#opening.resolve(undefined);
    } else if (frame.type === 'snapshot') { this.close(failure('duplicate_snapshot')); return; }
    else if (frame.type === 'event') {
      if (frame.event.seq !== this.#cursor + 1) { this.close(failure('durable_sequence_gap')); return; }
      this.#cursor = frame.event.seq;
    } else {
      if (this.#revision === undefined || frame.frame.revision !== this.#revision + 1) {
        this.close(failure('assistant_revision_gap')); return;
      }
      this.#revision = frame.frame.revision;
    }
    if (this.#waiting) {
      const waiting = this.#waiting; this.#waiting = undefined;
      waiting.resolve({ done: false, value: frame });
    } else if (this.#queue.length >= 512) this.close(failure('stream_overflow'));
    else this.#queue.push(frame);
  }

  finish(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    this.#cleanup?.();
    if (!this.#opened) this.#opening.reject(error ?? failure('stream_ended_before_snapshot'));
    const waiting = this.#waiting; this.#waiting = undefined;
    if (waiting) error ? waiting.reject(error) : waiting.resolve({ done: true, value: undefined });
  }

  /** Cancels this observation only; it never invokes session/cancel. */
  close(error?: Error): void {
    if (this.#ended) return;
    this.stop();
    this.#queue.length = 0;
    this.finish(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<DshFollowFrame> {
    if (this.#iterated) throw failure('subscription_already_consumed');
    this.#iterated = true;
    return {
      next: async () => {
        if (this.#queue.length) return { done: false, value: this.#queue.shift()! };
        if (this.#error) throw this.#error;
        if (this.#ended) return { done: true, value: undefined };
        if (this.#waiting) throw failure('concurrent_stream_read');
        return new Promise<IteratorResult<DshFollowFrame>>((resolve, reject) => {
          this.#waiting = { resolve, reject };
        });
      },
      return: async () => { this.close(); return { done: true, value: undefined }; },
    };
  }
}

/** Fixed-session Web client; no session/new, ACP, approval answerer, or automatic retry. */
export class DshLiveClient {
  #origin: string;
  #cookie: string;
  #sessionId: string;
  #timeoutMs: number;
  #socket?: WS;
  #connecting?: Promise<WS>;
  #streams = new Map<string, DshFollowSubscription>();
  #closed = false;
  #lifetime = new AbortController();

  private constructor(origin: string, cookie: string, sessionId: string, timeoutMs: number) {
    this.#origin = origin;
    this.#cookie = cookie;
    this.#sessionId = sessionId;
    this.#timeoutMs = timeoutMs;
  }
  get sessionId(): string { return this.#sessionId; }

  static async connect(options: DshLiveClientOptions, signal?: AbortSignal): Promise<DshLiveClient> {
    const url = startupUrl(options.webUrl), timeoutMs = options.timeoutMs ?? 10_000;
    if (!id(options.sessionId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw failure('invalid_options');
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch { throw failure(signal?.aborted ? 'cancelled' : 'authentication_failed'); }
    if (response.status !== 303 || response.headers.get('location') !== './') {
      throw failure('authentication_failed', response.status);
    }
    const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0])
      .filter(cookie => /^[^=;\s]+=[^;\r\n]+$/.test(cookie));
    if (!cookies.length) throw failure('authentication_failed');
    if (signal?.aborted) throw failure('cancelled');
    return new DshLiveClient(url.origin, cookies.join('; '), options.sessionId, timeoutMs);
  }

  async #rpc(endpoint: string, request: unknown, signal?: AbortSignal): Promise<{ accepted: true }> {
    if (this.#closed) throw failure('client_closed');
    const rpcId = randomUUID();
    let response: Response;
    try {
      response = await fetch(this.#origin + '/api/' + endpoint, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', cookie: this.#cookie, origin: this.#origin },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: { request } } }),
        signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(this.#timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch { throw failure(this.#closed ? 'client_closed' : signal?.aborted ? 'cancelled' : 'request_failed'); }
    if (response.status !== 200) throw failure('request_failed', response.status);
    let envelope: unknown;
    try { envelope = await response.json(); } catch { throw failure('invalid_response'); }
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result)) throw failure('invalid_response');
    if (envelope.result.ok === false) {
      throw failure(record(envelope.result.error) ? safeRemoteCode(envelope.result.error.code) : 'remote_error');
    }
    if (envelope.result.ok !== true || !record(envelope.result.value) || envelope.result.value.accepted !== true) {
      throw failure('invalid_response');
    }
    return { accepted: true };
  }

  /** Acceptance only. Completion belongs to the correlated durable Session events. */
  async prompt(request: DshPromptRequest, signal?: AbortSignal): Promise<{ accepted: true }> {
    if (!id(request.requestId) || !Array.isArray(request.content) || !request.content.length
      || !request.content.every(part => record(part) && part.type === 'text' && typeof part.text === 'string')
      || !request.content.some(part => part.text.trim()) || !['queue', 'steer'].includes(request.mode ?? 'queue')) {
      throw failure('invalid_prompt');
    }
    return this.#rpc('session/prompt', { ...request, sessionId: this.sessionId, mode: request.mode ?? 'queue' }, signal);
  }

  /** Official cancellation keeps pending inbox work; closing a client does not call this. */
  async cancel(signal?: AbortSignal): Promise<{ accepted: true }> {
    return this.#rpc('session/cancel', { sessionId: this.sessionId }, signal);
  }

  async #connectSocket(): Promise<WS> {
    if (this.#closed) throw failure('client_closed');
    if (this.#socket?.readyState === 1) return this.#socket;
    if (this.#connecting) return this.#connecting;
    const WebSocket = headerWebSocket();
    this.#connecting = new Promise<WS>((resolve, reject) => {
      const socket = new WebSocket(this.#origin.replace(/^http:/, 'ws:') + '/api/remote.mux', {
        headers: { cookie: this.#cookie, origin: this.#origin },
        followRedirects: false, handshakeTimeout: this.#timeoutMs, maxPayload: 16 * 1024 * 1024,
      });
      this.#socket = socket;
      socket.once('open', () => { if (this.#closed) socket.close(); else resolve(socket); });
      socket.on('error', () => { reject(failure('connection_failed')); this.#failStreams(failure('connection_failed')); });
      socket.on('close', () => {
        reject(failure(this.#closed ? 'client_closed' : 'connection_closed'));
        this.#failStreams(failure(this.#closed ? 'client_closed' : 'connection_closed'));
        if (this.#socket === socket) this.#socket = undefined;
      });
      socket.on('message', (data, binary) => {
        try {
          if (binary) throw failure('invalid_mux_frame');
          const frame: unknown = JSON.parse(data.toString());
          if (!record(frame) || !id(frame.streamId)
            || !['item', 'error', 'end'].includes(String(frame.type))) throw failure('invalid_mux_frame');
          const keys = Object.keys(frame).sort().join(',');
          const expected = frame.type === 'item' && Object.hasOwn(frame, 'value') ? 'streamId,type,value'
            : frame.type === 'error' ? 'error,streamId,type' : 'streamId,type';
          if (keys !== expected) throw failure('invalid_mux_frame');
          if (frame.type === 'error' && (!record(frame.error)
            || typeof frame.error.code !== 'string' || typeof frame.error.message !== 'string'
            || !record(frame.error.details))) throw failure('invalid_mux_frame');
          const stream = this.#streams.get(frame.streamId);
          if (!stream) return; // Late frames for a locally cancelled generation.
          if (frame.type === 'item') stream.push(followFrame(frame.value, this.sessionId));
          else if (frame.type === 'end') {
            this.#streams.delete(frame.streamId);
            stream.finish(failure('stream_ended'));
          }
          else {
            this.#streams.delete(frame.streamId);
            stream.finish(failure(record(frame.error) ? safeRemoteCode(frame.error.code) : 'remote_error'));
          }
        } catch (error) {
          this.#failStreams(error instanceof DshLiveClientError ? error : failure('invalid_mux_frame'));
          socket.close(1002, 'invalid dsh Remote stream frame');
        }
      });
    });
    try { return await this.#connecting; } finally { this.#connecting = undefined; }
  }

  #failStreams(error: Error): void {
    for (const stream of this.#streams.values()) stream.finish(error);
    this.#streams.clear();
  }

  /** Resolves only after the official opening snapshot is queued for this session. */
  async follow(options: DshFollowOptions = {}, signal?: AbortSignal): Promise<DshFollowSubscription> {
    if (this.#closed) throw failure('client_closed');
    if (signal?.aborted) throw failure('cancelled');
    if ((options.assistantStream !== undefined && options.assistantStream !== true)
      || (options.maxMessages !== undefined && (!integer(options.maxMessages) || options.maxMessages < 1))
      || (options.turnWindow !== undefined && (!integer(options.turnWindow.minMessages)
        || options.turnWindow.minMessages < 1 || !integer(options.turnWindow.minTurns)
        || options.turnWindow.minTurns < 1
        || (options.maxMessages !== undefined && options.turnWindow.minMessages > options.maxMessages)))) {
      throw failure('invalid_follow_options');
    }
    const socket = await withAbort(this.#connectSocket(),
      AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]));
    if (this.#closed || signal?.aborted) throw failure(this.#closed ? 'client_closed' : 'cancelled');
    const streamId = randomUUID();
    const stream = new DshFollowSubscription(streamId, () => {
      this.#streams.delete(streamId);
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', streamId }));
    });
    this.#streams.set(streamId, stream);
    const onAbort = () => stream.close(failure('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stream.close(failure('snapshot_timeout')), this.#timeoutMs);
    stream.cleanup(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
    socket.send(JSON.stringify({
      type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { ...options, address: { kind: 'session', sessionId: this.sessionId } } } },
    }));
    try { await stream.opening(); clearTimeout(timer); return stream; }
    catch (error) { stream.close(); throw error; }
  }

  /** Releases this client only. The native owner and other clients remain alive. */
  close(): void {
    if (this.#closed) return;
    for (const stream of this.#streams.values()) stream.close();
    this.#closed = true;
    this.#lifetime.abort();
    this.#socket?.close();
    this.#cookie = '';
  }
}
