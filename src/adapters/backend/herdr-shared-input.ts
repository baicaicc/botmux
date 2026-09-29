import {spawn,execFileSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {basename,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {claudeDataDirForPid} from '../../services/claude-data-dir.js';
import {codebuddySession,codebuddyTranscript,drainCodeBuddyTranscript} from '../../services/codebuddy-transcript.js';
import {codebuddyActionPrompt} from '../../services/codebuddy-action-prompt.js';
import xterm from '@xterm/headless';

/** A short-lived controller for one externally owned HERDR submission.
 * Acquiring ownership never uses takeover. The source terminal/Agent is never
 * terminated; release kills only this stream client. */
export class HerdrSharedInput {
  private child?: ChildProcessWithoutNullStreams;
  private source = '';
  private terminalId = '';
  private alive = false;
  private wrote = false;
  private status = 'unknown';
  private codebuddyPid?:number;
  private codex=false;
  constructor(private session: string,private pane: string) {}
  private inspect(): string {
    const call=(args:string[])=>JSON.parse(execFileSync('herdr',['--session',this.session,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}));
    const pane=call(['pane','get',this.pane]).result?.pane;
    const info=call(['pane','process-info','--pane',this.pane]).result?.process_info;
    const processes=info?.foreground_processes?.map((p:any)=>({...p,argv:Array.isArray(p.argv)?p.argv:[p.argv0]})).filter((p:any)=>Array.isArray(p.argv) && p.argv.some((arg:unknown)=>typeof arg==='string' && ['claude','codex','codebuddy'].includes(basename(arg))));
    if(!pane?.terminal_id || !Array.isArray(processes) || processes.length!==1 || processes.every((p:any)=>p.pid===info.shell_pid))throw new Error('原 Agent 已断开；未向 shell 输入。');
    const identities=processes.map((p:any)=>({pid:p.pid,start:execFileSync('ps',['-p',String(p.pid),'-o','lstart='],{encoding:'utf8',timeout:3000}).trim(),argv:p.argv}));
    if(identities.some(p=>!p.start))throw new Error('原 Agent 身份无法核验。');
    if(this.terminalId && this.terminalId!==pane.terminal_id)throw new Error('原终端已变化。');
    this.terminalId=pane.terminal_id;
    this.status=pane.agent_status || 'unknown';
    this.codebuddyPid=processes[0].argv.some((a:string)=>basename(a)==='codebuddy')?processes[0].pid:undefined;
    this.codex=processes[0].argv.some((a:string)=>basename(a)==='codex');
    let nativeSessionId;
    try {nativeSessionId=this.codebuddyPid?codebuddySession(this.codebuddyPid)?.sessionId:JSON.parse(readFileSync(join(claudeDataDirForPid(processes[0].pid),'sessions',`${processes[0].pid}.json`),'utf8')).sessionId;}catch{}
    return JSON.stringify({terminal:this.terminalId,cwd:pane.cwd,identities,nativeSessionId});
  }
  pin():number|undefined {this.source=this.inspect();return this.codebuddyPid;}
  getTerminalId():string {this.verify();return this.terminalId;}
  verify():void {if(this.inspect()!==this.source)throw new Error('原 Agent 身份已变化。');}
  private refusal(message:string,screen?:string):Error {
    if(!this.codebuddyPid)return new Error(message);
    try {
      this.verify();
      screen ??= execFileSync('herdr',['--session',this.session,'pane','read',this.pane,'--source','visible','--format','text'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});
      this.verify();
      const prompt=codebuddyActionPrompt(screen);
      if(prompt)return new Error(`${message}\n${prompt}`);
    }catch{}
    return new Error(message);
  }
  async acquire():Promise<void> {
    if(!this.source || this.inspect()!==this.source)throw new Error('原 Agent 已退出或被替换；消息保留，未发送。');
    this.wrote=false;
    if(['working','blocked'].includes(this.status))throw this.refusal('原 Agent 正在工作或等待交互；消息保留，未发送。');
    if(this.codebuddyPid) {
      const meta=codebuddySession(this.codebuddyPid);if(!meta)throw new Error('CodeBuddy 原生身份未确认。');
      const file=codebuddyTranscript(meta.sessionId,meta.cwd);
      if(file) {const events=drainCodeBuddyTranscript(file,0).events;
        if(events.length && events.at(-1)?.kind!=='assistant_final')throw new Error('CodeBuddy 当前轮次尚未确认结束；消息保留，未发送。');}
    }
    const child=spawn('herdr',['--session',this.session,'terminal','session','control',this.terminalId,'--cols','120','--rows','40'],{stdio:['pipe','pipe','pipe']});
    this.child=child;this.alive=true;
    child.stderr.resume();
    child.stdin.on('error',()=>{this.alive=false;});
    child.on('exit',()=>{this.alive=false;});child.on('error',()=>{this.alive=false;});
    const terminal=new xterm.Terminal({cols:120,rows:40,allowProposedApi:true});
    try {
      await new Promise<void>((resolve,reject)=>{
        let accepted=false,finished=false;const started=Date.now();
        const timer=setTimeout(()=>done(new Error('无法取得 HERDR 操作权；消息保留，未发送。')),5000);
        let settle:ReturnType<typeof setTimeout>|undefined;
        const done=(error?:Error)=>{finished=true;clearTimeout(timer);clearTimeout(settle);error?reject(error):resolve();};
        child.once('exit',()=>done(new Error('输入由其他入口占用；消息保留，未发送。')));
        child.once('error',()=>done(new Error('HERDR 操作连接失败；消息保留，未发送。')));
        const lines=createInterface({input:child.stdout});
        lines.on('line',line=>{
          let frame;try{frame=JSON.parse(line);}catch{return;}
          if(frame.type==='terminal.closed'){this.alive=false;return done(new Error('无法取得 HERDR 操作权（连接已关闭或被其他入口占用）；消息保留，未发送。'));}
          if(frame.type!=='terminal.frame' || typeof frame.bytes!=='string' || finished)return;
          terminal.write(Buffer.from(frame.bytes,'base64'));
          if(accepted)return;
          accepted=true;
          // Control resize may first replay the previous viewer's wider screen.
          // Render the following redraw before inspecting the composer; never
          // write while waiting, and retain the same conservative draft checks.
          const inspectComposer=()=>{if(finished)return;terminal.write('',()=>{
            if(finished)return;
            const buffer=terminal.buffer.active;
            const rows=Array.from({length:terminal.rows},(_,i)=>buffer.getLine(buffer.viewportY+i)?.translateToString(true)||'');
            const clean=rows.map(row=>row.trim());
            const separator=(line:string)=>/^[─━═╌-]{10,}$/.test(line);
            const emptyComposer=clean.some((line,i)=>{
              if(this.codex && i===terminal.rows-3 && clean[i-1]==='' && clean[i+1]==='' && /^›(?: Ask Codex to do anything)?$/.test(line)) {
                const row=buffer.getLine(buffer.viewportY+i);
                return !!row && Array.from({length:terminal.cols-2},(_,x)=>row.getCell(x+2)).every(cell=>!cell?.getChars().trim() || cell.isDim()!==0);
              }
              if(!separator(clean[i-1]||'') || !separator(clean[i+1]||''))return false;
              if(/^[❯>]$/.test(line))return true;
              // CodeBuddy 2.137.1 paints its empty-composer suggestion dim,
              // with a synthetic cursor at cell 2 and a literal ↵ send hint.
              // Real drafts are not dim. Unknown styles remain blocked.
              if(!this.codebuddyPid || !/^> .+↵ send$/.test(line))return false;
              const row=buffer.getLine(buffer.viewportY+i);if(!row)return false;
              const cells=Array.from({length:terminal.cols},(_,x)=>row.getCell(x));
              const arrow=cells.findIndex(cell=>cell?.getChars()==='↵'),cursor=cells[2];
              return arrow>3 && cursor?.getFgColor()===0 && cursor?.getBgColor()===0xffffff &&
                cells.slice(3,arrow).every(cell=>!cell?.getChars().trim() || cell.isDim()!==0);
            });
            // Fail closed on drafts, permission pickers, multiline composers,
            // slash menus and unrecognized UI. Idle alone is insufficient.
            if(!emptyComposer && Date.now()-started<1500){settle=setTimeout(inspectComposer,100);return;}
            finished=true;
            if(!emptyComposer)return done(this.refusal('原终端有草稿、权限对话框或尚未就绪；消息保留，未发送。',rows.join('\n')));
            try {if(this.inspect()!==this.source)throw new Error('原 Agent 身份已变化。');done();}catch(error){done(error as Error);}
          });};
          settle=setTimeout(inspectComposer,250);
        });
      });
    } catch(error) {await this.release();throw error;}
    finally{terminal.dispose();}
  }
  write(text:string):boolean {
    if(!this.alive || !this.child || this.inspect()!==this.source)throw new Error('输入连接或源进程已变化；发送结果需核验，未自动重发。');
    this.wrote=true;
    this.child.stdin.write(JSON.stringify({type:'terminal.input',text})+'\n');return true;
  }
  text(text:string):boolean{return this.write(`\x1b[200~${text}\x1b[201~`);}
  keys(keys:string[]):boolean {
    const bytes:Record<string,string>={Enter:'\r',Escape:'\x1b','C-c':'\x03',Tab:'\t',Up:'\x1b[A',Down:'\x1b[B'};
    if(keys.some(key=>bytes[key]===undefined))throw new Error('共享终端不支持这个按键；未发送。');
    return this.write(keys.map(key=>bytes[key]).join(''));
  }
  get inputStarted():boolean{return this.wrote;}
  async release():Promise<void> {
    const child=this.child,wasAlive=this.alive;this.alive=false;this.child=undefined;
    if(!child)return;
    if(!wasAlive){child.stdin.end();return;}
    // EOF is processed after every queued input frame and sends HERDR Detach.
    // Killing immediately could discard the just-written Enter.
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{child.kill('SIGTERM');resolve();},1000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
      child.stdin.end(JSON.stringify({type:'terminal.release'})+'\n');
    });
  }
}
