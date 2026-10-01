import {describe,it,expect,vi,beforeEach} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
vi.mock('node:child_process',()=>({execFileSync:vi.fn(),spawn:vi.fn()}));
vi.mock('../src/services/codebuddy-transcript.js',()=>({
 codebuddySession:()=>({sessionId:'00000000-0000-4000-8000-000000000001',cwd:'/work'}),
 codebuddyTranscript:()=>undefined,
 drainCodeBuddyTranscript:()=>({events:[]}),
}));
import {execFileSync,spawn} from 'node:child_process';
import {HerdrSharedInput} from '../src/adapters/backend/herdr-shared-input.js';
let pid:number,status:string,frame:string,child:any,cli:string,readScreen:string;
const trustScreen=['Do you trust the files in this folder?','/private/test-location',
 '> 1. Trust folder only (workspace)','  2. Trust parent folder (parent/**)',
 '  3. Trust folder and all subdirectories (workspace/**)','  4. No, exit (escape)',
 'Enter to confirm • Esc to exit'].join('\r\n');
beforeEach(()=>{
 vi.clearAllMocks();
 pid=42;status='done';cli='claude';readScreen='';frame='\x1b[2J\x1b[H'+'─'.repeat(40)+'\r\n> \r\n'+'─'.repeat(40);
 vi.mocked(execFileSync).mockImplementation(((bin:string,args:string[])=>bin==='ps'?'Mon Sep 21 02:00:00 2026':args.includes('read')?readScreen:JSON.stringify(args.includes('process-info')?{result:{process_info:{shell_pid:1,foreground_processes:[{pid,argv:[cli]}]}}}:{result:{pane:{terminal_id:'original',cwd:'/work',agent_status:status}}})) as any);
 vi.mocked(spawn).mockImplementation((()=>{child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn(()=>{child.emit('exit',0);return true;})});child.stdin.on('finish',()=>child.emit('exit',0));setImmediate(()=>child.stdout.write(JSON.stringify({type:'terminal.frame',bytes:Buffer.from(frame).toString('base64')})+'\n'));return child;}) as any);
});
describe('shared HERDR input',()=>{
 it('includes CodeBuddy directory choices when the composer blocks submission, without writing input',async()=>{
  cli='codebuddy';status='unknown';frame='\x1b[2J\x1b[H'+trustScreen;
  const input=new HerdrSharedInput('botmux','w1:p1');input.pin();
  await expect(input.acquire()).rejects.toThrow(/消息保留，未发送[\s\S]*目录信任[\s\S]*1\. Trust folder only[\s\S]*4\. No, exit/);
  expect(input.inputStarted).toBe(false);
  expect(child.stdin.read()?.toString()).toBe(JSON.stringify({type:'terminal.release'})+'\n');
 });
 it('reads a blocked CodeBuddy picker without acquiring control or copying its tool arguments',async()=>{
  cli='codebuddy';status='blocked';readScreen='Create file\n/private/tool-argument\nDo you want to create this file?\n1. Yes\n2. No';
  const input=new HerdrSharedInput('botmux','w1:p1');input.pin();
  const error=await input.acquire().catch(error=>error);
  expect(error.message).toContain('Create file');expect(error.message).toContain('2. No');
  expect(error.message).not.toContain('/private/tool-argument');
  expect(spawn).not.toHaveBeenCalled();expect(input.inputStarted).toBe(false);
 });
 it('Codex accepts a dim native placeholder but refuses the same words as a real draft',async()=>{
  cli='codex';frame='\x1b[2J\x1b[38;1H› \x1b[2mAsk Codex to do anything\x1b[0m\r\n\r\n  gpt-6';
  const input=new HerdrSharedInput('shared','w1:p1');input.pin();await input.acquire();await input.release();
  frame=frame.replace('\x1b[2m','');await expect(input.acquire()).rejects.toThrow('草稿');
 });
 it('waits for a delayed resize redraw without writing input',async()=>{
  frame='\x1b[2J\x1b[Hprevious wide screen';
  const input=new HerdrSharedInput('shared','w1:p1');input.pin();const acquired=input.acquire();
  await new Promise(resolve=>setTimeout(resolve,500));
  child.stdout.write(JSON.stringify({type:'terminal.frame',bytes:Buffer.from('\x1b[2J\x1b[H'+'─'.repeat(40)+'\r\n> \r\n'+'─'.repeat(40)).toString('base64')})+'\n');
  await acquired;expect(input.inputStarted).toBe(false);await input.release();
 });
 it('acquires without takeover and releases only its own client',async()=>{
  const input=new HerdrSharedInput('shared','w1:p1');input.pin();await input.acquire();
  let written='';child.stdin.on('data',(v:Buffer)=>written+=v);input.text('line1\nline2');input.keys(['Enter']);await input.release();
  expect(written).toContain('line1\\nline2');expect(child.kill).not.toHaveBeenCalled();expect(written).toContain('terminal.release');
  expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain('--takeover');
 });
 it('reports a closed control connection as not sent and writes no input',async()=>{
  vi.mocked(spawn).mockImplementation((()=>{child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});setImmediate(()=>child.stdout.write(JSON.stringify({type:'terminal.closed'})+'\n'));return child;}) as any);
  const input=new HerdrSharedInput('shared','w1:p1');input.pin();
  await expect(input.acquire()).rejects.toThrow('消息保留，未发送');expect(input.inputStarted).toBe(false);expect(child.stdin.read()).toBeNull();
 });
 it('refuses drafts without altering or submitting them',async()=>{
  frame=frame.replace('> ', '> LOCAL_DRAFT');const input=new HerdrSharedInput('shared','w1:p1');input.pin();
  await expect(input.acquire()).rejects.toThrow('草稿');expect(child.stdin.read()?.toString()).toBe(JSON.stringify({type:'terminal.release'})+'\n');
 });
 it('refuses permission/working state and a substituted source before any write',async()=>{
  const input=new HerdrSharedInput('shared','w1:p1');input.pin();status='blocked';await expect(input.acquire()).rejects.toThrow('等待交互');
  status='done';pid=99;await expect(input.acquire()).rejects.toThrow('替换');expect(spawn).not.toHaveBeenCalled();
 });
});
