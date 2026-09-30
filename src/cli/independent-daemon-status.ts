import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { builtinFleetEntryMatches, inspectFleetProcess, type FleetProcessInspection } from '../core/fleet-process-identity.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { DAEMON_HEARTBEAT_STALE_MS } from '../utils/daemon-heartbeat.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';
import { listDaemonDescriptors, parseDaemonIpcPort, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';

export interface IndependentDaemonStatus {
  appId: string;
  name: string;
  cliId: string;
  pid: number;
  ipcPort: number;
  status: 'online' | 'offline' | 'unknown';
  launchdLabel?: string;
  processStart?: string;
  bootInstanceId?: string;
}

export interface IndependentDaemonStatusRuntime {
  discover(dataDir: string): OnlineDaemonInfo[];
  inspect(pid: number, recordedProcessStart?: string): FleetProcessInspection;
  launchdJobs(): Map<number, string>;
  now(): number;
}

const display = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();

export function parseLaunchdJobs(output: string): Map<number, string> {
  const jobs = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^([1-9]\d*)\s+-?\d+\s+([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (match && Number.isSafeInteger(Number(match[1]))) jobs.set(Number(match[1]), match[2]);
  }
  return jobs;
}

function readLaunchdJobs(): Map<number, string> {
  if (process.platform !== 'darwin') return new Map();
  try {
    return parseLaunchdJobs(execFileSync('/bin/launchctl', ['list'], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { return new Map(); }
}

/** The descriptor stores raw Linux ticks; fleet attestations include boot ID.
 * Check the recorded raw birth on both sides of durable process inspection. */
export function inspectIndependentDaemonProcess(
  pid: number,
  recordedProcessStart?: string,
  runtime = {
    readRawIdentity: readProcessStartIdentity,
    inspect: (candidate: number) => inspectFleetProcess(candidate, undefined, undefined, command => builtinFleetEntryMatches('daemon', command)),
  },
): FleetProcessInspection {
  const before = recordedProcessStart ? runtime.readRawIdentity(pid) : undefined;
  if (recordedProcessStart && before && before !== recordedProcessStart) return { status: 'stale' };
  const inspection = runtime.inspect(pid);
  if (!recordedProcessStart || inspection.status === 'stale') return inspection;
  const after = runtime.readRawIdentity(pid);
  if ((before && before !== recordedProcessStart) || (after && after !== recordedProcessStart)) return { status: 'stale' };
  if (!before || !after) return { status: 'unverifiable' };
  return inspection;
}

/** Read-only view of daemons started outside the fleet supervisor. A fresh
 * descriptor alone is insufficient: its PID must still identify a daemon. */
export function readIndependentDaemonStatus(
  dataDir = resolveBotmuxDataDir(),
  runtime: IndependentDaemonStatusRuntime = {
    discover: listDaemonDescriptors,
    inspect: inspectIndependentDaemonProcess,
    launchdJobs: readLaunchdJobs,
    now: Date.now,
  },
): IndependentDaemonStatus[] {
  const now = runtime.now();
  const descriptors = runtime.discover(dataDir);
  const jobs = runtime.launchdJobs();
  const counts = new Map<number, number>();
  for (const d of descriptors) counts.set(d.pid ?? 0, (counts.get(d.pid ?? 0) ?? 0) + 1);
  return descriptors.map(d => {
    const pid = Number.isSafeInteger(d.pid) && d.pid! > 1 ? d.pid! : 0;
    const inspection = runtime.inspect(pid, d.processStartIdentity);
    const duplicate = counts.get(pid)! > 1;
    const fresh = Number.isFinite(d.lastHeartbeat) && d.lastHeartbeat! <= now + 5_000
      && now - d.lastHeartbeat! <= DAEMON_HEARTBEAT_STALE_MS;
    const status = inspection.status === 'stale' ? 'offline'
      : duplicate || !fresh || parseDaemonIpcPort(d.ipcPort) === undefined ? 'unknown'
      : inspection.status === 'exact' ? 'online' : 'unknown';
    return {
      appId: d.larkAppId,
      name: display(d.botName ?? '') || `daemon-${pid}`,
      cliId: display(d.cliId ?? '') || '-',
      pid, ipcPort: d.ipcPort, status,
      ...(d.bootInstanceId ? { bootInstanceId: d.bootInstanceId } : {}),
      ...(status === 'online' && inspection.status === 'exact' ? { processStart: inspection.attestation.processStart } : {}),
      ...(status === 'online' && jobs.has(pid) ? { launchdLabel: jobs.get(pid)! } : {}),
    };
  });
}

export function formatIndependentDaemonStatus(rows: IndependentDaemonStatus[]): string[] {
  const online = rows.filter(r => r.status === 'online').length;
  const nameWidth = Math.max(4, ...rows.map(r => r.name.length));
  const cliWidth = Math.max(3, ...rows.map(r => r.cliId.length));
  return [
    `独立 daemon: ${online}/${rows.length} 在线（未由 fleet supervisor 管理）`,
    `  ${'NAME'.padEnd(nameWidth)}  ${'PID'.padStart(7)}  ${'CLI'.padEnd(cliWidth)}  ${'STATUS'.padEnd(7)}  IPC    MANAGER`,
    ...rows.map(r => `  ${r.name.padEnd(nameWidth)}  ${String(r.pid).padStart(7)}  ${r.cliId.padEnd(cliWidth)}  ${r.status.padEnd(7)}  ${String(r.ipcPort).padEnd(5)}  ${r.launchdLabel ? `launchd:${r.launchdLabel}` : 'independent'}`),
  ];
}

/** Read the loaded job's paths rather than assume supervisor log filenames.
 * Never relay launchctl's full output: it can contain environment secrets. */
export function readIndependentLaunchdLogPaths(
  row: IndependentDaemonStatus,
  options: {
    uid?: number;
    platform?: NodeJS.Platform;
    readJob?: (target: string) => string;
    exists?: (path: string) => boolean;
  } = {},
): string[] {
  const uid = options.uid ?? process.getuid?.();
  if ((options.platform ?? process.platform) !== 'darwin' || uid === undefined
      || row.status !== 'online' || !row.launchdLabel || !/^[A-Za-z0-9_.-]+$/.test(row.launchdLabel)) return [];
  const readJob = options.readJob ?? (target => execFileSync('/bin/launchctl', ['print', target], {
    encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2 * 1024 * 1024,
  }));
  try {
    const output = readJob(`gui/${uid}/${row.launchdLabel}`);
    if (Number(/^\s*pid = (\d+)\s*$/m.exec(output)?.[1]) !== row.pid) return [];
    const paths = [...output.matchAll(/^\s*(?:stdout|stderr) path = (\/[^\r\n]*)$/gm)].map(m => m[1].trim());
    return [...new Set(paths)].filter(path => !/[\u0000-\u001f]/.test(path) && (options.exists ?? existsSync)(path));
  } catch { return []; }
}

export function selectIndependentRestartTargets(
  rows: IndependentDaemonStatus[],
  configuredAppIds: readonly string[],
  selectedAppId?: string,
): IndependentDaemonStatus[] {
  const allowed = new Set(configuredAppIds);
  const targets = selectedAppId ? rows.filter(r => r.appId === selectedAppId) : rows.filter(r => r.status !== 'offline');
  if (targets.length === 0 || (selectedAppId && targets.length !== 1)) {
    throw new Error('未找到所选 Bot 的唯一独立 daemon；未执行重启。');
  }
  const labels = new Set<string>();
  const appIds = new Set<string>();
  for (const row of targets) {
    if (!allowed.has(row.appId) || row.status !== 'online' || !row.processStart || !row.launchdLabel
        || labels.has(row.launchdLabel) || appIds.has(row.appId)) {
      throw new Error('独立 daemon 的进程或 launchd 身份无法核验；未执行重启。');
    }
    labels.add(row.launchdLabel);
    appIds.add(row.appId);
  }
  return targets;
}

export interface IndependentLaunchdRestartRuntime {
  platform: NodeJS.Platform;
  uid: number | undefined;
  readJob(target: string): string;
  inspect(pid: number, processStart: string): FleetProcessInspection;
  kickstart(target: string): void;
  readStatus(): IndependentDaemonStatus[];
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Restart only already-loaded, verified launchd jobs. This never starts a
 * supervisor, rewrites a plist, or signals a CLI/HERDR source process. */
export async function restartIndependentLaunchdDaemons(
  targets: IndependentDaemonStatus[],
  options: { dataDir?: string; timeoutMs?: number; runtime?: IndependentLaunchdRestartRuntime; beforeRestart?: () => Promise<void> } = {},
): Promise<IndependentDaemonStatus[]> {
  const runtime = options.runtime ?? {
    platform: process.platform,
    uid: process.getuid?.(),
    readJob: (target: string) => execFileSync('/bin/launchctl', ['print', target], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2 * 1024 * 1024,
    }),
    inspect: (pid: number, processStart: string) => inspectFleetProcess(pid, processStart, undefined, command => builtinFleetEntryMatches('daemon', command)),
    kickstart: (target: string) => { execFileSync('/bin/launchctl', ['kickstart', '-k', target], { timeout: 5_000, stdio: 'ignore' }); },
    readStatus: () => readIndependentDaemonStatus(options.dataDir),
    now: Date.now,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  };
  if (runtime.platform !== 'darwin' || runtime.uid === undefined || targets.length === 0) {
    throw new Error('当前平台无法核验独立 launchd daemon；未执行重启。');
  }
  const jobTarget = (row: IndependentDaemonStatus) => `gui/${runtime.uid}/${row.launchdLabel}`;
  const verify = (row: IndependentDaemonStatus): void => {
    try {
      if (row.status !== 'online' || !row.processStart || !row.launchdLabel || !/^[A-Za-z0-9_.-]+$/.test(row.launchdLabel)) throw new Error();
      const job = runtime.readJob(jobTarget(row));
      if (Number(/^\s*pid = (\d+)\s*$/m.exec(job)?.[1]) !== row.pid) throw new Error();
      if (runtime.inspect(row.pid, row.processStart).status !== 'exact') throw new Error();
    } catch { throw new Error(`无法核验 ${row.name} 的 loaded launchd job；未对该 Bot 执行重启。`); }
  };
  // Validate every selected job before mutating even the first one.
  targets.forEach(verify);
  await options.beforeRestart?.();
  const results: IndependentDaemonStatus[] = [];
  for (const row of targets) {
    verify(row);
    try { runtime.kickstart(jobTarget(row)); }
    catch { throw new Error(`${row.name} 的 launchd 重启命令失败；请用 botmux status 核对实际状态。`); }
    const deadline = runtime.now() + (options.timeoutMs ?? 30_000);
    let fresh: IndependentDaemonStatus | undefined;
    do {
      fresh = runtime.readStatus().find(r => r.appId === row.appId && r.status === 'online'
        && r.launchdLabel === row.launchdLabel && Boolean(r.processStart)
        && (r.pid !== row.pid || r.processStart !== row.processStart)
        && (!row.bootInstanceId || (Boolean(r.bootInstanceId) && r.bootInstanceId !== row.bootInstanceId)));
      if (fresh) break;
      if (runtime.now() >= deadline) break;
      await runtime.sleep(Math.min(500, deadline - runtime.now()));
    } while (runtime.now() <= deadline);
    if (!fresh) throw new Error(`${row.name} 已提交重启，但新 daemon 未在期限内通过身份与 heartbeat 核验；后续 Bot 未重启，请用 botmux status / logs 检查。`);
    results.push(fresh);
  }
  return results;
}
