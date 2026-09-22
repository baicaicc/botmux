/** Opt-in for bots that only attach to externally managed native sessions. */
export function isSharedOnlyBot(appId: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!appId && !!env.BOTMUX_SHARED_ONLY_APP_ID && env.BOTMUX_SHARED_ONLY_APP_ID === appId;
}

export function needsSharedSessionPicker(appId: string, content: string, session?: {
  adoptedFrom?: unknown; session: { existingAppServerEndpoint?: string };
}, env: NodeJS.ProcessEnv = process.env): boolean {
  return isSharedOnlyBot(appId, env) && !session?.adoptedFrom
    && !session?.session.existingAppServerEndpoint && !content.trim().startsWith('/');
}

export const SHARED_SESSION_NOTICE = '这个话题还没有连接会话。请在下方选择一个已运行的 HERDR 会话。刚才的消息尚未发送给 Agent，连接后请重新发送；原消息仍保留在话题中。';
export const SHARED_LAUNCH_NOTICE = '此机器人只连接已有会话，不会另起 Agent。请发送 /adopt 选择已运行的 HERDR 会话，再继续交互。';
