import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export type TerminalDeviceScope = 'read' | 'write';
export const TERMINAL_DEVICE_TTL_MS = 180 * 24 * 60 * 60_000;
export const TERMINAL_DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const TERMINAL_DEVICE_PAIR_TTL_MS = 5 * 60_000;
export const TERMINAL_DEVICE_PENDING_LIMIT = 100;
/** Writers in different daemons wait this long for the store lock. */
const LOCK_WAIT_MS = 3_000;
/** A lock older than this was left by a crashed writer (writes take milliseconds). */
const LOCK_STALE_MS = 10_000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const identifier = z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value));
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.enum(['read', 'write']);
const deviceSchema = z.object({
  tokenHash: tokenHashSchema,
  deviceId: z.string().uuid(),
  ownerId: identifier,
  createdAt: timestamp,
  expiresAt: timestamp,
}).strict();
const pendingSchema = z.object({
  code: z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/),
  tokenHash: tokenHashSchema,
  sessionId: identifier,
  scope: scopeSchema,
  ownerId: identifier,
  createdAt: timestamp,
  expiresAt: timestamp,
  existingDeviceId: z.string().uuid().optional(),
}).strict();
const grantSchema = z.object({
  tokenHash: tokenHashSchema,
  sessionId: identifier,
  scope: scopeSchema,
  ownerId: identifier,
  createdAt: timestamp,
  expiresAt: timestamp,
}).strict();
const stateSchema = z.object({
  version: z.literal(1),
  botId: identifier,
  devices: z.array(deviceSchema),
  pending: z.array(pendingSchema).max(TERMINAL_DEVICE_PENDING_LIMIT),
  grants: z.array(grantSchema),
}).strict();
type State = z.infer<typeof stateSchema>;
type Device = z.infer<typeof deviceSchema>;

export interface TerminalDeviceIdentity {
  ownerId: string;
  deviceId: string;
  expiresAt: number;
}

export interface TerminalDevicePairing {
  code: string;
  /** Only the browser receives this credential; disk stores its SHA-256 hash. */
  browserToken: string;
  expiresAt: number;
}

export interface TerminalDeviceGrantInput {
  browserToken: string;
  sessionId: string;
  scope: TerminalDeviceScope;
  ownerId: string;
}

export type TerminalDeviceApprovalResult =
  | ({ ok: true } & TerminalDeviceIdentity)
  | { ok: false; reason: 'not_found' | 'expired' | 'session_mismatch' | 'owner_mismatch' };

/** Static messages keep credentials and stored identities out of error logs. */
export class TerminalDeviceStoreError extends Error {
  constructor(public readonly code: 'invalid_arguments' | 'invalid_state' | 'pending_limit' | 'store_unavailable') {
    super(`terminal device store: ${code}`);
    this.name = 'TerminalDeviceStoreError';
  }
}

function hashToken(token: string | undefined): string | undefined {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  // Require canonical 32-byte base64url; alternate encodings must not create
  // multiple credentials for the same random bytes.
  if (Buffer.from(token, 'base64url').toString('base64url') !== token) return undefined;
  return createHash('sha256').update(token).digest('hex');
}

function identityOf(device: Device, expiresAt = device.expiresAt): TerminalDeviceIdentity {
  return { ownerId: device.ownerId, deviceId: device.deviceId, expiresAt };
}

/**
 * One daemon owns this store and calls its synchronous methods. A paired
 * browser remembers an identity, while each bot/session/scope has its own fixed
 * grant. Callers MUST validate the original Lark capability before `grant`;
 * browser identity alone never authorizes another session.
 */
export class TerminalDeviceStore {
  private readonly dataDir: string;
  private readonly directory: string;
  private readonly path: string;
  private readonly botId: string;
  private readonly clock: () => number;
  private faulted = false;

  constructor(options: { dataDir: string; botId: string; now?: () => number }) {
    if (!identifier.safeParse(options.botId).success || !options.dataDir) {
      throw new TerminalDeviceStoreError('invalid_arguments');
    }
    this.botId = options.botId;
    this.clock = options.now ?? Date.now;
    this.dataDir = options.dataDir;
    this.directory = join(options.dataDir, 'terminal-devices');
    this.path = join(this.directory, `${createHash('sha256').update(this.botId).digest('hex')}.json`);
  }

