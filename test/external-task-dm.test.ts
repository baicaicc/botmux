import {test,expect} from 'bun:test';
import {isExternalTaskDm} from '../src/im/lark/external-task-dm';
const env={BOTMUX_EXTERNAL_DM_APP_ID:'app',BOTMUX_EXTERNAL_DM_CHAT_ID:'dm'};
test('external desktop inbox suppresses only its exact bot and private chat',()=>{
 expect(isExternalTaskDm('app',{chat_type:'p2p',chat_id:'dm'},env)).toBe(true);
 expect(isExternalTaskDm('other',{chat_type:'p2p',chat_id:'dm'},env)).toBe(false);
 expect(isExternalTaskDm('app',{chat_type:'group',chat_id:'dm'},env)).toBe(false);
 expect(isExternalTaskDm('app',{chat_type:'p2p',chat_id:'other'},env)).toBe(false);
 expect(isExternalTaskDm('app',{chat_type:'p2p',chat_id:'dm'},{})).toBe(false);
});
