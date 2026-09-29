import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WebSocket} from 'ws';

vi.mock('node:child_process', () => ({spawn: vi.fn()}));
import {spawn} from 'node:child_process';
import {connectHerdrWebStream, HERDR_WEB_CONTROL_FAILED} from '../src/utils/herdr-web-stream.js';
import {terminalWriteFrame} from '../src/core/terminal-write-frame.js';

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, reason);
  });
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

class Stream extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null;
  kill = vi.fn(() => { this.exit(0); return true; });
  writes: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', data => this.writes.push(data.toString()));
  }
  exit(code: number) { this.exitCode = code; this.emit('exit', code); }
  frame(text = 'native screen') {
    this.stdout.write(JSON.stringify({type: 'terminal.frame', width: 73, height: 31,
      bytes: Buffer.from(text).toString('base64')}) + '\n');
  }
  messages() { return this.writes.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
}

let sockets: Socket[], streams: Stream[];
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); sockets = []; streams = [];
  vi.mocked(spawn).mockImplementation((() => {
    const stream = new Stream(); streams.push(stream); return stream;
  }) as any);
});
afterEach(() => {
  for (const socket of sockets) socket.close();
  for (const stream of streams) stream.exit(0);
  vi.clearAllTimers(); vi.useRealTimers();
});
function connect(write = true, expiresAt?: number) {
  const socket = new Socket(); sockets.push(socket);
  const verify = vi.fn(), audit = vi.fn();
  connectHerdrWebStream(socket as unknown as WebSocket,
    {session: 'original-session', terminalId: 'original-terminal', verify}, {write, expiresAt, audit});
  return {socket, verify, audit};
}
const resize = {type: 'resize', cols: 61, rows: 47};