  // Every read-modify-write runs under a file lock: with a deployment-wide
  // store several daemons write the same file.
  startPair(input: Parameters<TerminalDeviceStore['startPairUnlocked']>[0]): TerminalDevicePairing {
    return this.locked(() => this.startPairUnlocked(input));
  }
  approve(input: Parameters<TerminalDeviceStore['approveUnlocked']>[0]): TerminalDeviceApprovalResult {
    return this.locked(() => this.approveUnlocked(input));
  }
  grant(input: TerminalDeviceGrantInput): TerminalDeviceIdentity | null {
    return this.locked(() => this.grantUnlocked(input));
  }
  revoke(browserToken: string): boolean {
    return this.locked(() => this.revokeUnlocked(browserToken));
  }
  revokeSession(input: { sessionId: string; ownerId: string }): number {
    return this.locked(() => this.revokeSessionUnlocked(input));
  }

  private startPairUnlocked(input: {
    sessionId: string; scope: TerminalDeviceScope; ownerId: string; browserToken?: string;
  }): TerminalDevicePairing {
    this.validateContext(input);
    const now = this.now();
    const state = this.load();
    this.prune(state, now);
    const suppliedHash = hashToken(input.browserToken);
    const device = state.devices.find(item => item.tokenHash === suppliedHash && item.ownerId === input.ownerId);
    const knownPending = state.pending.find(item => item.tokenHash === suppliedHash && item.ownerId === input.ownerId);
    const browserToken = suppliedHash && (device || knownPending)
      ? input.browserToken!
      : randomBytes(32).toString('base64url');
    const tokenHash = hashToken(browserToken)!;
    const existing = state.pending.find(item => item.tokenHash === tokenHash
      && item.sessionId === input.sessionId && item.ownerId === input.ownerId && item.scope === input.scope);
    if (existing) return { code: existing.code, browserToken, expiresAt: existing.expiresAt };
    if (state.pending.length >= TERMINAL_DEVICE_PENDING_LIMIT) throw new TerminalDeviceStoreError('pending_limit');
    let code: string;
    do {
      const bytes = randomBytes(8);
      code = Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
    } while (state.pending.some(item => item.code === code));
    const expiresAt = Math.min(now + TERMINAL_DEVICE_PAIR_TTL_MS, device?.expiresAt ?? Infinity);
    state.pending.push({
      code, tokenHash, sessionId: input.sessionId, scope: input.scope, ownerId: input.ownerId,
      createdAt: now, expiresAt,
      ...(device ? { existingDeviceId: device.deviceId } : {}),
    });
    this.save(state);
    return { code, browserToken, expiresAt };
  }

  private approveUnlocked(input: { code: string; sessionId: string; ownerId: string }): TerminalDeviceApprovalResult {
    if (!identifier.safeParse(input.sessionId).success || !identifier.safeParse(input.ownerId).success
      || typeof input.code !== 'string') throw new TerminalDeviceStoreError('invalid_arguments');
    const now = this.now();
    const state = this.load();
    const code = input.code.trim().toUpperCase();
    const pending = state.pending.find(item => item.code === code);
    if (!pending) return { ok: false, reason: 'not_found' };
    if (pending.expiresAt <= now) return { ok: false, reason: 'expired' };
    if (pending.sessionId !== input.sessionId) return { ok: false, reason: 'session_mismatch' };
    if (pending.ownerId !== input.ownerId) return { ok: false, reason: 'owner_mismatch' };
    this.prune(state, now);
    let device = state.devices.find(item => item.tokenHash === pending.tokenHash);
    if (pending.existingDeviceId && (!device || device.deviceId !== pending.existingDeviceId)) {
      return { ok: false, reason: 'expired' };
    }
    if (!device) {
      device = {
        tokenHash: pending.tokenHash, deviceId: randomUUID(), ownerId: pending.ownerId,
        createdAt: now, expiresAt: now + TERMINAL_DEVICE_TTL_MS,
      };
      state.devices.push(device);
    }
    if (device.ownerId !== pending.ownerId) return { ok: false, reason: 'owner_mismatch' };
    // These requests have already passed their own session capability checks.
    // Release tabs opened before approval, just as opening those same links
    // after approval grants access directly to the remembered browser.
    const browserRequests = state.pending.filter(item => item.tokenHash === pending.tokenHash
      && item.ownerId === pending.ownerId);
    for (const request of browserRequests) {
      this.addGrant(state, device, request.sessionId, request.scope, now);
    }
    state.pending = state.pending.filter(item => item.tokenHash !== pending.tokenHash
      || item.ownerId !== pending.ownerId);
    this.save(state);
    return { ok: true, ...identityOf(device) };
  }

  identity(browserToken: string): TerminalDeviceIdentity | null {
    const now = this.now();
    const state = this.load();
    const tokenHash = hashToken(browserToken);
    const device = state.devices.find(item => item.tokenHash === tokenHash && item.expiresAt > now);
    return device ? identityOf(device) : null;
  }

