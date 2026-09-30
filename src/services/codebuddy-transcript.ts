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
function readStop(file:string,sessionId:string,generationId:unknown,notBefore?:number):'Stop'|'StopFailure'|undefined {
  if(typeof generationId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(generationId))return;
  try {
    const stop=JSON.parse(readFileSync(join(file.replace(/\.jsonl$/,'.allinone-stops'),`${generationId}.json`),'utf8'));
    if(stop?.sessionId===sessionId && stop.generationId===generationId && ['Stop','StopFailure'].includes(stop.event)) {
      if(notBefore!==undefined && (!Number.isFinite(notBefore) || typeof stop.observedAt!=='string' ||
          !Number.isFinite(Date.parse(stop.observedAt)) || Date.parse(stop.observedAt)<notBefore))return;
      return stop.event;
    }
  }catch{}
}
/** Offset remains at an unconfirmed assistant until its exact Stop hook arrives.
 * It cannot be promoted to a final by a quiet/idle screen. AllInOne's launcher
 * writes only the hook's native generation id, which CLI 2.137.1 reports as the
 * final assistant id. CLI 2.159.0 provider failures and CLI 2.160.0 successful
 * turns instead use the request id. A successful request-wide Stop must be
 * observed after its last assistant candidate; later tool/reasoning/assistant
 * activity supersedes that candidate rather than prematurely closing a turn. */
export function drainCodeBuddyTranscript(file:string,offset:number) {
  const bytes=readFileSync(file),sessionId=basename(file,'.jsonl');
  if(!uuid.test(sessionId) || offset>bytes.length)throw new Error('CodeBuddy transcript identity changed');
  const tail=bytes.subarray(offset).toString('utf8'),lines=tail.split('\n');const pendingTail=lines.pop()!;
  const events:CodeBuddyBridgeEvent[]=[];let newOffset=offset,held:number|undefined;
  // A held assistant can be revisited without its earlier user row in the tail.
  // Recover the last native user request before the offset so retries retain
  // the same correlation guard instead of accepting an unrelated request Stop.
  let userRequestId:unknown;
  const prefix=bytes.subarray(0,offset).toString('utf8').trimEnd().split('\n');
  for(let i=prefix.length-1;i>=0;i--) {
    if(!prefix[i])continue;
    const row=JSON.parse(prefix[i]);
    if(row.type==='message' && row.role==='user' && row.providerData?.skipRun!==true) {
      if(!row.sessionId || row.sessionId===sessionId)userRequestId=row.providerData?.conversationRequestId;
      break;
    }
  }
  let failure:{event:CodeBuddyBridgeEvent;requestId:unknown}|undefined;
  let success:{event:CodeBuddyBridgeEvent;requestId:unknown}|undefined;
  const finishFailure=()=>{
    if(failure && (readStop(file,sessionId,failure.event.uuid) || readStop(file,sessionId,failure.requestId))) {
      held=undefined;events.push(failure.event);
    }
    failure=undefined;
  };
  const finishSuccess=()=>{
    if(success) {
      const stop=readStop(file,sessionId,success.requestId,success.event.timestampMs);
      if(stop) {held=undefined;events.push({...success.event,terminalStatus:stop==='Stop'?'completed':'failed'});}
    }
    success=undefined;
  };
  for(const line of lines) {
    const start=newOffset;newOffset+=Buffer.byteLength(line+'\n');if(!line)continue;
    const row=JSON.parse(line);if(row.sessionId && row.sessionId!==sessionId)throw new Error('CodeBuddy session mismatch');
    const text=Array.isArray(row.content)?row.content.filter((b:any)=>['input_text','output_text'].includes(b.type)&&typeof b.text==='string').map((b:any)=>b.text).join('\n'):'';
    if(row.type==='message' && row.role==='user' && row.providerData?.skipRun===true)continue;
    if(row.type==='message' && row.role==='user' && text && row.id) {
      finishFailure();finishSuccess();
      userRequestId=row.providerData?.conversationRequestId;
      held=undefined;events.push({uuid:row.id,timestampMs:row.timestamp,kind:'user',text,sourceSessionId:sessionId});
    }
    // Error records can precede native automatic recovery. Keep only the last
    // candidate until the exact Stop arrives; later assistant/tool activity
    // supersedes it, so a recovered error cannot close the turn prematurely.
    if(row.type==='message' && row.role==='assistant'){failure=undefined;success=undefined;}
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
      } else {
        held??=start;
        if(row.sessionId===sessionId && Number.isFinite(row.timestamp) &&
            (userRequestId===undefined || userRequestId===row.providerData?.conversationRequestId))success={requestId:row.providerData?.conversationRequestId,
          event:{uuid:row.id,timestampMs:row.timestamp,kind:'assistant_final',text,sourceSessionId:sessionId}};
      }
    }
    if(['function_call','function_call_result','reasoning'].includes(row.type)){failure=undefined;success=undefined;}
    if(row.type==='function_call')held=undefined;
    if(row.type==='function_call_result' && row.status==='incomplete' && row.providerData?.skipRun===true) {
      held=undefined;events.push({uuid:row.id,timestampMs:row.timestamp,kind:'assistant_final',text:'原生操作已被中断。',sourceSessionId:sessionId,terminalStatus:'ambiguous',terminalErrorCode:'codebuddy_interrupted'});
    }
  }
  finishFailure();finishSuccess();
  return {events,newOffset:held??newOffset,pendingTail};
}
