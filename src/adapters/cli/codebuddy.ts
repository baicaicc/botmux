import {resolveCommand} from './registry.js';
import type {CliAdapter} from './types.js';
export function createCodeBuddyAdapter(pathOverride?:string):CliAdapter {
  return {
    id:'codebuddy',
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
