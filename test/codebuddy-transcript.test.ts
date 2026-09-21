import {it,expect} from 'vitest';import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {drainCodeBuddyTranscript} from '../src/services/codebuddy-transcript.js';
it('waits for the exact final Stop, then drains once; never forwards reasoning or intermediate tool text',()=>{
 const dir=mkdtempSync(join(tmpdir(),'codebuddy-bridge-')),sid='00000000-0000-4000-8000-000000000000',file=join(dir,`${sid}.jsonl`),stops=join(dir,`${sid}.allinone-stops`);
 const row=(id:string,role:string,text:string)=>({id,sessionId:sid,timestamp:1000,type:'message',role,status:'completed',content:[{type:role==='user'?'input_text':'output_text',text}]});
 try{
  const records=[{...row('exit','user','/exit'),providerData:{skipRun:true}},row('u','user','task'),row('intermediate','assistant','working'),{type:'function_call',sessionId:sid},{type:'reasoning',text:'private'},row('final','assistant','done')];
  writeFileSync(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');mkdirSync(stops);
  const first=drainCodeBuddyTranscript(file,0);expect(first.events.map(e=>e.text)).toEqual(['task']);
  writeFileSync(join(stops,'final.json'),JSON.stringify({sessionId:sid,generationId:'request-id',event:'Stop'}));
  expect(drainCodeBuddyTranscript(file,first.newOffset).events).toEqual([]);
  writeFileSync(join(stops,'final.json'),JSON.stringify({sessionId:sid,generationId:'final',event:'Stop'}));
  const next=drainCodeBuddyTranscript(file,first.newOffset);expect(next.events.map(e=>e.text)).toEqual(['done']);expect(drainCodeBuddyTranscript(file,next.newOffset).events).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
