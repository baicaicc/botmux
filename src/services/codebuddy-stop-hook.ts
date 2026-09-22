import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

// Native Stop is the end-of-turn evidence used by the existing transcript reader.
// Keep the on-disk format shared with AllInOne; a completed assistant row alone
// can precede another tool call and must not be promoted to a final answer.
try {
  const [sessionId,cwd] = process.argv.slice(2);
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) throw new Error('too large');
  }
  const event = JSON.parse(input);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !cwd?.startsWith('/') || event.session_id !== sessionId ||
      !['Stop','StopFailure'].includes(event.hook_event_name) || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.generation_id ?? '')) throw new Error('unverified event');
  const directory = join(homedir(), '.codebuddy', 'projects', cwd.replace(/^\/+/, '').replaceAll('/', '-'), `${sessionId}.allinone-stops`);
  mkdirSync(directory, {recursive:true,mode:0o700});
  const target = join(directory, `${event.generation_id}.json`), temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({sessionId,generationId:event.generation_id,event:event.hook_event_name,observedAt:new Date().toISOString()}), {mode:0o600});
  renameSync(temporary,target);
} catch {
  // Failed observation never changes or interrupts the user's native session.
}
