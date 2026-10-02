import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {WebSocket} from 'ws';
import {terminalWriteFrame} from '../core/terminal-write-frame.js';
import { herdrExecutable } from './herdr-executable.js';

export const HERDR_WEB_CONTROL_FAILED = 4409;

export interface HerdrWebTarget {
  session: string;
  terminalId: string;
  verify(): void;
}

const validSize = (cols: number, rows: number) => Number.isInteger(cols) && cols >= 20 && cols <= 300
  && Number.isInteger(rows) && rows >= 5 && rows <= 150;

/** A browser owns only its HERDR stream, never the source Agent. Message
 * submission's empty-composer checks do not apply to explicit terminal control:
 * this connection must also let its owner edit drafts and answer native pickers. */
export function connectHerdrWebStream(ws: WebSocket, target: HerdrWebTarget, options: {
  write: boolean;
  expiresAt?: number;
  audit(data: string): void;
}): void {
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false, framed = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason?: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(startTimer); clearTimeout(firstFrameTimer); clearTimeout(expiry); clearInterval(poll);
    if (child) {
      // EOF follows queued input. The timeout kills only this stream helper.
      const stream = child;
      const timer = setTimeout(() => stream.kill('SIGTERM'), 1000);
      timer.unref();
      stream.once('exit', () => clearTimeout(timer));
      if (!stream.stdin.destroyed && stream.exitCode === null) {
        stream.stdin.end(JSON.stringify({type: 'terminal.release'}) + '\n');
      } else clearTimeout(timer);
    }
    if (reason && ws.readyState === WebSocket.OPEN) ws.close(HERDR_WEB_CONTROL_FAILED, reason);
  };
  const verify = () => {
    if (options.expiresAt !== undefined && Date.now() >= options.expiresAt) {
      stop('终端访问已过期；请重新获取链接。');
      return false;
    }
    try { target.verify(); return true; }
    catch { stop('原 Agent 身份已变化；输入未自动重发。'); return false; }
  };
  const send = (data: string) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) return stop('终端输出积压；请重新打开页面。');
    ws.send(data);
  };
  const start = (cols: number, rows: number) => {
    if (child || closed || !verify()) return;
    clearTimeout(startTimer);
    try {
      child = spawn(herdrExecutable(), ['--session', target.session, 'terminal', 'session',
        options.write ? 'control' : 'observe', target.terminalId, '--cols', String(cols), '--rows', String(rows)],
      {stdio: ['pipe', 'pipe', 'pipe']});
      child.stderr.resume();
      child.stdin.on('error', () => stop('终端输入连接已断开；请核对输入后重新打开页面。'));
      child.once('error', () => stop('无法连接原终端；请重新打开页面。'));
      child.once('exit', () => stop(framed ? '原终端连接已断开；输入未自动重发。'
        : '无法取得终端连接；请先在其他入口释放操作权。'));
      firstFrameTimer = setTimeout(() => stop('取得终端连接超时；请重新打开页面。'), 5000);
      firstFrameTimer.unref();
      const lines = createInterface({input: child.stdout});
      lines.on('line', line => {
        if (closed) return;
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'terminal.closed') return stop(
            typeof frame.reason === 'string' && frame.reason.includes('already has an attached client')
              ? '原终端正在其他入口操作；请先断开该入口。'
              : '原终端连接被拒绝或已释放；请重新打开页面。');
          if (frame.type !== 'terminal.frame' || typeof frame.bytes !== 'string') return;
          if (!framed) {
            if (!verify()) return;
            clearTimeout(firstFrameTimer);
            framed = true;
            // No snapshot broadcaster registers this socket. Authority is the
            // first frame, only after HERDR has accepted this particular stream.
            send(terminalWriteFrame(options.write));
          }
          const size = !options.write && validSize(frame.width, frame.height)
            ? `\x1b]1989;${frame.width};${frame.height}\x07` : '';
          send(size + Buffer.from(frame.bytes, 'base64').toString('utf8'));
        } catch { stop('原终端流无法读取；请重新打开页面。'); }
      });
      poll = setInterval(verify, 1000); poll.unref();
    } catch { stop('无法连接原终端；请重新打开页面。'); }
  };
  // onopen sends the viewport before the browser knows its write verdict.
  // Handle it now; do not drop it while waiting for the native first frame.
  const startTimer = setTimeout(() => start(120, 40), 300);
  startTimer.unref();
  if (options.expiresAt !== undefined) {
    expiry = setTimeout(() => stop('终端访问已过期；请重新获取链接。'), Math.max(0, options.expiresAt - Date.now()));
    expiry.unref();
  }
  ws.on('message', raw => {
    if (closed) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'resize' && validSize(message.cols, message.rows)) {
      if (!child) return start(message.cols, message.rows);
      if (options.write && verify()) {
        try { child.stdin.write(JSON.stringify({type: 'terminal.resize', cols: message.cols, rows: message.rows}) + '\n'); }
        catch { stop('终端连接已断开；请重新打开页面。'); }
      }
    } else if (message.type === 'input' && typeof message.data === 'string') {
      if (!options.write) return;
      if (!framed || !child) return stop('尚未取得原终端控制权；输入未发送。');
      if (!verify()) return;
      if (Buffer.byteLength(message.data) > 64 * 1024) return stop('单次终端输入过长；输入未发送。');
      try {
        child.stdin.write(JSON.stringify({type: 'terminal.input', text: message.data}) + '\n');
        options.audit(message.data);
      } catch { stop('终端输入连接已断开；请核对输入后重新打开页面。'); }
    }
  });
  ws.once('close', () => stop());
  ws.once('error', () => stop('终端连接已断开；输入未自动重发。'));
}
