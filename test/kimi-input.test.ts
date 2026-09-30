import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createKimiAdapter} from '../src/adapters/cli/kimi.js';
import type {PtyHandle} from '../src/adapters/cli/types.js';

describe('Kimi native input submission', () => {
  beforeEach(() => {vi.useFakeTimers();});
  afterEach(() => {vi.useRealTimers();});
  const content = '[context]\nSender: QA\n\nReply only INPUT_QA. 不要使用工具。';
  const frame = `\x1b[200~${content}\x1b[201~\r`;

  it.each([undefined, true])('writes a complete paste and CR atomically when write returns %s', async accepted => {
    const adapter = createKimiAdapter('/not-invoked/kimi');
    const pty: PtyHandle = {write: vi.fn(() => accepted), pasteText: vi.fn(), sendSpecialKeys: vi.fn()};
    const pending = adapter.writeInput(pty, content);
    await vi.runAllTimersAsync();
    expect(await pending).toBeUndefined(); // Issued, without inventing native submit evidence.
    expect(pty.write).toHaveBeenCalledTimes(2);
    expect(pty.write).toHaveBeenNthCalledWith(1, '\r');
    expect(pty.write).toHaveBeenNthCalledWith(2, frame);
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('sends the trust prompt Enter only before the first input on a backend', async () => {
    const adapter = createKimiAdapter('/not-invoked/kimi');
    const pty: PtyHandle = {write: vi.fn(() => true), pasteText: vi.fn(), sendSpecialKeys: vi.fn()};
    const first = adapter.writeInput(pty, content);
    await vi.runAllTimersAsync();
    await first;
    await adapter.writeInput(pty, content);
    expect(vi.mocked(pty.write).mock.calls.map(([text]) => text)).toEqual(['\r', frame, frame]);
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('keeps the same complete frame for a backend exposing only raw write', async () => {
    const pty: PtyHandle = {write: vi.fn()};
    const pending = createKimiAdapter('/not-invoked/kimi').writeInput(pty, content);
    await vi.runAllTimersAsync();
    await pending;
    expect(pty.write).toHaveBeenCalledTimes(2);
    expect(pty.write).toHaveBeenNthCalledWith(1, '\r');
    expect(pty.write).toHaveBeenNthCalledWith(2, frame);
  });

  it('stops before content when the initial Enter is unconfirmed even if a later write would succeed', async () => {
    const pty: PtyHandle = {write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      pasteText: vi.fn(), sendSpecialKeys: vi.fn()};
    const outcome = Promise.allSettled([createKimiAdapter('/not-invoked/kimi').writeInput(pty, content)]);
    await vi.runAllTimersAsync();
    const [result] = await outcome;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason.message).toContain('delivery is ambiguous');
    expect(pty.write).toHaveBeenCalledExactlyOnceWith('\r');
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('propagates an initial Enter exception without writing content or replacement input', async () => {
    const error = new Error('QA initial backend disconnected');
    const pty: PtyHandle = {write: vi.fn().mockImplementationOnce(() => {throw error;}).mockReturnValue(true),
      pasteText: vi.fn(), sendSpecialKeys: vi.fn()};
    const outcome = Promise.allSettled([createKimiAdapter('/not-invoked/kimi').writeInput(pty, content)]);
    await vi.runAllTimersAsync();
    const [result] = await outcome;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe(error);
    expect(pty.write).toHaveBeenCalledExactlyOnceWith('\r');
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('surfaces an unconfirmed frame without resending text or Enter', async () => {
    const written: string[] = [];
    const pty: PtyHandle = {write: vi.fn(data => {written.push(data); return data === '\r';}),
      pasteText: vi.fn(), sendSpecialKeys: vi.fn()};
    const outcome = Promise.allSettled([createKimiAdapter('/not-invoked/kimi').writeInput(pty, content)]);
    await vi.runAllTimersAsync();
    const [result] = await outcome;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason.message).toContain('delivery is ambiguous');
    expect(written).toEqual(['\r', frame]);
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('propagates a frame exception instead of silently claiming success or resending', async () => {
    const error = new Error('QA backend disconnected');
    const pty: PtyHandle = {write: vi.fn().mockReturnValueOnce(true).mockImplementation(() => {throw error;}),
      pasteText: vi.fn(), sendSpecialKeys: vi.fn()};
    const outcome = Promise.allSettled([createKimiAdapter('/not-invoked/kimi').writeInput(pty, content)]);
    await vi.runAllTimersAsync();
    const [result] = await outcome;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe(error);
    expect(pty.write).toHaveBeenCalledTimes(2);
    expect(pty.write).toHaveBeenNthCalledWith(1, '\r');
    expect(pty.write).toHaveBeenNthCalledWith(2, frame);
    expect(pty.pasteText).not.toHaveBeenCalled();
    expect(pty.sendSpecialKeys).not.toHaveBeenCalled();
  });
});
