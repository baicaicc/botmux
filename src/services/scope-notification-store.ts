/** Startup reminders track the last delivered state, not a timer or process cache. */
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

type ScopeProblem = 'missing-critical' | 'self-manage';

interface ScopeNotificationState {
  larkAppId: string;
  adminOpenId: string;
  problem: ScopeProblem;
  missingScopes: readonly string[];
}

interface NotifiedRecord extends ScopeNotificationState {
  notifiedAt: number;
}

function filePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `scope-notified-${encodeURIComponent(larkAppId)}.json`);
}

function readRecord(dataDir: string, larkAppId: string): NotifiedRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(filePath(dataDir, larkAppId), 'utf8'));
    if (!record || record.larkAppId !== larkAppId
      || typeof record.adminOpenId !== 'string' || !record.adminOpenId
      || !['missing-critical', 'self-manage'].includes(record.problem)
      || !Array.isArray(record.missingScopes) || record.missingScopes.length === 0
      || !record.missingScopes.every((scope: unknown) => typeof scope === 'string' && scope.length > 0)
      || !Number.isFinite(record.notifiedAt)) {
      throw new Error('invalid scope notification record');
    }
    return record as NotifiedRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`[${larkAppId}] cannot read scope notification state; reminders will not be suppressed: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

/** Record only a confirmed delivery. Failed reads/writes must never hide the warning. */
export async function notifyScopeProblemOnce(
  dataDir: string,
  state: ScopeNotificationState,
  send: () => Promise<boolean>,
): Promise<'unchanged' | 'delivered' | 'failed'> {
  const missingScopes = normalizedScopes(state.missingScopes);
  const previous = readRecord(dataDir, state.larkAppId);
  if (previous?.adminOpenId === state.adminOpenId && previous.problem === state.problem
    && JSON.stringify(normalizedScopes(previous.missingScopes)) === JSON.stringify(missingScopes)) {
    logger.info(`[${state.larkAppId}] unchanged ${state.problem} scope warning already delivered to this admin; startup log remains available`);
    return 'unchanged';
  }
  if (!await send()) return 'failed';
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(filePath(dataDir, state.larkAppId), JSON.stringify({
      ...state, missingScopes, notifiedAt: Date.now(),
    }) + '\n', { mode: 0o600, durable: true, followTargetSymlink: false });
  } catch (err) {
    logger.error(`[${state.larkAppId}] scope warning delivered but notification state could not be saved; it may repeat after restart: ${err instanceof Error ? err.message : err}`);
  }
  return 'delivered';
}

/** Clear only a condition known to have recovered; unrelated failures keep their state. */
export function clearScopeProblemNotification(dataDir: string, larkAppId: string, problem: ScopeProblem): void {
  const previous = readRecord(dataDir, larkAppId);
  if (previous && previous.problem !== problem) return;
  try {
    unlinkSync(filePath(dataDir, larkAppId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error(`[${larkAppId}] recovered ${problem} scope warning state could not be cleared; later reminders may be suppressed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