describe('shared native HERDR browser stream', () => {
  it('uses the first viewport and reports write authority only after this controller is accepted', () => {
    const {socket} = connect();
    expect(spawn).not.toHaveBeenCalled();
    socket.message(resize);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['--session', 'original-session', 'terminal',
      'session', 'control', 'original-terminal', '--cols', '61', '--rows', '47']);
    expect(socket.send).not.toHaveBeenCalled();
    streams[0]!.frame('permission picker and existing draft');
    expect(socket.send.mock.calls.map(call => call[0])).toEqual([
      terminalWriteFrame(true), 'permission picker and existing draft',
    ]);
  });

  it('forwards explicit input and later resizes through the same controller, then releases only that stream', async () => {
    const {socket, audit} = connect(); socket.message(resize); streams[0]!.frame();
    socket.message({type: 'input', data: '\x1b[B\r'});
    socket.message({...resize, rows: 30}); socket.close();
    await Promise.resolve();
    expect(streams[0]!.messages()).toEqual([
      {type: 'terminal.input', text: '\x1b[B\r'}, {type: 'terminal.resize', cols: 61, rows: 30},
      {type: 'terminal.release'},
    ]);
    expect(audit).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce(); expect(streams[0]!.kill).not.toHaveBeenCalled();
  });

  it('uses observe for read-only access and ignores input and subsequent resize attempts', () => {
    const {socket, audit} = connect(false); socket.message(resize); streams[0]!.frame();
    socket.message({type: 'input', data: 'cannot write'}); socket.message({...resize, rows: 30});
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('observe');
    expect(socket.send.mock.calls.map(call => call[0])).toEqual([
      terminalWriteFrame(false), '\x1b]1989;73;31\x07native screen',
    ]);
    expect(streams[0]!.messages()).toEqual([]); expect(audit).not.toHaveBeenCalled();
  });

  it('does not share another browser controller and reports native contention without granting write', () => {
    const first = connect(), second = connect();
    first.socket.message(resize); streams[0]!.frame(); second.socket.message(resize);
    streams[1]!.stdout.write(JSON.stringify({type: 'terminal.closed', reason:
      'terminal private-id already has an attached client; retry with --takeover'}) + '\n');
    second.socket.message({type: 'input', data: 'must not piggyback'});
    expect(second.socket.send).not.toHaveBeenCalled();
    expect(second.socket.close).toHaveBeenCalledWith(HERDR_WEB_CONTROL_FAILED, '原终端正在其他入口操作；请先断开该入口。');
    expect(first.socket.close).not.toHaveBeenCalled(); expect(streams[0]!.messages()).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(spawn).mock.calls) expect(call[1]).not.toContain('--takeover');
  });

  it('checks the original identity before acquisition and again before accepting the first frame', () => {
    const before = connect(); before.verify.mockImplementation(() => { throw new Error('identity changed'); });
    before.socket.message(resize); expect(spawn).not.toHaveBeenCalled();
    const after = connect(); after.socket.message(resize);
    after.verify.mockImplementation(() => { throw new Error('identity changed'); }); streams[0]!.frame();
    expect(after.socket.send).not.toHaveBeenCalled();
    expect(before.socket.close).toHaveBeenCalled(); expect(after.socket.close).toHaveBeenCalled();
  });

  it('rejects a replaced Agent before sending input or audit, and never writes into its shell', () => {
    const {socket, verify, audit} = connect(); socket.message(resize); streams[0]!.frame();
    verify.mockImplementation(() => { throw new Error('source gone'); });
    socket.message({type: 'input', data: 'dangerous after replacement'});
    expect(streams[0]!.messages()).toEqual([{type: 'terminal.release'}]);
    expect(audit).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(HERDR_WEB_CONTROL_FAILED, expect.stringContaining('身份'));
  });

  it('rechecks idle connections and expiry without waiting for another input', () => {
    const source = connect(); source.socket.message(resize); streams[0]!.frame();
    source.verify.mockImplementation(() => { throw new Error('source gone'); });
    vi.advanceTimersByTime(1000); expect(source.socket.close).toHaveBeenCalled();
    const expires = connect(true, Date.now() + 200); expires.socket.message(resize); streams[1]!.frame();
    vi.advanceTimersByTime(200);
    expect(expires.socket.close).toHaveBeenCalledWith(HERDR_WEB_CONTROL_FAILED, expect.stringContaining('过期'));
  });

  it('refuses premature input instead of buffering it for unexpected replay', () => {
    const {socket, audit} = connect(); socket.message(resize);
    socket.message({type: 'input', data: 'early'}); streams[0]!.frame();
    expect(socket.send).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
    expect(streams[0]!.messages()).toEqual([{type: 'terminal.release'}]);
  });

  it('cancels early disconnects and bounds waiting for native acceptance', () => {
    connect().socket.close(); vi.advanceTimersByTime(300); expect(spawn).not.toHaveBeenCalled();
    const stalled = connect(); vi.advanceTimersByTime(300); expect(spawn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(stalled.socket.close).toHaveBeenCalledWith(HERDR_WEB_CONTROL_FAILED, expect.stringContaining('超时'));
    expect(stalled.socket.send).not.toHaveBeenCalled();
  });

  it('surfaces spawn and resize transport failures with safe bounded messages', () => {
    const failed = connect(); failed.socket.message(resize); streams[0]!.emit('error', new Error('private stderr'));
    const resized = connect(); resized.socket.message(resize); streams[1]!.frame();
    vi.spyOn(streams[1]!.stdin, 'write').mockImplementation(() => { throw new Error('private stderr'); });
    expect(() => resized.socket.message({...resize, rows: 20})).not.toThrow();
    for (const socket of [failed.socket, resized.socket]) {
      expect(socket.close).toHaveBeenCalledWith(HERDR_WEB_CONTROL_FAILED, expect.any(String));
      const reason = socket.close.mock.calls[0]![1]!;
      expect(reason).not.toContain('private stderr'); expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
    }
  });

  it('does not grant authority to a slow client or forward oversized input', () => {
    const slow = connect(); slow.socket.message(resize); slow.socket.bufferedAmount = 5 * 1024 * 1024;
    streams[0]!.frame(); expect(slow.socket.send).not.toHaveBeenCalled();
    const large = connect(); large.socket.message(resize); streams[1]!.frame();
    large.socket.message({type: 'input', data: 'x'.repeat(65537)});
    expect(large.audit).not.toHaveBeenCalled();
    expect(streams[1]!.messages()).toEqual([{type: 'terminal.release'}]);
  });
});