  private grantUnlocked(input: TerminalDeviceGrantInput): TerminalDeviceIdentity | null {
    this.validateContext(input);
    const now = this.now();
    const state = this.load();
    this.prune(state, now);
    const tokenHash = hashToken(input.browserToken);
    const device = state.devices.find(item => item.tokenHash === tokenHash && item.ownerId === input.ownerId);
    if (!device) return null;
    const expiresAt = this.addGrant(state, device, input.sessionId, input.scope, now);
    this.save(state);
    return identityOf(device, expiresAt);
  }

  access(input: TerminalDeviceGrantInput): TerminalDeviceIdentity | null {
    this.validateContext(input);
    const now = this.now();
    const state = this.load();
    const tokenHash = hashToken(input.browserToken);
    const device = state.devices.find(item => item.tokenHash === tokenHash
      && item.ownerId === input.ownerId && item.expiresAt > now);
    if (!device) return null;
    const grants = state.grants.filter(item => item.tokenHash === tokenHash
      && item.sessionId === input.sessionId && item.ownerId === input.ownerId && item.expiresAt > now
      && (item.scope === input.scope || (input.scope === 'read' && item.scope === 'write')));
    if (!grants.length) return null;
    return identityOf(device, Math.min(device.expiresAt, Math.max(...grants.map(item => item.expiresAt))));
  }

  private revokeUnlocked(browserToken: string): boolean {
    const state = this.load();
    const tokenHash = hashToken(browserToken);
    if (!tokenHash) return false;
    const hadRecords = state.devices.some(item => item.tokenHash === tokenHash)
      || state.pending.some(item => item.tokenHash === tokenHash) || state.grants.some(item => item.tokenHash === tokenHash);
    if (!hadRecords) return false;
    state.devices = state.devices.filter(item => item.tokenHash !== tokenHash);
    state.pending = state.pending.filter(item => item.tokenHash !== tokenHash);
    state.grants = state.grants.filter(item => item.tokenHash !== tokenHash);
    this.save(state);
    return true;
  }

  private revokeSessionUnlocked(input: { sessionId: string; ownerId: string }): number {
    if (!identifier.safeParse(input.sessionId).success || !identifier.safeParse(input.ownerId).success) {
      throw new TerminalDeviceStoreError('invalid_arguments');
    }
    const state = this.load();
    const matches = (item: { sessionId: string; ownerId: string }) =>
      item.sessionId === input.sessionId && item.ownerId === input.ownerId;
    const removed = state.grants.filter(matches).length + state.pending.filter(matches).length;
    if (!removed) return 0;
    state.grants = state.grants.filter(item => !matches(item));
    state.pending = state.pending.filter(item => !matches(item));
    this.save(state);
    return removed;
  }

  /**
   * Imports per-bot stores into this (deployment-wide) store once, keeping
   * every device's id and fixed lifetime and every session grant. Records
   * are re-owned by `ownerId`, the deployment principal. Imported files are
   * renamed to `*.json.migrated` (kept as backup, ignored by readers).
   * Unreadable files are left untouched. No-op once this store exists.
   */
  importLegacyStores(ownerId: string): number {
    if (!identifier.safeParse(ownerId).success) throw new TerminalDeviceStoreError('invalid_arguments');
    return this.locked(() => {
      try { readFileSync(this.path); return 0; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TerminalDeviceStoreError('store_unavailable');
      }
      const now = this.now();
      const state = this.load();
      const own = this.path.slice(this.directory.length + 1);
      const imported: string[] = [];
      for (const name of readdirSync(this.directory).sort()) {
        if (!name.endsWith('.json') || name === own) continue;
        let legacy: State;
        try {
          legacy = stateSchema.parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8')));
          if (`${createHash('sha256').update(legacy.botId).digest('hex')}.json` !== name) continue;
          new TerminalDeviceStore({ dataDir: this.dataDir, botId: legacy.botId, now: this.clock }).load();
        } catch { continue; }
        for (const device of legacy.devices) {
          if (device.expiresAt <= now || state.devices.some(item => item.tokenHash === device.tokenHash || item.deviceId === device.deviceId)) continue;
          state.devices.push({ ...device, ownerId });
        }
        for (const grant of legacy.grants) {
          if (grant.expiresAt <= now || !legacy.devices.some(item => item.tokenHash === grant.tokenHash && item.ownerId === grant.ownerId)) continue;
          if (state.grants.some(item => item.tokenHash === grant.tokenHash && item.sessionId === grant.sessionId && item.scope === grant.scope)) continue;
          state.grants.push({ ...grant, ownerId });
        }
        imported.push(name);
      }
      if (!imported.length) return 0;
      this.prune(state, now);
      this.save(state);
      for (const name of imported) renameSync(join(this.directory, name), join(this.directory, `${name}.migrated`));
      return imported.length;
    });
  }

