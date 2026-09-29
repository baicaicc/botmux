/** A narrow, read-only projection of CodeBuddy's own permission picker.
 * Never copy the tool arguments or arbitrary terminal output into Lark. */
const TITLES = ['Bash command', 'PowerShell command', 'Read file', 'Create file', 'Edit file', 'Multi Edit file', 'Fetch', 'Tool use'];

export function codebuddyActionPrompt(screen: string): string | undefined {
  const lines = screen.trimEnd().split('\n').slice(-35).map(line => line.replace(/[│┃╭╮╰╯┌┐└┘─━]/g, ' ').trim());
  let questionIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === 'Do you trust the files in this folder?' || /^(?:Do you want to proceed|Do you want to allow CodeBuddy to fetch this content|Do you want to (?:create|make|multi edit) .+)\?/i.test(lines[i])) {
      questionIndex = i;
      break;
    }
  }
  if (questionIndex < 0) return;
  const directoryTrust = lines[questionIndex] === 'Do you trust the files in this folder?';
  const title = directoryTrust ? '目录信任' : TITLES.find(item => lines.slice(Math.max(0, questionIndex - 15), questionIndex + 1).some(line => line === item));
  if (!title) return;
  const choices = lines.slice(questionIndex + 1).map(line => /^[>❯●]?\s*([1-4])\.\s+(.{1,100})$/.exec(line)).filter((match): match is RegExpExecArray => !!match);
  if (choices.length < 2 || choices[0][1] !== '1' || choices[1][1] !== '2') return;
  if (directoryTrust && (!/^Trust folder only \(.+\)$/.test(choices[0][2]) ||
      !choices.some(match => /^No, exit(?: \(escape\))?$/.test(match[2])))) return;
  const question = lines[questionIndex].slice(0, 180);
  return `CodeBuddy 正等待你确认「${title}」：${question}\n${choices.slice(0, 4).map(match => `${match[1]}. ${match[2]}`).join('\n')}\n请在原终端核对具体操作后选择。本机 HERDR 命名会话：botmux（herdr session attach botmux）。`;
}
