/**
 * Startup scope self-check (checkRequiredScopes) and VC-event auto-subscribe
 * (ensureVcMeetingEventsSubscribed) in src/im/lark/event-dispatcher.ts, driven
 * through their real entry points: the Lark HTTP calls go through a stubbed
 * global fetch, while the Open Platform automation and the admin DM transport
 * are mocked at their module boundaries.
 *
 * What must hold (PR #715 and follow-ups):
 *  - All critical scopes granted + an optional one missing → a SILENT, QR-free
 *    top-up that requests only the missing scope and forwards the per-bucket
 *    granted set; nothing missing → no automation; a failed top-up changes nothing.
 *  - App stuck in review: DM the admin once per pending version, and only count it
 *    as notified once the DM was actually delivered (mark-then-send = one failure
 *    silences that version forever).
 *  - 99991672 (no self_manage): request every botmux-required scope in one shot,
 *    not the full manifest; fall back to the manual DM only when the auto-fix failed.
 *  - VC events: skip non-feishu / VC-inactive bots, probe read-only first, publish
 *    only when events are missing, never pop a QR at boot, DM only on failure.
 *
 * Run: bun run vitest run test/scope-optional-autofix.test.ts
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bot: undefined as any,
  automate: vi.fn(),
  probe: vi.fn(),
  hints: vi.fn(),
  dm: vi.fn(),
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBot: () => h.bot,
}));
vi.mock('../src/setup/open-platform-automation.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  automateOpenPlatformSetup: h.automate,
  probeVcMeetingEventSubscription: h.probe,
  inspectUnderReviewConfigHints: h.hints,
}));
vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  sendUserMessage: h.dm,
}));

import { checkRequiredScopes, ensureVcMeetingEventsSubscribed } from '../src/im/lark/event-dispatcher.js';
import { readDefaultScopeManifest } from '../src/setup/open-platform-automation.js';
import { BOTMUX_REQUIRED_SCOPES } from '../src/setup/verify-permissions.js';

const APP = 'cli_scope_selfcheck';
const makeBot = (config: Record<string, unknown> = {}) => ({
  config: { larkAppId: APP, larkAppSecret: 'secret', brand: 'feishu', vcMeetingAgent: { enabled: false }, ...config },
  resolvedAllowedUsers: ['ou_admin'],
  botName: 'ScopeBot',
});

/** Lark app-info stub: `granted` scopes in both token buckets, or an error `code`. */
function stubLark(app: { granted?: string[]; code?: number }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 't' });
    if (app.code !== undefined) return Response.json({ code: app.code, msg: 'denied' });
    return Response.json({ code: 0, data: { app: {
      scopes: (app.granted ?? []).map(scope => ({ scope, token_types: ['tenant', 'user'] })),
    } } });
  }));
}

const manifest = readDefaultScopeManifest();
const inManifest = (name: string) => manifest.scopes.tenant.includes(name) || manifest.scopes.user.includes(name);
const critical = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).map(s => s.name);
const optional = BOTMUX_REQUIRED_SCOPES.filter(s => !s.critical).map(s => s.name);
const requested = (call: number): string[] => {
  const scopes = h.automate.mock.calls[call]![0].scopeManifest.scopes;
  return [...new Set([...scopes.tenant, ...scopes.user])].sort();
};
const applied = { ok: true, scopeCount: 1, skippedScopeCount: 0, privilegeRangeCount: 0, subscribedEventCount: 0, versionId: 'v9' };
const underReview = (inReviewVersionId: string) => ({ ok: false, reason: 'app_under_review', message: '', inReviewVersionId });

