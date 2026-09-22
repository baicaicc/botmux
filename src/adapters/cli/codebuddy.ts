import {mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveCommand} from './registry.js';
import type {CliAdapter} from './types.js';
import {codebuddyTranscript,drainCodeBuddyTranscript} from '../../services/codebuddy-transcript.js';
export function createCodeBuddyAdapter(pathOverride?:string):CliAdapter {
  return {
    id:'codebuddy',
    get resolvedBin(){return resolveCommand(pathOverride ?? 'codebuddy');},
    buildArgs({sessionId,resume,resumeSessionId,model,workingDir,settingsFilePath}) {
      // Older managed sessions predate daemon persistence of the native id.
      // Their explicit --session-id equals the BotMux id; only recover it
      // when that exact cwd-scoped native transcript confirms the identity.
      if (resume && !resumeSessionId && workingDir) {
        const file = codebuddyTranscript(sessionId, workingDir);
        if (file && drainCodeBuddyTranscript(file, 0).events.some(event => event.sourceSessionId === sessionId)) resumeSessionId = sessionId;
      }
      if(resume && !resumeSessionId)throw new Error('CodeBuddy 恢复必须指定原 session。');
      const nativeId = resume ? resumeSessionId! : sessionId;
      if (!/^[0-9a-f-]{36}$/i.test(nativeId) || !workingDir) throw new Error('CodeBuddy 需要明确的原生身份与工作目录。');
      const settings = settingsFilePath ? `${settingsFilePath}.codebuddy-hooks.json`
        : join(homedir(), '.codebuddy', 'botmux-hooks', `${nativeId}.json`);
      const quote = (value:string) => `'${value.replaceAll("'", `'"'"'`)}'`;
      const command = [process.execPath, fileURLToPath(new URL('../../services/codebuddy-stop-hook.js', import.meta.url)), nativeId, workingDir].map(quote).join(' ');
      mkdirSync(dirname(settings), {recursive:true,mode:0o700});
      writeFileSync(settings, JSON.stringify({hooks:Object.fromEntries(['Stop','StopFailure'].map(event => [event,[{hooks:[{type:'command',command}]}]]))}), {mode:0o600});
      return ['--settings', settings,...(resume?['--resume',resumeSessionId!]:['--session-id',sessionId]),...(model?['--model',model]:[]),'--permission-mode','default'];
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
