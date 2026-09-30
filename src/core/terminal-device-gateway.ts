import { randomBytes } from 'node:crypto';
import { issueTerminalControlGrant, type TerminalControlScope } from './terminal-control-grant.js';
import { safeTerminalTokenEqual } from './terminal-write-auth.js';
import { TerminalDeviceStore } from './terminal-device-store.js';
import type { TerminalProxyRequest, TerminalProxyAuthorization } from './terminal-proxy.js';

const COOKIE = '__Host-botmux_terminal_device';
const DEVICE_SECONDS = 180 * 24 * 60 * 60;

export interface TerminalDeviceSession {
  ownerId: string;
  writeToken: string | null;
  viewToken: string | null;
}

export interface TerminalDeviceGatewayOptions {
  store: TerminalDeviceStore;
  /** A single configured HTTPS origin, never derived from forwarded headers. */
  origin: string;
  secret: () => string | null;
  session: (sessionId: string) => TerminalDeviceSession | null;
  notifyPairing: (sessionId: string, code: string, scope: TerminalControlScope) => Promise<void>;
  cookieName?: string;
}

function headersFor(request: TerminalProxyRequest): Map<string, string> | null {
  const headers = new Map<string, string>();
  for (const line of request.headers) {
    const separator = line.indexOf(':');
    if (separator < 1 || /^[ \t]/.test(line)) return null;
    const name = line.slice(0, separator).toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null;
    // Reject ambiguous cookie/origin/host headers rather than choosing one.
    if (headers.has(name) && ['cookie', 'origin', 'host', 'content-length', 'transfer-encoding', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version'].includes(name)) return null;
    headers.set(name, line.slice(separator + 1).trim());
  }
  return headers;
}

function deviceToken(headers: Map<string, string>, name: string): string | undefined {
  const values = (headers.get('cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

function escaped(value: string): string {
  return value.replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]!));
}

function response(status: number, body: string, extra: Record<string, string> = {}): TerminalProxyAuthorization {
  return {
    kind: 'response', status, body,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      ...extra,
    },
  };
}

function html(title: string, content: string, script = ''): { body: string; headers: Record<string, string> } {
  const nonce = randomBytes(18).toString('base64url');
  return {
    body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">body{margin:0;background:#111820;color:#e8eef2;font:16px/1.65 system-ui,sans-serif;display:grid;min-height:100dvh;place-items:center}main{margin:24px;max-width:420px;padding:28px;border:1px solid #34424d;border-radius:16px;background:#19242d}h1{font-size:24px;margin:0 0 16px}p{color:#bac7d0}code{display:block;letter-spacing:3px;font-size:26px;color:#a7e5cb;margin:20px 0}button,a{display:inline-block;font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #527968;background:#a7e5cb;color:#142820;text-decoration:none;cursor:pointer}small{color:#a9b8c2}</style><main><h1>${title}</h1>${content}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` },
  };
}

/** Application guard in front of BOTH the raw HTTP and WebSocket routes. */
export class TerminalDeviceGateway {
  private readonly origin: string;
  private readonly cookieName: string;
  private readonly notified = new Set<string>();

  constructor(private readonly options: TerminalDeviceGatewayOptions) {
    const url = new URL(options.origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('terminal device pairing requires a fixed HTTPS origin');
    }
    this.origin = url.origin;
    this.cookieName = options.cookieName ?? COOKIE;
    if (!/^__Host-[A-Za-z0-9_-]+$/.test(this.cookieName)) throw new Error('invalid terminal device cookie name');
  }

  async authorize(request: TerminalProxyRequest): Promise<TerminalProxyAuthorization> {
    try { return await this.check(request); }
    catch { return response(503, '设备授权暂时不可用，请稍后重试。'); }
  }

  private async check(request: TerminalProxyRequest): Promise<TerminalProxyAuthorization> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.sessionId)) return response(404, 'Not Found');
    const headers = headersFor(request);
    if (!headers) return response(400, 'Bad Request');
    if (request.isUpgrade) {
      // A fake Upgrade header on ordinary keep-alive HTTP must not bypass the
      // proxy's one-request-per-socket rule and smuggle a second unguarded hop.
      const key = headers.get('sec-websocket-key') ?? '';
      if (request.method !== 'GET' || headers.get('upgrade')?.toLowerCase() !== 'websocket'
        || !headers.get('connection')?.toLowerCase().split(',').map(x => x.trim()).includes('upgrade')
        || headers.get('sec-websocket-version') !== '13'
        || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) return response(400, 'Bad Request');
    }
    const url = new URL(request.rest, this.origin);
    if (url.origin !== this.origin) return response(400, 'Bad Request');
    const origin = headers.get('origin');
    if ((request.isUpgrade || request.method === 'POST') && origin !== this.origin) return response(403, 'Forbidden');
    if (origin && origin !== this.origin) return response(403, 'Forbidden');
    // HTTP request smuggling and forwarded-body routes are unnecessary here.
    if (headers.has('transfer-encoding') || (headers.has('content-length') && headers.get('content-length') !== '0')) return response(400, 'Bad Request');
    const session = this.options.session(request.sessionId);
    if (!session?.ownerId) return response(403, '请从当前会话的 Lark 授权链接进入。');
    const token = deviceToken(headers, this.cookieName);
    let identity = token ? this.options.store.identity(token) : null;
    const base = `/s/${request.sessionId}/`;
    const queryWrite = url.searchParams.get('token');
    const queryRead = url.searchParams.get('viewToken');
    const hasCapability = url.searchParams.has('token') || url.searchParams.has('viewToken');
    if (url.searchParams.getAll('token').length > 1 || url.searchParams.getAll('viewToken').length > 1 || (url.searchParams.has('token') && url.searchParams.has('viewToken'))) return response(403, 'Forbidden');
    let scope: TerminalControlScope = url.searchParams.get('access') === 'write' ? 'write' : 'read';
    if (hasCapability) {
      // A view link can NEVER promote an existing device to operate permission.
      if (queryWrite && session.writeToken && safeTerminalTokenEqual(queryWrite, session.writeToken)) scope = 'write';
      else if (queryRead && !queryWrite && session.viewToken && safeTerminalTokenEqual(queryRead, session.viewToken)) scope = 'read';
      else return response(403, '授权链接已失效，请从 Lark 取得当前会话的新链接。');
    }
    if (identity && identity.ownerId !== session.ownerId) {
      if (!hasCapability) return response(403, '设备授权已失效，请从新的 Lark 链接重新配对。');
      identity = null;
    }
    if (url.pathname === '/_device/status') {
      if (request.method !== 'GET' || request.isUpgrade) return response(405, 'Method Not Allowed');
      const grant = token ? this.options.store.access({ browserToken: token, sessionId: request.sessionId, scope, ownerId: session.ownerId }) : null;
      return response(200, JSON.stringify({ paired: !!grant }), { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (url.pathname === '/_device/forget') {
      if (request.method !== 'POST' || request.isUpgrade || !token || !identity) return response(403, 'Forbidden');
      this.options.store.revoke(token);
      return response(200, '此浏览器的设备配对已取消。请重新打开 Lark 链接。', { 'Set-Cookie': `${this.cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return response(405, 'Method Not Allowed');
    if (hasCapability && !request.isUpgrade) {
      if (identity && token) {
        if (!this.options.store.grant({ browserToken: token, sessionId: request.sessionId, scope, ownerId: session.ownerId })) return response(403, 'Forbidden');
        return response(303, '', { Location: `${base}?access=${scope}` });
      }
      const pair = this.options.store.startPair({ sessionId: request.sessionId, scope, ownerId: session.ownerId, browserToken: token });
      let delivered = true;
      if (!this.notified.has(pair.code)) {
        try {
          await this.options.notifyPairing(request.sessionId, pair.code, scope);
          if (this.notified.size >= 100) this.notified.clear();
          this.notified.add(pair.code);
        } catch { delivered = false; }
      }
      const page = html('配对当前浏览器', `<p>回到原 Lark 会话，核对配对卡片上的短码，再点“确认配对”。</p><code>${escaped(pair.code)}</code>${delivered ? '' : '<p>Lark 配对卡片暂未送达。</p>'}<p>也可以在原 Lark 会话发送：<br><b>/term pair ${escaped(pair.code)}</b></p><p>本次只授权当前会话的${scope === 'write' ? '查看和操作' : '查看'}。配对码 5 分钟内有效。</p><small id="state">等待 Lark 确认…</small>`, `history.replaceState(null,'',${JSON.stringify(`${base}_device/wait?access=${scope}`)});const until=${pair.expiresAt};async function poll(){if(Date.now()>=until){document.getElementById('state').textContent='配对码已过期，请重新打开 Lark 链接。';return;}try{const r=await fetch(${JSON.stringify(`${base}_device/status?access=${scope}`)},{cache:'no-store'});if(r.ok&&(await r.json()).paired){location.replace(${JSON.stringify(`${base}?access=${scope}`)});return;}}catch{}setTimeout(poll,1500);}poll();`);
      return response(200, page.body, { ...page.headers, 'Set-Cookie': `${this.cookieName}=${pair.browserToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_SECONDS}` });
    }
    const access = token ? this.options.store.access({ browserToken: token, sessionId: request.sessionId, scope, ownerId: session.ownerId }) : null;
    if (!access || !token) return response(403, '请从当前会话的 Lark 授权链接进入并完成设备配对。');
    if (url.pathname === '/_device/settings' && !request.isUpgrade) {
      const page = html('此会话的设备授权', `<p>当前浏览器已配对。本页只通向当前会话。</p><p>当前入口：${scope === 'write' ? '可操作' : '只读查看'}。</p><a href="${base}?access=${scope}">返回会话</a><p><button id="forget">取消此浏览器的配对</button></p><small id="state"></small>`, `document.getElementById('forget').onclick=async()=>{const r=await fetch(${JSON.stringify(`${base}_device/forget`)},{method:'POST'});document.getElementById('state').textContent=await r.text();};`);
      return response(200, page.body, page.headers);
    }
    // Only the terminal root is forwarded. Pairing routes never reach workers.
    if (url.pathname !== '/') return response(404, 'Not Found');
    const secret = this.options.secret();
    if (!secret) return response(503, '设备授权暂时不可用，请稍后重试。');
    const grant = issueTerminalControlGrant(secret, {
      scope, sessionId: request.sessionId, userId: access.ownerId, authSessionId: access.deviceId,
      issuedAt: Date.now(), expiresAt: Math.min(access.expiresAt, Date.now() + 30 * 60 * 1000),
    });
    const forwarded = request.headers.filter(line => !/^(cookie|authorization|x-botmux-[^:]*|forwarded|x-forwarded-[^:]*|cf-access-[^:]*)\s*:/i.test(line));
    forwarded.push(`X-Botmux-Terminal-Control: ${grant}`);
    forwarded.push('X-Botmux-Terminal-Device: 1');
    return {
      kind: 'forward', rest: `/?access=${scope}`, headers: forwarded,
      isAuthorized: () => {
        try {
          const current = this.options.session(request.sessionId);
          return current?.ownerId === session.ownerId && !!this.options.store.access({ browserToken: token, sessionId: request.sessionId, scope, ownerId: session.ownerId });
        } catch { return false; }
      },
    };
  }
}
