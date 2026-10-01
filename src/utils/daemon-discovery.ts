/**
 * Lightweight cross-process discovery of online botmux daemons.
 *
 * Each daemon writes a descriptor file to `<dataDir>/dashboard-daemons/`
 * (containing larkAppId, ipcPort, pid, lastHeartbeat, and optional protocol
 * audiences) and refreshes its heartbeat periodically. Any other process —
 * CLI subcommands, dashboard, other daemons — can read this directory to
 * discover live peers, no shared in-memory state required.
 *
 * A daemon is considered offline if its heartbeat hasn't been refreshed in
 * the last DAEMON_HEARTBEAT_STALE_MS (utils/daemon-heartbeat.ts — shared with
 * dashboard/registry.ts and the session-store occupancy lease TTL).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { DAEMON_HEARTBEAT_STALE_MS } from './daemon-heartbeat.js';

export interface OnlineDaemonInfo {
  larkAppId: string;
  ipcPort: number;
  /** Random per-process audience for authenticated Workflow v3 mutations. */
  bootInstanceId?: string;
  /** Auth protocol advertised atomically with bootInstanceId + ipcPort. */
  workflowIpcProtocol?: string;
  /** Presence-based session-store capability. Copy only; never a write permit. */
  sessionStoreProtocol?: string;
  /** Running binary version. Copy only; never compared by size. */
  botmuxVersion?: string;
  botName?: string;
  cliId?: string;
  pid?: number;
  /** Birth identity recorded atomically by the daemon (raw platform format). */
  processStartIdentity?: string;
  lastHeartbeat?: number;
  /** Bound terminal reverse-proxy port (loopback), when the daemon has one. */
  terminalProxyPort?: number;
}

/** `dataDir` lets a caller that already resolved a data dir keep the daemon
 *  probe and its store access on the SAME directory. Omitting it falls back to
 *  the process-wide resolution, which is what every host-CLI caller wants. */
function registryDir(dataDir?: string): string {
  return join(dataDir ?? resolveBotmuxDataDir(), 'dashboard-daemons');
}

/** Parse a loopback daemon IPC port from a descriptor or injected env value. */
export function parseDaemonIpcPort(value: unknown): number | undefined {
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

/**
 * Prefer host-visible daemon discovery, then fall back to the port explicitly
 * injected into an isolated CLI. The fallback is only a loopback address
 * marker; individual daemon routes still authenticate their own requests.
 */
export function resolveDaemonIpcPort(
  discovered: unknown,
  injected: unknown,
): number | undefined {
  return parseDaemonIpcPort(discovered) ?? parseDaemonIpcPort(injected);
}

/** Read descriptors without treating stale heartbeat records as live daemons. */
/** `strict`: an unlistable registry dir throws instead of reading as "nobody
 *  online" — for callers that must not mistake an unreadable registry for an
 *  empty one. Malformed individual descriptors are skipped either way. */
export function listDaemonDescriptors(dataDir?: string, opts: { strict?: boolean } = {}): OnlineDaemonInfo[] {
  const dir = registryDir(dataDir);
  // No existsSync pre-check: it also answers false on EACCES, which strict
  // mode must surface. A registry that was never created (ENOENT) is empty.
  const out: OnlineDaemonInfo[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (err) {
    if (opts.strict && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      const d = JSON.parse(raw) as Partial<OnlineDaemonInfo>;
      if (typeof d.ipcPort !== 'number' || typeof d.larkAppId !== 'string') continue;
      out.push({
        larkAppId: d.larkAppId,
        ipcPort: d.ipcPort,
        ...(typeof d.bootInstanceId === 'string' && d.bootInstanceId
          ? { bootInstanceId: d.bootInstanceId }
          : {}),
        ...(typeof d.workflowIpcProtocol === 'string' && d.workflowIpcProtocol
          ? { workflowIpcProtocol: d.workflowIpcProtocol }
          : {}),
        ...(typeof d.sessionStoreProtocol === 'string' && d.sessionStoreProtocol
          ? { sessionStoreProtocol: d.sessionStoreProtocol }
          : {}),
        ...(typeof d.botmuxVersion === 'string' && d.botmuxVersion
          ? { botmuxVersion: d.botmuxVersion }
          : {}),
        ...(typeof d.botName === 'string' && d.botName.trim() ? { botName: d.botName.trim() } : {}),
        ...(typeof d.cliId === 'string' && d.cliId.trim() ? { cliId: d.cliId.trim() } : {}),
        pid: d.pid,
        ...(typeof d.processStartIdentity === 'string' && d.processStartIdentity
          ? { processStartIdentity: d.processStartIdentity } : {}),
        lastHeartbeat: d.lastHeartbeat,
        ...(parseDaemonIpcPort(d.terminalProxyPort) ? { terminalProxyPort: d.terminalProxyPort } : {}),
      });
    } catch { /* malformed — skip */ }
  }
  return out;
}

/** List every daemon whose descriptor file is fresh (heartbeat within STALE_MS). */
export function listOnlineDaemons(dataDir?: string, opts: { strict?: boolean } = {}): OnlineDaemonInfo[] {
  const now = Date.now();
  return listDaemonDescriptors(dataDir, opts).filter(d => now - (d.lastHeartbeat ?? 0) <= DAEMON_HEARTBEAT_STALE_MS);
}

/** Find a specific online daemon by larkAppId. Returns null if offline / not found. */
export function findOnlineDaemon(larkAppId: string, dataDir?: string): OnlineDaemonInfo | null {
  return listOnlineDaemons(dataDir).find(d => d.larkAppId === larkAppId) ?? null;
}
