/**
 * 飞书扫码建应用 — 对接 `@larksuiteoapi/node-sdk` 的 `registerApp`.
 *
 * 走 OAuth 2.0 Device Flow (RFC 8628):
 *   1. SDK 向 `accounts.feishu.cn/oauth/v1/app/registration` 发 `action=begin`
 *      请求 (`archetype=PersonalAgent`), 拿到 device_code + 二维码 URL
 *   2. 在终端渲染二维码 + 链接, 等用户扫码
 *   3. SDK 轮询同端点 `action=poll` 直到拿到 client_id + client_secret
 *      (=AppID + AppSecret)
 *
 * 注意:
 * - 这个端点 archetype 写死 `PersonalAgent`, 但实测 PersonalAgent 应用是
 *   可以挂 bot 能力的 (`zarazhangrui/feishu-claude-code-bridge` 在用).
 * - 创建时通过 SDK addons 同时申请核心权限、消息事件与卡片回调。平台可能
 *   忽略租户不支持的名称，所以调用方仍须回读生效权限后才能自动上线。
 * - 指定 appId 时更新原应用，只提交给定的缺失权限；不会创建替代应用。
 * - secret 永远不打印; 错误只暴露 error code / 阶段标签, 不暴露 secret.
 */
import { registerApp } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import { BOTMUX_REQUIRED_SCOPES, BOTMUX_MESSAGE_NARROW_SCOPES } from './verify-permissions.js';

export type RegisterBrand = 'feishu' | 'lark';

export type RegisterAppOk = {
  ok: true;
  appId: string;
  appSecret: string;
  brand: RegisterBrand;
  /**
   * 扫码人的 open_id（飞书 device flow `request_user_info=open_id tenant_brand`
   * 字段返回）。它只是 owner candidate：必须由目标应用验证并尽量转换为
   * union_id 后才能持久化，验证失败不得把这个 open_id fallback 写入
   * `allowedUsers`。没拿到时为 undefined（理论上不会，但接口可能改）。
   */
  userOpenId?: string;
};

export type RegisterAppErr = {
  ok: false;
  /**
   * - `aborted`: 用户 Ctrl-C / 主动取消
   * - `expired`: 二维码过期 (默认 10 分钟)
   * - `denied`: 用户在浏览器里拒绝
   * - `network`: 网络错误 / 端点不可达
   * - `unknown`: 其它 (含 SDK 抛非预期错误)
   */
  error: 'aborted' | 'expired' | 'denied' | 'network' | 'unknown';
  /** 给用户看的简短错误描述, 不含 secret. */
  message: string;
};

export type RegisterAppResult = RegisterAppOk | RegisterAppErr;

export interface RegisterAppOptions {
  /** Existing app to update. Omit only when creating a new app. */
  appId?: string;
  /** Exact missing scope names for an existing-app repair. */
  scopeNames?: string[];
  /** 取消信号 (Ctrl-C 时填充). */
  signal?: AbortSignal;
  /**
   * 渲染前回调, 测试时可注入静默打印. 默认在 stdout 打印二维码 + 链接.
   */
  onQRCodeReady?: (info: { url: string; expireIn: number }) => void;
  /** 状态变更回调, 主要用于"已切换到 Lark 域名"提示. */
  onStatusChange?: (info: { status: string; interval?: number }) => void;
}

/** Keep registration tied to the same core capabilities as startup checks. */
export function buildRegistrationAddons(scopeNames?: string[]) {
  const requested = scopeNames ?? [
    ...BOTMUX_REQUIRED_SCOPES.filter(scope => scope.critical).map(scope => scope.name),
    'contact:user.id:readonly', // Resolve configured owner email/phone in this app.
    'application:application:self_manage', // Read back effective permissions.
  ];
  const tenant = [...new Set(requested.flatMap(name =>
    name === 'im:message' ? [...BOTMUX_MESSAGE_NARROW_SCOPES] : [name],
  ))];
  return {
    scopes: { tenant, user: [] as string[] },
    ...(scopeNames === undefined ? {
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    } : {}),
  };
}

function defaultPrintQRCode(info: { url: string; expireIn: number }): void {
  const mins = Math.max(1, Math.round(info.expireIn / 60));
  process.stderr.write('\n请用飞书 App 扫码完成应用创建：\n\n');
  qrcode.generate(info.url, { small: true }, (qr) => process.stderr.write(qr + '\n'));
  process.stderr.write(`\n二维码有效期约 ${mins} 分钟。也可在浏览器打开：\n  ${info.url}\n\n`);
}

function defaultPrintStatus(info: { status: string; interval?: number }): void {
  if (info.status === 'domain_switched') {
    process.stderr.write('识别到国际版租户, 已切换到 larksuite.com 域名继续轮询。\n');
  } else if (info.status === 'slow_down' && info.interval) {
    process.stderr.write(`轮询过快, 间隔自动调整到 ${info.interval}s。\n`);
  }
}

/**
 * 尝试扫码建应用. 任何失败都返回 RegisterAppErr (不抛), 调用方可以回退手动粘.
 *
 * Secret 安全约束:
 * - SDK 返回的 client_secret 只放进返回值, 不打印, 不写日志
 * - 错误链里只放错误 code / 阶段, 不带 secret
 */
export async function tryRegisterApp(opts: RegisterAppOptions = {}): Promise<RegisterAppResult> {
  const onQR = opts.onQRCodeReady ?? defaultPrintQRCode;
  const onStatus = opts.onStatusChange ?? defaultPrintStatus;

  try {
    const result = await registerApp({
      signal: opts.signal,
      source: 'botmux',
      addons: buildRegistrationAddons(opts.scopeNames),
      ...(opts.appId ? { appId: opts.appId, createOnly: false } : { createOnly: true }),
      onQRCodeReady: onQR,
      onStatusChange: onStatus,
    });

    if (opts.appId && result.client_id !== opts.appId) {
      return { ok: false, error: 'unknown', message: '授权结果不是指定的原应用；未替换 Bot 配置，请核对原授权请求。' };
    }

    if (!result.client_id || !result.client_secret) {
      return {
        ok: false,
        error: 'unknown',
        message: 'SDK 返回的 client_id/client_secret 为空',
      };
    }

    const brand: RegisterBrand = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
    const userOpenId =
      typeof result.user_info?.open_id === 'string' && result.user_info.open_id.startsWith('ou_')
        ? result.user_info.open_id
        : undefined;

    return {
      ok: true,
      appId: result.client_id,
      appSecret: result.client_secret,
      brand,
      userOpenId,
    };
  } catch (err: any) {
    // SDK 抛 LarkChannelError, code 字段对齐 RFC 8628 的 device flow 错误
    const code: string = err?.code ?? '';
    const rawMsg: string = err?.message ?? String(err);
    // SDK 不会把 secret 放进 message, 但保险起见再过一次
    const safeMsg = rawMsg.replace(/[a-zA-Z0-9_-]{30,}/g, '***');

    if (code === 'abort') return { ok: false, error: 'aborted', message: '用户取消扫码' };
    if (code === 'expired_token') return { ok: false, error: 'expired', message: '二维码已过期, 请重试' };
    if (code === 'access_denied') return { ok: false, error: 'denied', message: '用户在浏览器里拒绝授权' };

    // 网络层错误 (axios) — 没固定 code, 看 message
    if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(rawMsg)) {
      return { ok: false, error: 'network', message: `网络错误: ${safeMsg}` };
    }

    return { ok: false, error: 'unknown', message: safeMsg };
  }
}
