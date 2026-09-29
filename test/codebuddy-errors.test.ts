import {afterEach, expect, it} from 'vitest';
import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {drainCodeBuddyTranscript} from '../src/services/codebuddy-transcript.js';
import {CodexBridgeQueue} from '../src/services/codex-bridge-queue.js';
import {shouldSuppressStructuredFallback, structuredFallbackKind} from '../src/services/bridge-fallback-gate.js';

const sid = '00000000-0000-4000-8000-000000000000';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const user = {id: 'input', sessionId: sid, timestamp: 1000, type: 'message', role: 'user', content: [{type: 'input_text', text: 'test request'}]};
// Native CLI 2.159.0 failure shape; IDs and content are synthetic.
const failure = {
  id: 'error', sessionId: sid, timestamp: 2000, type: 'message', role: 'assistant', status: 'incomplete',
  content: [{type: 'output_text', text: '429 Credits exhausted.'}],
  providerData: {skipRun: true, conversationRequestId: 'request', error: {code: 14018, status: 429, message: '429 Credits exhausted.', isRetryable: false}},
};
function fixture(rows: unknown[] = [user, failure]) {
  const dir = mkdtempSync(join(tmpdir(), 'codebuddy-errors-'));
  dirs.push(dir);
  const file = join(dir, `${sid}.jsonl`), stops = join(dir, `${sid}.allinone-stops`);
  mkdirSync(stops);
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const stop = (id = 'request', event = 'Stop', sessionId = sid) => writeFileSync(join(stops, `${id}.json`), JSON.stringify({sessionId, generationId: id, event}));
  return {file, stop};
}

it('holds a native quota failure until its request Stop arrives and emits it once as failed', () => {
  const {file, stop} = fixture();
  const pending = drainCodeBuddyTranscript(file, 0);
  expect(pending.events.map(event => event.kind)).toEqual(['user']);
  stop(); // CodeBuddy emits Stop, even for this provider failure.
  const final = drainCodeBuddyTranscript(file, pending.newOffset);
  expect(final.events).toEqual([expect.objectContaining({uuid: 'error', text: '429 Credits exhausted.', terminalStatus: 'failed', terminalErrorCode: 'codebuddy_error'})]);
  expect(drainCodeBuddyTranscript(file, final.newOffset).events).toEqual([]);
});

it('requires matching native session and generation proof', () => {
  const {file, stop} = fixture();
  stop('request', 'Stop', '00000000-0000-4000-8000-000000000001');
  expect(drainCodeBuddyTranscript(file, 0).events.map(event => event.kind)).toEqual(['user']);
  stop('request', 'Unknown');
  expect(drainCodeBuddyTranscript(file, 0).events.map(event => event.kind)).toEqual(['user']);
  stop('error', 'StopFailure');
  expect(drainCodeBuddyTranscript(file, 0).events.at(-1)?.terminalStatus).toBe('failed');
});

it('uses the native error message when no output text exists', () => {
  const {file, stop} = fixture([user, {...failure, content: []}]);
  stop();
  expect(drainCodeBuddyTranscript(file, 0).events.at(-1)?.text).toBe('429 Credits exhausted.');
});

it('does not treat unfinished text or a user-typed error as a terminal failure', () => {
  const {file, stop} = fixture([user, {...failure, providerData: {conversationRequestId: 'request'}}]);
  stop();
  expect(drainCodeBuddyTranscript(file, 0).events.map(event => event.kind)).toEqual(['user']);
});

it('drops an earlier error when native recovery produces a later answer', () => {
  const {file, stop} = fixture();
  const pending = drainCodeBuddyTranscript(file, 0);
  appendFileSync(file, JSON.stringify({...failure, id: 'answer', status: 'completed', content: [{type: 'output_text', text: 'recovered'}], providerData: {conversationRequestId: 'request'}}) + '\n');
  stop();
  stop('answer');
  expect(drainCodeBuddyTranscript(file, pending.newOffset).events.map(event => [event.text, event.terminalStatus])).toEqual([['recovered', 'completed']]);
});

it('keeps request-wide Stop restricted to explicit errors, never to normal assistant text', () => {
  const {file, stop} = fixture([user, {...failure, status: 'completed', providerData: {conversationRequestId: 'request'}}]);
  stop();
  expect(drainCodeBuddyTranscript(file, 0).events.map(event => event.kind)).toEqual(['user']);
});

it('waits for complete error records and preserves consecutive turn boundaries', () => {
  const {file, stop} = fixture([user]);
  const encoded = JSON.stringify(failure);
  appendFileSync(file, encoded.slice(0, 50));
  const pending = drainCodeBuddyTranscript(file, 0);
  expect(pending.events.map(event => event.kind)).toEqual(['user']);
  appendFileSync(file, encoded.slice(50) + '\n' + JSON.stringify({...user, id: 'next-input'}) + '\n');
  stop();
  const next = drainCodeBuddyTranscript(file, pending.newOffset);
  expect(next.events.map(event => event.kind)).toEqual(['assistant_final', 'user']);
  expect(drainCodeBuddyTranscript(file, next.newOffset).events).toEqual([]);
});

it.each([false, true])('closes the existing bridge turn with a failed result (Lark origin: %s)', larkOrigin => {
  const {file, stop} = fixture();
  stop();
  const queue = new CodexBridgeQueue();
  queue.setLocalTurns(true, 900);
  if (larkOrigin) queue.mark('lark-message', 'test request', 900);
  queue.ingest(drainCodeBuddyTranscript(file, 0).events);
  const turns = queue.drainEmittable();
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({finalText: '429 Credits exhausted.', terminalStatus: 'failed', terminalErrorCode: 'codebuddy_error', terminalErrorSummary: '429 Credits exhausted.'});
  const adoptMode = turns[0].isLocal === true;
  const kind = structuredFallbackKind(turns[0], undefined, [], adoptMode, false);
  expect(kind).toBe(larkOrigin ? 'failed' : 'final');
  expect(shouldSuppressStructuredFallback(kind, turns[0], undefined, [], adoptMode)).toBe(false);
  expect(queue.drainEmittable()).toEqual([]);
});
