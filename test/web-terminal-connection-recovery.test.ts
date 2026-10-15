import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeTerminalWriteFrame, terminalWriteFrame } from '../src/core/terminal-write-frame.js';

// Execute the emitted browser code, including template-literal unescaping,
// without importing worker.ts (which would start a real worker).
const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
const ast = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true);
const htmlFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getTerminalHtml');
if (!htmlFunction) throw new Error('getTerminalHtml not found');
const compiled = ts.transpileModule(htmlFunction.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const html: string = new Function('sessionId', 'cliName', 'TERMINAL_FAVICON_DATA_URI',
  'decodeTerminalWriteFrameSource', 'HERDR_WEB_CONTROL_FAILED', 'isTmuxMode', 'isPipeMode', 'process',
  compiled + '\nreturn getTerminalHtml(false);',
)('test-session', () => 'Terminal', '', decodeTerminalWriteFrame.toString(), 4409, false, false, { env: {} });

function between(start: string, end: string): string {
  const at = html.indexOf(start), until = html.indexOf(end, at);
  if (at < 0 || until < 0) throw new Error(`Browser fragment missing: ${start}`);
  return html.slice(at, until);
}
const statusCode = between("var ws_=null,el=document.getElementById('status');", 'function _sendInput');
const connectionCode = between('(function connect(){', '// ── Wheel / touch scroll handling');

function boot() {
  const sockets: Socket[] = [];
  class Socket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    send = vi.fn();
    // Simulate a route that never completes the close handshake either.
    close = vi.fn(() => { this.readyState = 2; });
    constructor(readonly url: string) { sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(data: string | ArrayBuffer) { this.onmessage?.({ data }); }
    remoteClose(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  const status = { textContent: '', className: '', title: '' };
  const write = vi.fn();
  const context = createContext({
    document: { getElementById: () => status },
    location: { pathname: '/s/test/', protocol: 'https:', host: 'terminal.example', search: '?access=read' },
    WebSocket: Socket, TextEncoder, TextDecoder,
    setTimeout, clearTimeout,
    _wbDecodeWriteFrame: decodeTerminalWriteFrame,
    term: { write }, sendResize: vi.fn(),
    _settleInitialBottom: vi.fn(),
  });
  runInContext('var _wbFirstFrame=true,wsHasWrite=null,_lastC=0,_lastR=0;'
    + 'function _wbSetWsWrite(value){wsHasWrite=value;}'
    + statusCode + connectionCode, context);
  return { sockets, status, context, write };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('web terminal connection recovery', () => {
  it('does not report success at OPEN and recovers when the first frame never arrives', () => {
    const { sockets, status, context, write } = boot();
    const first = sockets[0];
    first.open();
    const oldMessage = first.onmessage!, oldClose = first.onclose!;
    expect(status.textContent).toBe('已连接，等待终端确认…');
    expect(status.className).not.toBe('ok');
    vi.advanceTimersByTime(10_000);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(status.textContent).toContain('终端响应超时');
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].receive(terminalWriteFrame(false));
    sockets[1].receive('恢复\r\n');
    expect(status.className).toBe('ok');
    expect(status.textContent).toBe('connected · 已接收 8 B');
    expect(write).toHaveBeenCalledTimes(1);
    // Events already queued by the retired socket cannot reset the new socket,
    // reinterpret an old permission verdict, append data, or schedule retries.
    oldMessage({ data: terminalWriteFrame(true) });
    oldClose({ code: 1006, reason: '' });
    expect(context.ws_).toBe(sockets[1]);
    expect(context.wsHasWrite).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(2);
  });

  it('also retries a hung handshake without waiting for the browser close event', () => {
    const { sockets, status } = boot();
    vi.advanceTimersByTime(10_000);
    expect(status.textContent).toContain('连接超时');
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
  });

  it('allows a confirmed empty terminal to stay idle without reconnecting', () => {
    const { sockets, status, context } = boot();
    sockets[0].open();
    sockets[0].receive(terminalWriteFrame(false));
    expect(status.textContent).toBe('终端已确认，等待输出…');
    expect(status.className).not.toBe('ok');
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].close).not.toHaveBeenCalled();
    expect(context.wsHasWrite).toBe(false);
  });

  it('reports the first binary output synchronously and preserves permission isolation', () => {
    const { sockets, status, context, write } = boot();
    sockets[0].open();
    sockets[0].receive(terminalWriteFrame(false));
    sockets[0].receive(new TextEncoder().encode('data').buffer);
    expect(status.textContent).toBe('connected · 已接收 4 B');
    sockets[0].receive(terminalWriteFrame(true));
    expect(context.wsHasWrite).toBe(false);
    expect(write.mock.calls[1][0]).toBe(terminalWriteFrame(true));
  });

  it('resets the byte count and permission state when reconnecting', () => {
    const { sockets, status, context } = boot();
    sockets[0].open();
    sockets[0].receive(terminalWriteFrame(true));
    sockets[0].receive('old output');
    sockets[0].remoteClose();
    expect(context.wsHasWrite).toBeNull();
    vi.advanceTimersByTime(2_000);
    sockets[1].open();
    expect(status.textContent).toBe('已连接，等待终端确认…');
    sockets[1].receive(terminalWriteFrame(false));
    expect(status.textContent).toBe('终端已确认，等待输出…');
    expect(context._wbReceivedBytes).toBe(0);
  });

  it('preserves a native terminal refusal instead of retrying it', () => {
    const { sockets, status } = boot();
    sockets[0].open();
    sockets[0].remoteClose(4409, '原终端正在其他入口操作');
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(status.textContent).toBe('原终端正在其他入口操作');
  });
});
