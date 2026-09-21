import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {homedir} from 'node:os';

/** AllInOne launches CC in a per-session config directory. Read only its
 * credential-free launch record, cross-checking parent PID and native SID.
 * No process environment (and therefore no API key) is inspected or logged. */
export function claudeDataDirForPid(pid?:number):string {
  const fallback=join(homedir(),'.claude');if(!pid)return fallback;
  try {
    const parent=Number(execFileSync('ps',['-p',String(pid),'-o','ppid='],{encoding:'utf8',timeout:2000}).trim());
    if(!Number.isInteger(parent)||parent<1)return fallback;
    const command=execFileSync('ps',['-p',String(parent),'-o','command='],{encoding:'utf8',timeout:2000}).trim();
    const match=command.match(/\/interactive-launcher\.mjs (\/.+\/request\.json)$/);if(!match)return fallback;
    const request=JSON.parse(readFileSync(match[1],'utf8'));
    const process=JSON.parse(readFileSync(join(dirname(match[1]),'process.json'),'utf8'));
    if(request.harnessId!=='claude-code' || process.pid!==pid || process.launchId!==request.launchId || process.sessionId!==request.sessionId || !isAbsolute(request.configDir))return fallback;
    const meta=JSON.parse(readFileSync(join(request.configDir,'sessions',`${pid}.json`),'utf8'));
    return meta.sessionId===request.sessionId ? request.configDir:fallback;
  }catch{return fallback;}
}
