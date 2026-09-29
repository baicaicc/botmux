import {existsSync,readFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {homedir} from 'node:os';
const uuid=/^[0-9a-f-]{36}$/i;
export function codebuddyTranscript(sessionId:string,cwd:string):string|undefined {
  if(!uuid.test(sessionId) || !cwd.startsWith('/'))return;
  const file=join(homedir(),'.codebuddy','projects',cwd.replace(/^\/+/, '').replaceAll('/','-'),`${sessionId}.jsonl`);
  return existsSync(file)?file:undefined;
}
export function codebuddySession(pid:number):{sessionId:string;cwd:string;startedAt?:number}|undefined {
  try {
    const meta=JSON.parse(readFileSync(join(homedir(),'.codebuddy','sessions',`${pid}.json`),'utf8'));
    if(meta.pid!==pid || !uuid.test(meta.sessionId) || typeof meta.cwd!=='string')return;
    return {sessionId:meta.sessionId,cwd:meta.cwd,startedAt:meta.startedAt};
  }catch{return;}
}
export interface CodeBuddyBridgeEvent {uuid:string;timestampMs:number;kind:'user'|'assistant_final';text:string;sourceSessionId:string;terminalStatus?:'completed'|'failed'|'ambiguous';terminalErrorCode?:string;terminalErrorSummary?:string;}
function readStop(file:string,sessionId:string,generationId:unknown):'Stop'|'StopFailure'|undefined {
  if(typeof generationId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(generationId))return;
  try {
    const stop=JSON.parse(readFileSync(join(file.replace(/\.jsonl$/,'.allinone-stops'),`${generationId}.json`),'utf8'));
    if(stop?.sessionId===sessionId && stop.generationId===generationId && ['Stop','StopFailure'].includes(stop.event))return stop.event;
  }catch{}
}
/** Offset remains at an unconfirmed assistant until its exact Stop hook arrives.
 * It cannot be promoted to a final by a quiet/idle screen. AllInOne's launcher
 * writes only the hook's native generation id, which CLI 2.137.1 reports as the
 * final assistant id. CLI 2.159.0 provider failures instead use the request id;
 * that fallback is restricted to explicit native error records. */
export function drainCodeBuddyTranscript(file:string,offset:number) {
  const bytes=readFileSync(file),sessionId=basename(file,'.jsonl');
  if(!uuid.test(sessionId) || offset>bytes.length)throw new Error('CodeBuddy transcript identity changed');
  const tail=bytes.subarray(offset).toString('utf8'),lines=tail.split('\n');const pendingTail=lines.pop()!;
  const events:CodeBuddyBridgeEvent[]=[];let newOffset=offset,held:number|undefined;
  let failure:{event:CodeBuddyBridgeEvent;requestId:unknown}|undefined;
  const finishFailure=()=>{
    if(failure && (readStop(file,sessionId,failure.event.uuid) || readStop(file,sessionId,failure.requestId))) {
      held=undefined;events.push(failure.event);
    }
    failure=undefined;
  };
  for(const line of lines) {
    const start=newOffset;newOffset+=Buffer.byteLength(line+'\n');if(!line)continue;
    const row=JSON.parse(line);if(row.sessionId && row.sessionId!==sessionId)throw new Error('CodeBuddy session mismatch');
    const text=Array.isArray(row.content)?row.content.filter((b:any)=>['input_text','output_text'].includes(b.type)&&typeof b.text==='string').map((b:any)=>b.text).join('\n'):'';
    if(row.type==='message' && row.role==='user' && row.providerData?.skipRun===true)continue;
    if(row.type==='message' && row.role==='user' && text && row.id) {
      finishFailure();
      held=undefined;events.push({uuid:row.id,timestampMs:row.timestamp,kind:'user',text,sourceSessionId:sessionId});
    }
    // Error records can precede native automatic recovery. Keep only the last
    // candidate until the exact Stop arrives; later assistant/tool activity
    // supersedes it, so a recovered error cannot close the turn prematurely.
    if(row.type==='message' && row.role==='assistant')failure=undefined;
    if(row.type==='message' && row.role==='assistant' && row.status==='incomplete' &&
        row.sessionId===sessionId && typeof row.id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(row.id) && Number.isFinite(row.timestamp) &&
        row.providerData?.skipRun===true && typeof row.providerData.error?.message==='string' && row.providerData.error.message.trim()) {
      const errorText=text || row.providerData.error.message;
      held??=start;
      failure={requestId:row.providerData.conversationRequestId,event:{uuid:row.id,timestampMs:row.timestamp,kind:'assistant_final',text:errorText,sourceSessionId:sessionId,
        terminalStatus:'failed',terminalErrorCode:'codebuddy_error',terminalErrorSummary:errorText}};
    }
    if(row.type==='message' && row.role==='assistant' && row.status==='completed' && text && /^[a-zA-Z0-9_-]{1,128}$/.test(row.id)) {
      const stop=readStop(file,sessionId,row.id);
      if(stop) {
        held=undefined;events.push({uuid:row.id,timestampMs:row.timestamp,kind:'assistant_final',text,sourceSessionId:sessionId,terminalStatus:stop==='Stop'?'completed':'failed'});
      } else held??=start;
    }
    if(['function_call','function_call_result','reasoning'].includes(row.type))failure=undefined;
    if(row.type==='function_call')held=undefined;
    if(row.type==='function_call_result' && row.status==='incomplete' && row.providerData?.skipRun===true) {
      held=undefined;events.push({uuid:row.id,timestampMs:row.timestamp,kind:'assistant_final',text:'原生操作已被中断。',sourceSessionId:sessionId,terminalStatus:'ambiguous',terminalErrorCode:'codebuddy_interrupted'});
    }
  }
  finishFailure();
  return {events,newOffset:held??newOffset,pendingTail};
}
