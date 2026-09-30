import { larkHosts, type Brand } from '../im/lark/lark-hosts.js';
import { readCriticalScopesFromApplicationInfo } from './verify-permissions.js';

export interface SetupPermissionReadiness {
  status: 'ready' | 'missing' | 'unverified';
  missing: Array<{ name: string; feature: string }>;
  deeplink: string;
  continueCommand: string;
  error?: string;
  message?: string;
}

export interface SetupPermissionBot {
  larkAppId: string;
  larkAppSecret: string;
  brand: Brand;
}

/** A successful registration/configuration request is not proof of live scopes. */
export async function readSetupPermissionReadiness(bot: SetupPermissionBot): Promise<SetupPermissionReadiness> {
  const base = {
    deeplink: `${larkHosts(bot.brand).openApi}/app/${encodeURIComponent(bot.larkAppId)}/auth`,
    continueCommand: `botmux setup configure ${bot.larkAppId}`,
  };
  try {
    const result = await readCriticalScopesFromApplicationInfo(bot.larkAppId, bot.larkAppSecret, bot.brand);
    if (!result.ok) {
      return { ...base, status: 'unverified', missing: [], error: result.error, message: result.message };
    }
    return {
      ...base,
      status: result.missingCritical.length ? 'missing' : 'ready',
      missing: result.missingCritical.map(scope => ({ name: scope.name, feature: scope.desc })),
    };
  } catch {
    return { ...base, status: 'unverified', missing: [], error: 'unknown', message: '无法核验实际生效权限，请稍后重试。' };
  }
}

/** Explicit Lark repair updates the exact existing app, then reads it back. */
export async function configureLarkPermissionReadiness(
  bot: SetupPermissionBot,
  options: { json: boolean },
): Promise<SetupPermissionReadiness> {
  let permissions = await readSetupPermissionReadiness(bot);
  if (permissions.status === 'ready' || options.json || bot.brand !== 'lark') return permissions;
  // Network failure gives no evidence that a scope change is needed. Missing
  // self_manage is different: the API explicitly names the readback prerequisite.
  if (permissions.status === 'unverified' && permissions.error !== 'need_self_manage') return permissions;
  const scopeNames = permissions.status === 'missing'
    ? permissions.missing.map(scope => scope.name)
    : ['application:application:self_manage'];
  const { tryRegisterApp } = await import('./register-app.js');
  const updated = await tryRegisterApp({ appId: bot.larkAppId, scopeNames });
  if (!updated.ok) {
    return { ...permissions, error: `authorization_${updated.error}`, message: updated.message };
  }
  // Keep the saved credentials: authorizing another app can never activate this one.
  if (updated.appId !== bot.larkAppId || updated.brand !== bot.brand) {
    return { ...permissions, error: 'authorization_app_mismatch', message: '授权返回的应用或租户类型不匹配；原应用配置保留。' };
  }
  if (updated.appSecret !== bot.larkAppSecret) {
    return { ...permissions, status: 'unverified', error: 'authorization_secret_changed', message: '授权返回的 App Secret 与已保存凭据不同；请人工核验原应用凭据，配置未替换、未自动上线。' };
  }
  permissions = await readSetupPermissionReadiness(bot);
  return permissions;
}

export function setupPermissionBlockedMessage(permissions: SetupPermissionReadiness): string {
  const reason = permissions.status === 'missing'
    ? `缺少关键权限：${permissions.missing.map(scope => `${scope.name}（${scope.feature}）`).join('、')}${permissions.message ? `；授权尚未完成：${permissions.message}` : ''}`
    : `实际生效权限尚未核验${permissions.message ? `：${permissions.message}` : ''}`;
  return `${reason}。原应用与机器人配置已保留，未自动上线。权限管理：${permissions.deeplink}；完成授权后运行 ${permissions.continueCommand}。`;
}
