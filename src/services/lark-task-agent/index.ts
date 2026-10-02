/**
 * Daemon-facing entry of the Lark Task ingress: one {@link LarkTaskAgent} per
 * bot that has `taskAgent` enabled in bots.json.
 */
import { config } from '../../config.js';
import type { TriggerRequest, TriggerResponse } from '../trigger-types.js';
import { createLarkTaskApi } from './api.js';
import { LarkTaskAgent } from './bridge.js';
import { createTaskAgentStore, taskAgentStorePath } from './store.js';

export { LarkTaskAgent, type TaskEvent } from './bridge.js';

export interface TaskAgentRuntime {
  trigger: (req: TriggerRequest) => Promise<TriggerResponse>;
  lookup: (sessionId: string, triggerId: string) => TriggerResponse;
  canOperate: (openId: string) => boolean;
}

const agents = new Map<string, LarkTaskAgent>();

export function getLarkTaskAgent(larkAppId: string): LarkTaskAgent | undefined {
  return agents.get(larkAppId);
}

/** Create and start the bot's task agent. Safe to call once per bot at daemon boot. */
export function startLarkTaskAgent(larkAppId: string, runtime: TaskAgentRuntime): LarkTaskAgent {
  const existing = agents.get(larkAppId);
  if (existing) return existing;
  const agent = new LarkTaskAgent({
    larkAppId,
    api: createLarkTaskApi(larkAppId),
    store: createTaskAgentStore(taskAgentStorePath(config.session.dataDir, larkAppId)),
    ...runtime,
  });
  agents.set(larkAppId, agent);
  void agent.start();
  return agent;
}
