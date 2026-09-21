import {resolveCommand} from './registry.js';
import type {CliAdapter, StructuredBridgeSpec} from './types.js';
import {codebuddySession,codebuddyTranscript,drainCodeBuddyTranscript} from '../services/codebuddy-transcript.js';

/** CodeBuddy 原生 JSONL 转写桥：路径发现走 ~/.codebuddy/projects，drain 依赖
 *  .allinone-stops 站内 Stop 记录确认 assistant 终态（fork 自有机制）。 */
export const codebuddyBridgeSpec: StructuredBridgeSpec = {
  drain: (path, offset) => drainCodeBuddyTranscript(path, offset),
  locate: {
    bySessionId: (sessionId, cwd) => (cwd ? codebuddyTranscript(sessionId, cwd) : undefined),
    byPid: pid => {
      const meta = codebuddySession(pid);
      return meta ? codebuddyTranscript(meta.sessionId, meta.cwd) : undefined;
    },
  },
  // 原 worker 分支语义：resume 启动 → baseline-existing（历史已交付），
  // 全新启动 → fresh-empty；--session-id 可由适配器固定 → 'cli-or-adapter'。
  spawn: { sessionId: 'cli-or-adapter', baseline: 'resume-aware' },
  // CodeBuddy JSONL 每行带 timestamp，adopt 采用时间戳切分。
  adopt: { attach: 'split-live' },
};

export function createCodeBuddyAdapter(pathOverride?:string):CliAdapter {
  return {
    id:'codebuddy',
    bridgeSpec: codebuddyBridgeSpec,
    get resolvedBin(){return resolveCommand(pathOverride ?? 'codebuddy');},
    buildArgs({sessionId,resume,resumeSessionId,model}) {
      if(resume && !resumeSessionId)throw new Error('CodeBuddy 恢复必须指定原 session。');
      return [...(resume?['--resume',resumeSessionId!]:['--session-id',sessionId]),...(model?['--model',model]:[]),'--permission-mode','default'];
    },
    async writeInput(pty,content) {
      if(!pty.sendText || !pty.sendSpecialKeys)throw new Error('CodeBuddy 需要共享原生终端输入。');
      if(pty.sendText(content)===false)throw new Error('输入送达未确认；未自动重发。');
      await new Promise(resolve=>setTimeout(resolve,200));
      if(pty.sendSpecialKeys('Enter')===false)throw new Error('提交未确认；未自动重发。');
    },
    authPaths:['~/.codebuddy','~/.workbuddy-ai'],
    injectsSessionContext:true,systemHints:[],altScreen:false,
    busyPattern:/esc to interrupt/i,
  };
}
