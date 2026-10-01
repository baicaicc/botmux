import {afterEach, expect, it} from 'vitest';
import {appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {drainCodeBuddyTranscript} from '../src/services/codebuddy-transcript.js';
import {CodexBridgeQueue} from '../src/services/codex-bridge-queue.js';

const sid='00000000-0000-4000-8000-000000000000',dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const user={type:'message',role:'user',id:'user',sessionId:sid,timestamp:1000,content:[{type:'input_text',text:'read the QA file'}],providerData:{conversationRequestId:'request'}};
const assistant=(id:string,text:string,timestamp=2000)=>({type:'message',role:'assistant',status:'completed',id,sessionId:sid,timestamp,content:[{type:'output_text',text}],providerData:{conversationRequestId:'request'}});
const activity=(type:string)=>({type,id:type,sessionId:sid,timestamp:1500,providerData:{conversationRequestId:'request'}});
function fixture(rows:unknown[]){
 const dir=mkdtempSync(join(tmpdir(),'codebuddy-success-stop-'));dirs.push(dir);
 const file=join(dir,`${sid}.jsonl`),stops=join(dir,`${sid}.allinone-stops`);mkdirSync(stops);
 writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const stop=(generationId='request',observedAt=2500,event='Stop',sessionId=sid)=>writeFileSync(join(stops,`${generationId}.json`),JSON.stringify({sessionId,generationId,event,observedAt:new Date(observedAt).toISOString()}));
 return {file,stop};
}

it('recovers the native 2.160.0 request Stop after a permission-approved tool and emits the exact answer once',()=>{
 const {file,stop}=fixture([user,activity('function_call'),{...activity('function_call_result'),status:'completed'},assistant('answer','QA_NONCE'),{type:'summary'},{type:'turn-metrics'}]);
 const pending=drainCodeBuddyTranscript(file,0);expect(pending.events.map(e=>e.kind)).toEqual(['user']);
 stop();
 const final=drainCodeBuddyTranscript(file,pending.newOffset);
 expect(final.events).toEqual([expect.objectContaining({uuid:'answer',text:'QA_NONCE',terminalStatus:'completed'})]);
 expect(drainCodeBuddyTranscript(file,final.newOffset).events).toEqual([]);
 const queue=new CodexBridgeQueue();queue.mark('lark-message','read the QA file',900);
 queue.ingest([...pending.events,...final.events]);
 expect(queue.drainEmittable()).toEqual([expect.objectContaining({finalText:'QA_NONCE',terminalStatus:'completed'})]);
 expect(queue.drainEmittable()).toEqual([]);
});

it('does not forward intermediate assistant text when a request includes another tool and final answer',()=>{
 const {file,stop}=fixture([user,assistant('intermediate','I will read it',1200),activity('function_call'),activity('function_call_result'),activity('reasoning'),assistant('answer','QA_NONCE')]);
 stop();
 expect(drainCodeBuddyTranscript(file,0).events.map(e=>e.text)).toEqual(['read the QA file','QA_NONCE']);
});

it.each(['function_call','function_call_result','reasoning'])('supersedes the success candidate on later %s activity',type=>{
 const {file,stop}=fixture([user,assistant('intermediate','still working'),activity(type)]);stop();
 expect(drainCodeBuddyTranscript(file,0).events.map(e=>e.kind)).toEqual(['user']);
});

it('supersedes the success candidate on a later assistant without completed output',()=>{
 const {file,stop}=fixture([user,assistant('intermediate','still working'),{...assistant('next',''),status:'incomplete'}]);stop();
 expect(drainCodeBuddyTranscript(file,0).events.map(e=>e.kind)).toEqual(['user']);
});

it('rejects an earlier Stop, foreign session, and unrelated generation',()=>{
 const {file,stop}=fixture([user,assistant('answer','QA_NONCE')]);
 stop('request',1999);expect(drainCodeBuddyTranscript(file,0).events.map(e=>e.kind)).toEqual(['user']);
 stop('request',2500,'Stop','00000000-0000-4000-8000-000000000001');expect(drainCodeBuddyTranscript(file,0).events.map(e=>e.kind)).toEqual(['user']);
 stop('another-request');expect(drainCodeBuddyTranscript(file,0).events.map(e=>e.kind)).toEqual(['user']);
 stop();expect(drainCodeBuddyTranscript(file,0).events.at(-1)?.text).toBe('QA_NONCE');
});

it('rejects a completed assistant from a different known user request, including offset retries',()=>{
 const {file,stop}=fixture([user,{...assistant('answer','foreign result'),providerData:{conversationRequestId:'foreign-request'}}]);
 stop('foreign-request');
 const pending=drainCodeBuddyTranscript(file,0);expect(pending.events.map(e=>e.kind)).toEqual(['user']);
 expect(drainCodeBuddyTranscript(file,pending.newOffset).events).toEqual([]);
});

it('supports legacy user rows without a request id when the successful assistant has exact native Stop proof',()=>{
 const {file,stop}=fixture([{...user,providerData:{}},assistant('answer','QA_NONCE')]);stop();
 expect(drainCodeBuddyTranscript(file,0).events.at(-1)?.text).toBe('QA_NONCE');
});

it('holds a partial final record until complete and preserves the next user boundary',()=>{
 const {file,stop}=fixture([user]);const encoded=JSON.stringify(assistant('answer','QA_NONCE'));
 appendFileSync(file,encoded.slice(0,45));
 const pending=drainCodeBuddyTranscript(file,0);expect(pending.events.map(e=>e.kind)).toEqual(['user']);
 stop();appendFileSync(file,encoded.slice(45)+'\n'+JSON.stringify({...user,id:'next-user',timestamp:3000,providerData:{conversationRequestId:'next-request'}})+'\n');
 const done=drainCodeBuddyTranscript(file,pending.newOffset);
 expect(done.events.map(e=>e.kind)).toEqual(['assistant_final','user']);
 expect(drainCodeBuddyTranscript(file,done.newOffset).events).toEqual([]);
});

it('preserves native StopFailure as failed for a completed success candidate',()=>{
 const {file,stop}=fixture([user,assistant('answer','QA_NONCE')]);stop('request',2500,'StopFailure');
 expect(drainCodeBuddyTranscript(file,0).events.at(-1)?.terminalStatus).toBe('failed');
});
