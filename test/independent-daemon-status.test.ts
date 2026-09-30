import { describe, expect, it, vi } from 'vitest';
import {
  formatIndependentDaemonStatus, inspectIndependentDaemonProcess, parseLaunchdJobs, readIndependentDaemonStatus,
  readIndependentLaunchdLogPaths, restartIndependentLaunchdDaemons, selectIndependentRestartTargets,
  type IndependentDaemonStatus, type IndependentLaunchdRestartRuntime,
} from '../src/cli/independent-daemon-status.js';
import type { FleetProcessInspection } from '../src/core/fleet-process-identity.js';

const exact = (pid: number, processStart = 'birth-old'): FleetProcessInspection => ({
  status: 'exact', attestation: { pid, processStart },
});
const row = (appId = 'bot-a', pid = 100): IndependentDaemonStatus => ({
  appId, name: appId, cliId: 'codex', pid, ipcPort: 49973, status: 'online',
  launchdLabel: `com.example.${appId}`, processStart: `birth-${pid}`, bootInstanceId: `boot-${pid}`,
});

describe('independent daemon status', () => {
  it('uses the explicit data directory and requires both fresh heartbeat and daemon identity', () => {
    const discover = vi.fn(() => [
      { larkAppId: 'a', ipcPort: 9001, pid: 100, lastHeartbeat: 100_000, botName: '\u001b[31mBot\n A', cliId: 'codex' },
      { larkAppId: 'b', ipcPort: 9002, pid: 101, lastHeartbeat: 100_000 },
      { larkAppId: 'c', ipcPort: 9003, pid: 102, lastHeartbeat: 1 },
      { larkAppId: 'd', ipcPort: 9004, pid: 103, lastHeartbeat: 500_000 },
    ]);
    const rows = readIndependentDaemonStatus('/explicit-data', {
      discover, now: () => 100_000, launchdJobs: () => new Map([[100, 'com.example.bot']]),
      inspect: pid => pid === 101 ? { status: 'stale' } : exact(pid),
    });
    expect(discover).toHaveBeenCalledWith('/explicit-data');
    expect(rows.map(r => r.status)).toEqual(['online', 'offline', 'unknown', 'unknown']);
    expect(rows[0]).toMatchObject({ launchdLabel: 'com.example.bot', processStart: 'birth-old' });
    expect(formatIndependentDaemonStatus(rows).join('\n')).toContain('1/4 在线');
    expect(formatIndependentDaemonStatus(rows).join('\n')).not.toContain('\u001b');
  });

  it('does not report unverifiable or duplicate PIDs as online', () => {
    const rows = readIndependentDaemonStatus('/data', {
      discover: () => [100, 100, 101].map((pid, i) => ({ larkAppId: String(i), ipcPort: 9000 + i, pid, lastHeartbeat: 10 })),
      now: () => 10, launchdJobs: () => new Map(),
      inspect: pid => pid === 101 ? { status: 'unverifiable' } : exact(pid),
    });
    expect(rows.map(r => r.status)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('parses only running launchd job labels and refuses path-shaped labels', () => {
    expect([...parseLaunchdJobs('PID Status Label\n100\t0\tcom.example.bot\n- 0 stopped\n101 0 ../../wrong\n102 -9 other.job').entries()])
      .toEqual([[100, 'com.example.bot'], [102, 'other.job']]);
  });

  it('rejects a fresh descriptor whose recorded PID was reused by another daemon', () => {
    const rows = readIndependentDaemonStatus('/data', {
      discover: () => [{ larkAppId: 'bot-a', ipcPort: 9001, pid: 100, lastHeartbeat: 10, processStartIdentity: 'old-birth' }],
      now: () => 10, launchdJobs: () => new Map([[100, 'com.example.bot-a']]),
      inspect: (pid, recorded) => inspectIndependentDaemonProcess(pid, recorded, {
        readRawIdentity: () => 'new-birth', inspect: () => exact(pid, 'new-birth'),
      }),
    });
    expect(rows[0].status).toBe('offline');
    expect(() => selectIndependentRestartTargets(rows, ['bot-a'], 'bot-a')).toThrow('未执行重启');
  });

  it('compares raw Linux ticks while retaining the durable boot/tick attestation', () => {
    const result = inspectIndependentDaemonProcess(100, '12345', {
      readRawIdentity: () => '12345', inspect: () => exact(100, 'boot-uuid:12345'),
    });
    expect(result).toEqual(exact(100, 'boot-uuid:12345'));
    expect(inspectIndependentDaemonProcess(100, '12345', {
      readRawIdentity: vi.fn().mockReturnValueOnce('12345').mockReturnValue('67890'),
      inspect: () => exact(100, 'boot-uuid:12345'),
    })).toEqual({ status: 'stale' });
  });
});

describe('independent launchd logs', () => {
  it('reads actual loaded-job paths, preserving spaces and omitting private environment', () => {
    const readJob = vi.fn(() => ' pid = 100\n stdout path = /private/Bot Logs/out.log\n stderr path = /private/err.log\n environment = { SECRET = hidden }');
    expect(readIndependentLaunchdLogPaths(row(), { uid: 501, platform: 'darwin', readJob, exists: () => true }))
      .toEqual(['/private/Bot Logs/out.log', '/private/err.log']);
    expect(readJob).toHaveBeenCalledWith('gui/501/com.example.bot-a');
  });

  it('ignores a replaced job PID and a non-macOS host', () => {
    const readJob = vi.fn(() => ' pid = 999\n stdout path = /wrong.log');
    expect(readIndependentLaunchdLogPaths(row(), { uid: 501, platform: 'darwin', readJob, exists: () => true })).toEqual([]);
    expect(readIndependentLaunchdLogPaths(row(), { uid: 501, platform: 'linux', readJob })).toEqual([]);
    expect(readJob).toHaveBeenCalledTimes(1);
  });
});

function restartRuntime(targets: IndependentDaemonStatus[]): IndependentLaunchdRestartRuntime {
  let now = 0;
  const generations = new Map<string, IndependentDaemonStatus>();
  return {
    platform: 'darwin', uid: 501, now: () => now,
    readJob: target => ` pid = ${targets.find(r => target.endsWith('/' + r.launchdLabel))!.pid}`,
    inspect: (pid, processStart) => exact(pid, processStart),
    kickstart: vi.fn(target => {
      const old = targets.find(r => target.endsWith('/' + r.launchdLabel))!;
      generations.set(old.appId, { ...old, pid: old.pid + 1000, processStart: `new-${old.pid}`, bootInstanceId: `new-boot-${old.pid}` });
    }),
    readStatus: () => [...generations.values()],
    sleep: async ms => { now += ms; },
  };
}

describe('independent launchd restart', () => {
  it('selects one configured Bot and refuses unknown/mixed management before mutation', () => {
    const rows = [row('bot-a', 100), row('bot-b', 101)];
    expect(selectIndependentRestartTargets(rows, ['bot-a', 'bot-b'], 'bot-b')).toEqual([rows[1]]);
    expect(() => selectIndependentRestartTargets(rows, ['bot-a'])).toThrow('未执行重启');
    expect(() => selectIndependentRestartTargets([{ ...rows[0], launchdLabel: undefined }], ['bot-a'])).toThrow('未执行重启');
    expect(() => selectIndependentRestartTargets([{ ...rows[0], status: 'unknown' }], ['bot-a'])).toThrow('未执行重启');
  });

  it('restarts only selected loaded jobs and waits for each new process and heartbeat identity', async () => {
    const targets = [row('bot-a', 100), row('bot-b', 101)];
    const runtime = restartRuntime(targets);
    const result = await restartIndependentLaunchdDaemons(targets, { runtime });
    expect(runtime.kickstart).toHaveBeenNthCalledWith(1, 'gui/501/com.example.bot-a');
    expect(runtime.kickstart).toHaveBeenNthCalledWith(2, 'gui/501/com.example.bot-b');
    expect(result.map(r => r.pid)).toEqual([1100, 1101]);
  });

  it('preflights all jobs so a later identity mismatch does not partially restart the fleet', async () => {
    const targets = [row('bot-a', 100), row('bot-b', 101)];
    const runtime = restartRuntime(targets);
    runtime.readJob = target => ` pid = ${target.endsWith('bot-b') ? 999 : 100}`;
    await expect(restartIndependentLaunchdDaemons(targets, { runtime })).rejects.toThrow('未对该 Bot 执行重启');
    expect(runtime.kickstart).not.toHaveBeenCalled();
  });

  it('accepts a new PID and boot identity when Darwin birth timestamps have the same second', async () => {
    const targets = [row()];
    const runtime = restartRuntime(targets);
    runtime.readStatus = () => [{ ...targets[0], pid: 1100, bootInstanceId: 'new-boot' }];
    const results = await restartIndependentLaunchdDaemons(targets, { runtime, timeoutMs: 1000 });
    expect(results[0].pid).toBe(1100);
  });

  it('rejects the same PID and birth timestamp even if an old descriptor claims a different boot ID', async () => {
    const targets = [row()];
    const runtime = restartRuntime(targets);
    runtime.readStatus = () => [{ ...targets[0], bootInstanceId: 'claimed-new-boot' }];
    await expect(restartIndependentLaunchdDaemons(targets, { runtime, timeoutMs: 1000 })).rejects.toThrow('未在期限内');
  });

  it('rechecks the birth identity immediately before kickstart', async () => {
    const targets = [row()];
    const runtime = restartRuntime(targets);
    runtime.inspect = vi.fn().mockReturnValueOnce(exact(100)).mockReturnValue({ status: 'stale' });
    await expect(restartIndependentLaunchdDaemons(targets, { runtime })).rejects.toThrow('无法核验');
    expect(runtime.kickstart).not.toHaveBeenCalled();
  });

  it('does not count old heartbeat records or a wrong Bot as restart success, and stops before the next Bot', async () => {
    const targets = [row('bot-a', 100), row('bot-b', 101)];
    const runtime = restartRuntime(targets);
    runtime.readStatus = () => [...targets, { ...targets[0], appId: 'foreign', processStart: 'new', bootInstanceId: 'new' }];
    await expect(restartIndependentLaunchdDaemons(targets, { runtime, timeoutMs: 1000 })).rejects.toThrow('后续 Bot 未重启');
    expect(runtime.kickstart).toHaveBeenCalledTimes(1);
  });

  it('does not leak launchctl output in command errors', async () => {
    const targets = [row()];
    const runtime = restartRuntime(targets);
    runtime.kickstart = vi.fn(() => { throw new Error('private-env-secret'); });
    await expect(restartIndependentLaunchdDaemons(targets, { runtime })).rejects.toThrow('重启命令失败');
    await expect(restartIndependentLaunchdDaemons(targets, { runtime })).rejects.not.toThrow('private-env-secret');
  });
});