  /** Serializes read-modify-write across daemons sharing one store file. */
  private locked<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    try { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
    catch { throw new TerminalDeviceStoreError('store_unavailable'); }
    for (;;) {
      try { closeSync(openSync(lock, 'wx', 0o600)); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new TerminalDeviceStoreError('store_unavailable');
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; }
        } catch { continue; }
        if (Date.now() >= deadline) throw new TerminalDeviceStoreError('store_unavailable');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return fn(); }
    finally { try { unlinkSync(lock); } catch { /* already removed as stale */ } }
  }

  private addGrant(state: State, device: Device, sessionId: string, scope: TerminalDeviceScope, now: number): number {
    const existing = state.grants.find(item => item.tokenHash === device.tokenHash
      && item.sessionId === sessionId && item.ownerId === device.ownerId && item.scope === scope && item.expiresAt > now);
    // Reopening a link must not roll the fixed lifetime forward.
    if (existing) return existing.expiresAt;
    const expiresAt = Math.min(device.expiresAt, now + TERMINAL_DEVICE_SESSION_TTL_MS);
    state.grants.push({ tokenHash: device.tokenHash, sessionId, scope, ownerId: device.ownerId, createdAt: now, expiresAt });
    return expiresAt;
  }

  private validateContext(input: { sessionId: string; scope: TerminalDeviceScope; ownerId: string }): void {
    if (!identifier.safeParse(input.sessionId).success || !identifier.safeParse(input.ownerId).success
      || !scopeSchema.safeParse(input.scope).success) throw new TerminalDeviceStoreError('invalid_arguments');
  }

  private now(): number {
    const now = this.clock();
    if (!timestamp.safeParse(now).success || now > Number.MAX_SAFE_INTEGER - TERMINAL_DEVICE_TTL_MS) {
      throw new TerminalDeviceStoreError('invalid_arguments');
    }
    return now;
  }

  private prune(state: State, now: number): void {
    state.devices = state.devices.filter(item => item.expiresAt > now);
    const liveDevices = new Set(state.devices.map(item => item.deviceId));
    const liveTokens = new Set(state.devices.map(item => item.tokenHash));
    state.pending = state.pending.filter(item => item.expiresAt > now
      && (!item.existingDeviceId || liveDevices.has(item.existingDeviceId)));
    state.grants = state.grants.filter(item => item.expiresAt > now && liveTokens.has(item.tokenHash));
  }

  private load(): State {
    if (this.faulted) throw new TerminalDeviceStoreError('store_unavailable');
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, botId: this.botId, devices: [], pending: [], grants: [] };
      }
      this.faulted = true;
      throw new TerminalDeviceStoreError('store_unavailable');
    }
    try {
      const state = stateSchema.parse(JSON.parse(text));
      if (state.botId !== this.botId) throw new Error('bot mismatch');
      const devices = new Map(state.devices.map(item => [item.tokenHash, item]));
      if (devices.size !== state.devices.length
        || new Set(state.devices.map(item => item.deviceId)).size !== state.devices.length
        || new Set(state.pending.map(item => item.code)).size !== state.pending.length
        || new Set(state.grants.map(item => JSON.stringify([item.tokenHash, item.sessionId, item.scope]))).size !== state.grants.length) {
        throw new Error('duplicate records');
      }
      for (const item of state.devices) {
        if (item.expiresAt !== item.createdAt + TERMINAL_DEVICE_TTL_MS) throw new Error('invalid device lifetime');
      }
      for (const item of state.pending) {
        const device = devices.get(item.tokenHash);
        if (item.expiresAt <= item.createdAt || item.expiresAt > item.createdAt + TERMINAL_DEVICE_PAIR_TTL_MS
          || (device && device.ownerId !== item.ownerId)
          || (item.existingDeviceId && (!device || device.deviceId !== item.existingDeviceId))) {
          throw new Error('invalid pairing');
        }
      }
      for (const item of state.grants) {
        const device = devices.get(item.tokenHash);
        if (!device || device.ownerId !== item.ownerId || item.expiresAt <= item.createdAt
          || item.expiresAt > item.createdAt + TERMINAL_DEVICE_SESSION_TTL_MS || item.expiresAt > device.expiresAt) {
          throw new Error('invalid grant');
        }
      }
      return state;
    } catch {
      this.faulted = true;
      throw new TerminalDeviceStoreError('invalid_state');
    }
  }

  private save(state: State): void {
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(state) + '\n', 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
    } catch {
      // A failed revoke must not leave this running daemon accepting the old
      // disk state. Recovery requires fixing storage and creating a new store.
      this.faulted = true;
      throw new TerminalDeviceStoreError('store_unavailable');
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve original error */ } }
      try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    }
  }
}
