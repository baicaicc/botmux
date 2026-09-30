import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: string[], descriptor = false) {
  const home = mkdtempSync(join(tmpdir(), 'botmux-independent-cli-'));
  const data = join(home, '.botmux', 'data');
  mkdirSync(join(data, 'dashboard-daemons'), { recursive: true });
  const sentinel = join(home, 'sentinel');
  writeFileSync(sentinel, 'preserved');
  if (descriptor) {
    writeFileSync(join(home, '.botmux', 'bots.json'), JSON.stringify([{ larkAppId: 'fixture-bot', larkAppSecret: 'fixture-only', cliId: 'codex' }]));
    // This live PID belongs to a test process, not an index-daemon owner.
    writeFileSync(join(data, 'dashboard-daemons', 'fixture-bot.json'), JSON.stringify({
      larkAppId: 'fixture-bot', ipcPort: 19001, pid: process.pid, lastHeartbeat: Date.now(), botName: 'Fixture',
    }));
  }
  const { command, prefixArgs } = tsRunnerPrefix();
  try {
    const env = { ...process.env, HOME: home, SESSION_DATA_DIR: data, BOTS_CONFIG: join(home, '.botmux', 'bots.json') };
    delete env.BOTMUX_WORKFLOW;
    const result = spawnSync(command, [...prefixArgs, cli, ...args], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15_000 });
    return { ...result, sentinel: readFileSync(sentinel, 'utf8') };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('independent daemon CLI entry', () => {
  it('shows an unrelated live PID as offline instead of daemon online', () => {
    const result = run(['status'], true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('独立 daemon: 0/1 在线');
    expect(result.stdout).toContain('offline');
    expect(result.stdout).not.toContain('daemon 未在运行');
    expect(result.sentinel).toBe('preserved');
  });

  it('accepts restart --bot without silently restarting all configured Bots', () => {
    const result = run(['restart', '--bot', '0'], true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('未知参数');
    expect(result.stderr).toContain('未执行重启');
    expect(result.stdout).not.toContain('daemon 已重启');
    expect(result.sentinel).toBe('preserved');
  });

  it('refuses a missing --bot value before any restart dispatch', () => {
    const result = run(['restart', '--bot']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--bot');
    expect(result.stderr).toContain('直接中止');
    expect(result.sentinel).toBe('preserved');
  });
});
