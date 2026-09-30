import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

// Execute the production catch branch. Loading the full worker would start
// IPC and CLI processes; this branch only needs the queue and failure state.
const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const start = source.indexOf("log('Held definitely-unwritten input until ZMX recovery restart');");
const open = source.indexOf('} else {', start) + '} else {'.length;
const close = source.indexOf('\n        }\n        if (dispatchStillPending', open);
if (start < 0 || open < '} else {'.length || close < open) throw new Error('worker catch branch not found');
const catchBranch = new Function('lastInitConfig', 'normalWritePrepared', 'item',
  'requeueUnsubmittedQueuedActivation', 'recoveryFailureReason', 'inflightInputs', source.slice(open, close));

function run(cliId: string, prepared: boolean, token: string | undefined, recoveryFailure = false) {
  const queued: unknown[] = [];
  const retired: unknown[] = [];
  const item = {queuedActivationToken: token};
  catchBranch({cliId}, prepared, item,
    (value: typeof item) => {if (value.queuedActivationToken) queued.push(value);},
    recoveryFailure, {retire: (value: unknown) => retired.push(value)});
  return {queued, retired};
}

describe('Kimi ambiguous opening write', () => {
  it('does not replay an opening after the write was prepared', () => {
    expect(run('kimi', true, 'opening').queued).toEqual([]);
  });
  it('retains the known-unwritten opening behavior', () => {
    expect(run('kimi', false, 'opening').queued).toHaveLength(1);
  });
  it('keeps ordinary input and other CLI opening behavior', () => {
    expect(run('kimi', true, undefined).queued).toEqual([]);
    expect(run('claude-code', true, 'opening').queued).toHaveLength(1);
  });
  it('preserves the recovery retirement even when replay is suppressed', () => {
    const result = run('kimi', true, 'opening', true);
    expect(result.queued).toEqual([]);
    expect(result.retired).toHaveLength(1);
  });
});