beforeEach(() => {
  h.bot = makeBot();
  h.automate.mockReset();
  h.probe.mockReset();
  h.hints.mockReset().mockResolvedValue('');
  h.dm.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('checkRequiredScopes — optional-scope top-up', () => {
  it('runs no automation when every required scope is granted', async () => {
    stubLark({ granted: [...critical, ...optional] });
    await checkRequiredScopes(APP);
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('tops up only the missing optional scope, silently and without a QR, with the bucketed granted set', async () => {
    const missing = optional.find(inManifest)!;
    const granted = [...critical, ...optional.filter(name => name !== missing)];
    stubLark({ granted });
    h.automate.mockResolvedValue(applied);
    await checkRequiredScopes(APP);
    expect(h.automate).toHaveBeenCalledTimes(1);
    expect(h.automate.mock.calls[0]![0]).toMatchObject({ disableQrLogin: true });
    expect(requested(0)).toEqual([missing]);
    expect(h.automate.mock.calls[0]![0].grantedScopeNames).toEqual({ tenant: granted, user: granted });
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('leaves a failed top-up (no cached web session) unannounced', async () => {
    stubLark({ granted: [...critical, ...optional.slice(1)] });
    h.automate.mockResolvedValue({ ok: false, reason: 'missing_session', message: '' });
    await expect(checkRequiredScopes(APP)).resolves.toBeUndefined();
    expect(h.dm).not.toHaveBeenCalled();
  });
});

describe('checkRequiredScopes — app stuck in review', () => {
  it('DMs once per pending version, and counts it only after the DM was delivered', async () => {
    stubLark({ granted: optional });
    h.automate.mockResolvedValue(underReview('ver-1'));
    h.hints.mockResolvedValue('HINT-DATA-RANGE');
    h.dm.mockRejectedValueOnce(new Error('network down'));
    await checkRequiredScopes(APP); // delivery failed → not recorded
    await checkRequiredScopes(APP); // retried and delivered → recorded
    await checkRequiredScopes(APP); // same pending version → silent
    expect(h.dm).toHaveBeenCalledTimes(2);
    expect(h.dm.mock.calls[1]![2]).toContain('HINT-DATA-RANGE');
    h.automate.mockResolvedValue(underReview('ver-2'));
    await checkRequiredScopes(APP); // a new pending version is news again
    expect(h.dm).toHaveBeenCalledTimes(3);
  });
});

describe('checkRequiredScopes — 99991672 (app lacks self_manage)', () => {
  it('requests every botmux-required scope in one shot, not the full manifest', async () => {
    stubLark({ code: 99991672 });
    h.automate.mockResolvedValue(applied);
    await checkRequiredScopes(APP);
    expect(requested(0)).toEqual(BOTMUX_REQUIRED_SCOPES.map(s => s.name).filter(inManifest).sort());
    expect(requested(0)).toContain('application:application:self_manage');
  });

  it('falls back to the manual self_manage DM only when the auto-fix failed', async () => {
    stubLark({ code: 99991672 });
    h.automate.mockResolvedValue(underReview('ver-x'));
    await checkRequiredScopes(APP);
    expect(h.dm).not.toHaveBeenCalled();
    h.automate.mockResolvedValue({ ok: false, reason: 'missing_session', message: '' });
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
    expect(h.dm.mock.calls[0]![2]).toContain('application:application:self_manage');
  });
});

describe('ensureVcMeetingEventsSubscribed', () => {
  const vcBot = (config: Record<string, unknown> = {}) => makeBot({ vcMeetingAgent: undefined, ...config });

  it('skips non-feishu, apiOnly and VC-disabled bots without probing', async () => {
    for (const bot of [vcBot({ brand: 'lark' }), vcBot({ apiOnly: true }), makeBot()]) {
      h.bot = bot;
      await ensureVcMeetingEventsSubscribed(APP);
    }
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('never publishes when the events are already subscribed', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: [], eventModeReady: true });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.automate).not.toHaveBeenCalled();
  });

  it('subscribes missing events without a QR, and DMs the admin only when that fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: true, subscribedEventCount: 3, versionId: 'v1' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.automate).toHaveBeenCalledWith(expect.objectContaining({ disableQrLogin: true }));
    expect(h.dm).not.toHaveBeenCalled();
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
  });

  it('degrades quietly when the read-only probe fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'no cached session' });
    await expect(ensureVcMeetingEventsSubscribed(APP)).resolves.toBeUndefined();
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });
});

// ─── fork 自有：可选 scope 自动补齐 + tryAutoFixScopes 管线 ─────────────────────

// fork 测试辅助：按「函数签名 → 结束标记」截取 event-dispatcher.ts 的真实源码窗口，
// 避免随注释漂移的固定字符宽度（fork 历史上窗口太窄假红过三次）。
const forkSrc = readFileSync(new URL('../src/im/lark/event-dispatcher.ts', import.meta.url), 'utf-8');
function forkRegionUntil(signature: string, endMarker: string): string {
  const start = forkSrc.indexOf(signature);
  expect(start, `${signature} not found in event-dispatcher.ts`).toBeGreaterThanOrEqual(0);
  const end = forkSrc.indexOf(endMarker, start);
  expect(end, `${endMarker} not found after ${signature}`).toBeGreaterThan(start);
  return forkSrc.slice(start, end + endMarker.length);
}

describe('checkRequiredScopes — opt-in optional-scope auto-top-up', () => {
  // The all-critical-granted branch, up to (and including) its early return.
  // ⚠️ 窗口宽度要够：这个分支里加过注释/新分支（如「应用审核中就静默跳过」），
  // 卡太紧会让断言因为**文本被推出窗口**而红，看起来像行为回归，实际什么都没改。
  // 截到该分支真正的结尾（终局那句 all-critical-granted 日志之后的 return），不用会随
  // 注释漂移的固定字符宽度 —— 同款窗口在本次改动里已假红三次，见 fnRegionUntil。
  const region = forkRegionUntil('if (missingCritical.length === 0) {', 'all critical scopes granted');

  it('gates the top-up on a missing optional scope', () => {
    expect(region).toContain('if (missingOptional.length > 0 && brand === \'feishu\') {');
  });

  it('runs the top-up SILENTLY and WITHOUT a second QR (session-only)', () => {
    expect(region).toContain('disableQrLogin: true, silent: true');
    // passes no critical scopes (optional-only top-up)
    expect(region).toMatch(/tryAutoFixScopes\(larkAppId, bot, brand, \[\], missingOptional,/);
  });

  it('threads the already-granted scope names into the top-up (no-op-publish diff)', () => {
    // The auto-top-up must forward the scopes it already read back — bucketed by
    // token type — so automation can diff per bucket and skip publishing when
    // nothing is actually new (PR #1044). Bucketing avoids a tenant grant masking
    // a genuinely-missing user-side scope of the same name (PR #1044 R2).
    expect(region).toContain('grantedScopeNames: grantedScopeBuckets');
  });

  it('returns on a successful top-up (before the all-critical-granted log)', () => {
    const topUpIdx = region.indexOf('const toppedUp = await tryAutoFixScopes');
    // 成功判据必须是**真的补上了**（'fixed'），不能是「调用没抛」：应用审核中时
    // 开放平台连 scope/update 都拒（code=10046），一项都没写进去，报 topped-up 是谎报。
    const returnIdx = region.indexOf("if (toppedUp.kind === 'fixed') {", topUpIdx);
    const allGrantedLogIdx = region.indexOf('all critical scopes granted');
    expect(topUpIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(topUpIdx);
    // the success return sits before the terminal all-critical-granted log line
    expect(returnIdx).toBeLessThan(allGrantedLogIdx);
  });

  it('falls through to the normal early return when no session (no behavior change)', () => {
    // the terminal log + return are still present after the optional block
    expect(region).toContain('all critical scopes granted');
  });
});

describe('tryAutoFixScopes — silent / disableQrLogin plumbing', () => {
  // 截到函数体真正的结尾（catch 里那句 auto-fix error 日志），不用会随注释漂移的固定
  // 字符宽度 —— 这段历史上因窗口太窄假红过三次（详见 fnRegionUntil 的注释）。
  const region = forkRegionUntil('async function tryAutoFixScopes(', "logger.warn(`[${larkAppId}] auto-fix error:");

  it('accepts the disableQrLogin + silent opts', () => {
    expect(region).toContain('opts?: { disableQrLogin?: boolean; silent?: boolean; grantedScopeNames?: { tenant: string[]; user: string[] } }');
  });

  it('threads grantedScopeNames into the Open Platform automation', () => {
    expect(region).toContain('grantedScopeNames: opts?.grantedScopeNames,');
  });

  it('only requests the actually-missing scopes (filtered manifest, not the full 300+)', () => {
    // Regression: the automation was called with no scopeManifest, so it applied
    // the entire default manifest. It must now derive the manifest from the
    // missing critical+optional names and pass it through.
    expect(region).toContain('filterScopeManifest(readDefaultScopeManifest(), wantedScopeNames)');
    expect(region).toMatch(/const wantedScopeNames = \[\.\.\.missingCritical, \.\.\.missingOptional\]\.map\(s => s\.name\)/);
    expect(region).toContain('scopeManifest,');
  });

  it('threads disableQrLogin into the Open Platform automation', () => {
    expect(region).toContain('disableQrLogin: opts?.disableQrLogin,');
  });

  it('skips the admin success DM when silent', () => {
    // the silent early-return must sit before getAdminOpenId is read for the DM
    const silentIdx = region.indexOf("if (opts?.silent) return { kind: 'fixed' };");
    const adminIdx = region.indexOf('const adminOpenId = getAdminOpenId(bot);');
    expect(silentIdx).toBeGreaterThanOrEqual(0);
    expect(adminIdx).toBeGreaterThan(silentIdx);
  });

  it('does not claim success when zero scopes actually landed', () => {
    // Regression: `scopeCount` now means "how many of the MISSING ones landed",
    // so 0 most likely means "none applied" — not "nothing was missing". The old
    // single-ternary said 「所有必需权限已在应用清单中」in both cases, i.e. it
    // reported "all present" exactly when the top-up had fully failed.
    expect(region).toContain('const autoFixEffective =');
    // The three causes must be told apart: platform rejection (scopeWarning),
    // not-in-catalog (skippedScopeCount), genuinely nothing missing.
    expect(region).toContain('result.scopeWarning');
    expect(region).toContain('result.skippedScopeCount > 0');
    // ...and the honest branch must not reuse the "already present" wording.
    const ineffectiveIdx = region.indexOf('0 项权限已导入');
    expect(ineffectiveIdx, 'no explicit "0 项权限已导入" wording for the failed case').toBeGreaterThanOrEqual(0);
  });

  it('downgrades the log level and the DM headline when nothing landed', () => {
    // A failed top-up must not log `succeeded` at info, nor open the admin DM
    // with 「✅ 已自动修复了缺失的权限」— that headline is what makes an admin
    // stop looking, and this path (missing CRITICAL scopes) is the one that most
    // needs a human.
    expect(region).toContain('logger.warn(summary)');
    expect(region).toMatch(/autoFixEffective\s*$|autoFixEffective\s*\?/m);
    // 「没能全部落地」覆盖两种失败：权限一项都没申请上，以及权限进了清单但版本没提交
    // 发布（后者权限同样不生效，见 versionWarning）。原文案只说「没能申请成功」，
    // 对第二种是错的。
    expect(region).toContain('没能全部落地');
  });
});

/**
 * The 99991672 chicken-and-egg branch: the app lacks `self_manage`, so botmux
 * cannot even read its own scope list. It must still ask for every
 * botmux-required scope in one shot (so the NEXT restart's self-check passes),
 * but must not fall back to the full 300+ manifest.
 *
 * Source-region pinned for the same reason as above (checkRequiredScopes is a
 * network-driven function); the automation-side filtering itself is covered
 * behaviorally in test/setup-open-platform-automation.test.ts.
 */
