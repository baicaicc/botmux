/** A specifically delegated desktop-task DM must not also spawn a CLI. */
export function isExternalTaskDm(appId: string, message: { chat_type?: string; chat_id?: string } | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BOTMUX_EXTERNAL_DM_APP_ID && env.BOTMUX_EXTERNAL_DM_CHAT_ID &&
    appId === env.BOTMUX_EXTERNAL_DM_APP_ID && message?.chat_type === 'p2p' &&
    message.chat_id === env.BOTMUX_EXTERNAL_DM_CHAT_ID);
}
