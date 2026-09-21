import { describe, expect, test } from 'bun:test';
import { isSharedOnlyBot, needsSharedSessionPicker } from '../src/core/shared-only.js';
const env = { BOTMUX_SHARED_ONLY_APP_ID: 'allinone' };
describe('externally managed native sessions', () => {
  test('unbound fresh and failed topics offer a picker; bound topics keep their route', () => {
    expect(needsSharedSessionPicker('allinone', '嗨', undefined, env)).toBe(true);
    expect(needsSharedSessionPicker('allinone', '嗨', { session: {} }, env)).toBe(true);
    expect(needsSharedSessionPicker('allinone', '继续', { session: {}, adoptedFrom: { herdrPaneId: 'w1:p1' } }, env)).toBe(false);
    expect(needsSharedSessionPicker('allinone', '继续', { session: { existingAppServerEndpoint: 'ws://127.0.0.1:4329' } }, env)).toBe(false);
  });
  test('commands remain explicit and other apps retain normal launch behavior', () => {
    expect(needsSharedSessionPicker('allinone', '/adopt herdr:default:w1:p1', undefined, env)).toBe(false);
    expect(needsSharedSessionPicker('other', '嗨', undefined, env)).toBe(false);
    expect(isSharedOnlyBot('allinone', {})).toBe(false);
    expect(isSharedOnlyBot(undefined, env)).toBe(false);
  });
});
