import { createHash } from 'node:crypto';

export type CreationProfile = { id: string; revision: number; label: string; harnessId: string };
type Bootstrap = {
  csrfToken: string;
  modelRouteProfiles: Array<{ id: string; revision: number; label: string }>;
  modelRouteCompatibility: Array<{ harnessId: string; available: boolean; profileRef: { id: string; revision: number } }>;
};
type CaseDetail = { case: { id: string; workspacePath: string; nativeStartError?: string; runtimes?: Record<string, {
  paneId?: string; terminalId?: string; herdrSession?: string; sessionId?: string;
}> } };

/** Reuse AllInOne's native creation and durable mutation key. Never spawn a BotMux-owned CLI. */
export class SharedSessionCreator {
  private readonly base: string;
  constructor(base = process.env.BOTMUX_ALLINONE_URL || 'http://127.0.0.1:4318', private readonly request: typeof fetch = fetch) {
    const url = new URL(base);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) {
      throw new Error('新建会话只能连接本机 AllInOne。');
    }
    this.base = url.origin;
  }
  private async api<T>(route: string, body?: unknown, token?: string): Promise<T> {
    const response = await this.request(this.base + route, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-allinone-token': token! },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message || `AllInOne HTTP ${response.status}`);
    return result;
  }
  private profiles(boot: Bootstrap, cliId: string): CreationProfile[] {
    const harnessId = cliId === 'codebuddy' ? 'workbuddy' : cliId === 'claude-code' ? 'claude-code' : undefined;
    if (!harnessId) return [];
    return boot.modelRouteProfiles.filter(profile => boot.modelRouteCompatibility.some(entry =>
      entry.harnessId === harnessId && entry.available && entry.profileRef.id === profile.id
      && entry.profileRef.revision === profile.revision,
    )).map(profile => ({ ...profile, harnessId }));
  }
  async list(cliId: string): Promise<CreationProfile[]> {
    return this.profiles(await this.api<Bootstrap>('/api/bootstrap'), cliId);
  }
  async create(cliId: string, profileId: string, appId: string, rootId: string): Promise<CaseDetail['case']> {
    const boot = await this.api<Bootstrap>('/api/bootstrap');
    const profile = this.profiles(boot, cliId).find(item => item.id === profileId);
    if (!profile) throw new Error('所选模型通道当前不可用，请重新打开新建会话菜单。');
    const mutationKey = 'lark-create-' + createHash('sha256').update(JSON.stringify([appId, rootId])).digest('hex');
    const detail = await this.api<CaseDetail>('/api/cases', {
      title: `飞书 · ${profile.label}`.slice(0, 200), adapterId: profile.harnessId,
      profileRef: { id: profile.id, revision: profile.revision }, mutationKey,
    }, boot.csrfToken);
    // Read the same persisted case on retries; no hidden replacement or automatic recovery.
    const current = await this.api<CaseDetail>(`/api/cases/${encodeURIComponent(detail.case.id)}`);
    const binding = current.case.runtimes?.[profile.harnessId];
    if (current.case.nativeStartError || !binding?.terminalId || !binding.paneId || !binding.sessionId) {
      throw new Error(`会话 ${current.case.id} 已保留，但原生终端未就绪：${current.case.nativeStartError || '请检查该会话的启动状态'}。不会重复创建。`);
    }
    return current.case;
  }
}

export function buildSharedCreateCard(profiles: CreationProfile[], rootId: string, invoker: string): string {
  return JSON.stringify({ schema: '2.0', header: { title: { tag: 'plain_text', content: '新建会话' }, template: 'blue' },
    body: { elements: [
      { tag: 'markdown', content: '选择模型，在当前话题创建并连接新会话。创建后可在飞书继续发任务，也可在 AllInOne Web 打开同一会话。' },
      ...profiles.map(profile => ({ tag: 'button', text: { tag: 'plain_text', content: profile.label }, type: 'primary',
        behaviors: [{ type: 'callback', value: { action: 'shared_create', root_id: rootId, invoker_open_id: invoker, profile_id: profile.id } }],
      })),
    ] },
  });
}
