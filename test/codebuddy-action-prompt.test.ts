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

it('projects the native directory trust question and its choices without the directory body', () => {
  const prompt = codebuddyActionPrompt([
    'Do you trust the files in this folder?', '/private/test-location',
    'CodeBuddy may read, write, or execute files contained in this directory.',
    '> 1. Trust folder only (workspace)',
    '  2. Trust parent folder (parent/**)',
    '  3. Trust folder and all subdirectories (workspace/**)',
    '  4. No, exit (escape)', 'Enter to confirm • Esc to exit',
  ].join('\n'));
  expect(prompt).toContain('目录信任');
  expect(prompt).toContain('Do you trust the files in this folder?');
  expect(prompt).toContain('4. No, exit (escape)');
  expect(prompt).toContain('herdr session attach botmux');
  expect(prompt).not.toContain('/private/test-location');
});

it('does not project a partial directory trust picker or unrelated numbered text', () => {
  expect(codebuddyActionPrompt('Do you trust the files in this folder?\n1. Yes\n2. No')).toBeUndefined();
  expect(codebuddyActionPrompt('Do you trust the files in this folder?\n1. Trust folder only (workspace)\n2. Trust parent folder (parent/**)')).toBeUndefined();
});
