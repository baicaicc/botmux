import {expect, it} from 'vitest';
import {codebuddyActionPrompt} from '../src/services/codebuddy-action-prompt.js';

it('projects a CodeBuddy permission picker without copying its command', () => {
  const screen = [
    '╭─ Bash command ─────────────────────────╮',
    '│ cat /private/credentials.txt           │',
    '│ Do you want to proceed?                │',
    '│ ❯ 1. Yes                               │',
    '│   2. Yes, and don\'t ask again for session │',
    '│   3. No                                │',
    '╰────────────────────────────────────────╯',
  ].join('\n');
  const prompt = codebuddyActionPrompt(screen);
  expect(prompt).toContain('Bash command');
  expect(prompt).toContain('1. Yes');
  expect(prompt).toContain('herdr session attach botmux');
  expect(prompt).not.toContain('/private/credentials.txt');
});

it('ignores arbitrary terminal text and incomplete choice lists', () => {
  expect(codebuddyActionPrompt('Do you want to proceed?\n1. Yes\n2. No')).toBeUndefined();
  expect(codebuddyActionPrompt('Bash command\nDo you want to proceed?\n1. Yes')).toBeUndefined();
});
