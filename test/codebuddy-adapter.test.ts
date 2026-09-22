import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createCodeBuddyAdapter} from '../src/adapters/cli/codebuddy.js';

const sid='00000000-0000-4000-8000-000000000001';
it('keeps model and native identity, and installs end-of-turn observation for fresh and resume',()=>{
  const directory=mkdtempSync(join(tmpdir(),'botmux-codebuddy-'));
  try {
    const adapter=createCodeBuddyAdapter('/opt/WorkBuddy/codebuddy');
    for(const model of ['deepseek-v4.1-flash','hy3','hy4-preview-f']) {
      const args=adapter.buildArgs({sessionId:sid,resume:false,workingDir:'/work',settingsFilePath:join(directory,model),model});
      expect(args).toContain('--session-id');expect(args).toContain(sid);expect(args).toContain(model);expect(args).not.toContain('--print');
      const settings=JSON.parse(readFileSync(args[1],'utf8'));
      expect(Object.keys(settings.hooks)).toEqual(['Stop','StopFailure']);
      expect(settings.hooks.Stop[0].hooks[0].command).toContain(`'${sid}' '/work'`);
    }
    const args=adapter.buildArgs({sessionId:'00000000-0000-4000-8000-000000000002',resume:true,resumeSessionId:sid,workingDir:'/work',settingsFilePath:join(directory,'resume')});
    expect(args.slice(2,4)).toEqual(['--resume',sid]);expect(args).not.toContain('--session-id');
    expect(()=>adapter.buildArgs({sessionId:sid,resume:true,workingDir:'/work'})).toThrow(/原 session/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

it('writes Stop evidence only for the matching native session and generation',()=>{
  const home=mkdtempSync(join(tmpdir(),'codebuddy-hook-'));
  const hook=fileURLToPath(new URL('../src/services/codebuddy-stop-hook.ts',import.meta.url));
  const directory=join(home,'.codebuddy','projects','work',`${sid}.allinone-stops`);
  const run=(event:object)=>spawnSync(process.execPath,['--import','tsx',hook,sid,'/work'],{env:{...process.env,HOME:home},input:JSON.stringify(event),encoding:'utf8'});
  try {
    expect(run({session_id:'wrong',hook_event_name:'Stop',generation_id:'final'}).status).toBe(0);
    expect(existsSync(directory)).toBe(false);
    expect(run({session_id:sid,hook_event_name:'Stop',generation_id:'../escape'}).status).toBe(0);
    expect(existsSync(directory)).toBe(false);
    expect(run({session_id:sid,hook_event_name:'Stop',generation_id:'final'}).status).toBe(0);
    expect(JSON.parse(readFileSync(join(directory,'final.json'),'utf8'))).toMatchObject({sessionId:sid,generationId:'final',event:'Stop'});
    expect(readdirSync(directory)).toEqual(['final.json']);
  } finally {rmSync(home,{recursive:true,force:true});}
});
