/**
 * Lark Task v2 calls used by the task-agent ingress, made as the bot (tenant
 * identity). The agent endpoints (`agent/register_agent`, `task_subscription`,
 * the `agent_task_*` task fields) are not wrapped by the SDK yet, so everything
 * goes through the client's raw `request`.
 */
import { getBotClient } from '../../bot-registry.js';

export interface LarkTaskMember {
  id: string;
  type?: string;
  role?: string;
}

export interface LarkTask {
  guid: string;
  summary: string;
  description: string;
  url?: string;
  /** `todo` | `done`. */
  status?: string;
  /** 1 未开始 / 2 进行中 / 3 待确认 / 4 已完成。 */
  agentTaskStatus?: number;
  creator?: { id: string; type?: string };
  members: LarkTaskMember[];
}

export interface LarkTaskComment {
  id: string;
  content: string;
  createdAt: number;
  creator?: { id: string; type?: string };
}

export const AGENT_TASK_STATUS = {
  notStarted: 1,
  running: 2,
  waitingForHuman: 3,
  done: 4,
} as const;

export type AgentTaskStatus = (typeof AGENT_TASK_STATUS)[keyof typeof AGENT_TASK_STATUS];

export interface LarkTaskApi {
  /** Register this app as a task agent and subscribe it to task events. Idempotent. */
  register(): Promise<void>;
  getTask(taskGuid: string): Promise<LarkTask>;
  listComments(taskGuid: string): Promise<LarkTaskComment[]>;
  /** Returns the id of the created comment. */
  createComment(taskGuid: string, content: string): Promise<string>;
  setAgentStatus(taskGuid: string, status: AgentTaskStatus, progress: string): Promise<void>;
}

const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_PAGES = 10;

async function call(larkAppId: string, method: 'GET' | 'POST' | 'PATCH', url: string, params?: Record<string, unknown>, data?: unknown): Promise<any> {
  const client = getBotClient(larkAppId) as any;
  const res = await client.request({ method, url, ...(params ? { params } : {}), ...(data !== undefined ? { data } : {}) });
  if (res?.code !== 0 && res?.code !== undefined) {
    throw new Error(`${method} ${url} failed: ${res.msg ?? ''} (code: ${res.code})`);
  }
  return res?.data ?? {};
}

function toTask(raw: any): LarkTask {
  return {
    guid: String(raw?.guid ?? ''),
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    description: typeof raw?.description === 'string' ? raw.description : '',
    url: typeof raw?.url === 'string' ? raw.url : undefined,
    status: typeof raw?.status === 'string' ? raw.status : undefined,
    agentTaskStatus: typeof raw?.agent_task_status === 'number' ? raw.agent_task_status : undefined,
    creator: raw?.creator?.id ? { id: String(raw.creator.id), type: raw.creator.type } : undefined,
    members: Array.isArray(raw?.members)
      ? raw.members.filter((m: any) => m?.id).map((m: any) => ({ id: String(m.id), type: m.type, role: m.role }))
      : [],
  };
}

export function createLarkTaskApi(larkAppId: string): LarkTaskApi {
  return {
    async register() {
      await call(larkAppId, 'POST', '/open-apis/task/v2/agent/register_agent', undefined, {});
      await call(larkAppId, 'POST', '/open-apis/task/v2/task_v2/task_subscription', { user_id_type: 'open_id' }, {});
    },

    async getTask(taskGuid) {
      const data = await call(larkAppId, 'GET', `/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}`, { user_id_type: 'open_id' });
      return toTask(data.task);
    },

    async listComments(taskGuid) {
      const comments: LarkTaskComment[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < COMMENT_MAX_PAGES; page++) {
        const data = await call(larkAppId, 'GET', '/open-apis/task/v2/comments', {
          resource_type: 'task',
          resource_id: taskGuid,
          page_size: COMMENT_PAGE_SIZE,
          user_id_type: 'open_id',
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        for (const item of Array.isArray(data.items) ? data.items : []) {
          if (!item?.id) continue;
          comments.push({
            id: String(item.id),
            content: typeof item.content === 'string' ? item.content : '',
            createdAt: Number(item.created_at) || 0,
            creator: item.creator?.id ? { id: String(item.creator.id), type: item.creator.type } : undefined,
          });
        }
        if (!data.has_more || !data.page_token) break;
        pageToken = String(data.page_token);
      }
      return comments.sort((a, b) => a.createdAt - b.createdAt);
    },

    async createComment(taskGuid, content) {
      const data = await call(larkAppId, 'POST', '/open-apis/task/v2/comments', { user_id_type: 'open_id' }, {
        content,
        resource_type: 'task',
        resource_id: taskGuid,
      });
      return String(data.comment?.id ?? '');
    },

    async setAgentStatus(taskGuid, status, progress) {
      await call(larkAppId, 'PATCH', `/open-apis/task/v2/tasks/${encodeURIComponent(taskGuid)}`, { user_id_type: 'open_id' }, {
        task: { agent_task_status: status, agent_task_progress: progress },
        update_fields: ['agent_task_status', 'agent_task_progress'],
      });
    },
  };
}
