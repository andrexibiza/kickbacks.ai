/** S9 dual-target webview injection: the codex-only serving path and the
 *  either-target honest-status contract.
 *
 *  Pins (against the claude-only-primary regression a public-mirror PR
 *  exposed — kickbacks.ai#1):
 *    • claudeCompatible:false skips the doomed Claude write entirely, applies
 *      Codex IMMEDIATELY (no 10s "unconfirmed" window), paints active — and
 *      NEVER arms desyncState.lastApplyAt (the claude-webview-cache watchdog
 *      has no claude apply to heal; lastApplyAt===0 keeps it passive).
 *    • A transient Claude apply miss while a Codex block is live must not
 *      relabel the bar "incompatible" (any-target-patched union).
 *    • The claude-compatible path is byte-identical to before (lastApplyAt
 *      armed by the claude apply only).
 *    • cycleReassert on a codex-only boot never restores/re-writes Claude.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/modes", () => ({
  webviewMode: () => "on",
  cliMode: () => "on",
  bannerOverride: () => "server",
  setWebviewMode: () => {},
  setCliMode: () => {},
  setBannerOverride: () => {},
}));

import { resetServingGate } from "../src/servingGate";
import { setupWebviewInjection } from "../src/activation/webviewInjection";
import { createActivationContext, type ActivationContext }
  from "../src/activation/context";
import { SessionState } from "../src/sessionState";
import { makeContext } from "./mocks/vscode";
import type { PatchAd } from "../src/portfolio/client";

beforeEach(() => { resetServingGate(); });

const AD: PatchAd = {
  adId: "ad-1", campaignId: "c-1", adText: "Linear -- plan, build, ship",
  iconRef: "icon.1", iconUrl: "", clickUrl: "https://a.test",
  bannerEnabled: false, sessionToken: "tok-1",
};

const mkCc = (o: { compatible?: boolean; applyOk?: boolean;
                   isPatched?: boolean } = {}) => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: o.compatible ?? true,
    version: "2.1.143" }),
  version: () => "2.1.143",
  isPatched: vi.fn(() => o.isPatched ?? false),
  applyPatch: vi.fn(() => (o.applyOk ?? true)
    ? { ok: true } : { ok: false, reason: "apply miss" }),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

const mkCodex = (o: { isPatched?: boolean } = {}) => ({
  name: "codex" as const,
  preflight: () => ({ ok: true, compatible: true, version: "26.513.21555" }),
  version: () => "26.513.21555",
  isPatched: vi.fn(() => o.isPatched ?? false),
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

async function mkWebview(opts: {
  adapter: ReturnType<typeof mkCc>;
  codexAdapter?: ReturnType<typeof mkCodex> | null;
  claudeCompatible?: boolean;
}) {
  const actx = createActivationContext();
  actx.codexAdapter = (opts.codexAdapter ?? null) as never;
  const desyncState = { lastApplyAt: 0, lastBlockStartAt: 0 };
  const statusBarSet = vi.fn();
  const showActive = vi.fn(async () => {});
  const deps = {
    ctx: makeContext(), actx, adapter: opts.adapter,
    auth: { accessToken: () => "tok", clientId: () => "cid" },
    debugCtl: { setPortfolioAd: () => {} },
    session: new SessionState(),
    portfolio: { fetchPortfolio: async () => null,
                 fetchDemoPortfolio: async () => null },
    metrics: { send: vi.fn() },
    logTail: { current: () => ({}), activityAgeMs: () => null },
    testHooks: { handleTestRoute: async () => ({ status: 404, body: {} }) },
    statusBar: { set: statusBarSet },
    ccVersion: opts.claudeCompatible === false
      ? "codex/26.513.21555" : "2.1.143",
    killed: false, killedRef: { current: false },
    adRef: { current: AD as PatchAd | null },
    portfolioResp: { ad: AD, ads: [AD], queueId: "q", ttlMs: 60_000,
      rotationIntervalMs: 120_000, viewThresholdMs: 3_000, balances: null },
    viewThresholdMs: 3_000,
    statusBarShowActive: showActive,
    scheduleEarningsRefresh: () => {},
    desyncState,
    ...(opts.claudeCompatible === undefined
      ? {} : { claudeCompatible: opts.claudeCompatible }),
  };
  const r = await setupWebviewInjection(deps as never);
  return { r, actx, desyncState, statusBarSet, showActive };
}

async function teardown(actx: ActivationContext): Promise<void> {
  for (const t of actx.timers) clearInterval(t as NodeJS.Timeout);
  actx.timers.length = 0;
  if (actx.loopback) { await actx.loopback.stop(); actx.loopback = null; }
}

describe("codex-only serving (claudeCompatible: false)", () => {
  it("skips the Claude write, applies Codex immediately, paints active,"
    + " never arms the desync watchdog", async () => {
    const adapter = mkCc({ compatible: false });
    const codex = mkCodex();
    const { r, actx, desyncState, statusBarSet, showActive } =
      await mkWebview({ adapter, codexAdapter: codex, claudeCompatible: false });
    try {
      expect(r.lbInfo).not.toBeNull();
      // No doomed Claude write — not even one attempt.
      expect(adapter.applyPatch).not.toHaveBeenCalled();
      // Codex applied SYNCHRONOUSLY at setup (not deferred to the 10s pass).
      expect(codex.applyPatch).toHaveBeenCalled();
      // Honest label: active, never "incompatible".
      expect(showActive).toHaveBeenCalled();
      expect(statusBarSet).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "incompatible" }));
      // The claude-webview desync watchdog stays passive: lastApplyAt===0
      // reads as "no-apply" in reassert.ts::desyncDecision. A codex apply
      // must never arm it (the mirror PR's exact mistake).
      expect(desyncState.lastApplyAt).toBe(0);
    } finally { await teardown(actx); }
  });

  it("cycleReassert never restores/re-writes Claude on a codex-only boot", async () => {
    const adapter = mkCc({ compatible: false });
    const codex = mkCodex();
    const { r, actx, desyncState } =
      await mkWebview({ adapter, codexAdapter: codex, claudeCompatible: false });
    try {
      adapter.applyPatch.mockClear();
      adapter.restore.mockClear();
      codex.applyPatch.mockClear();
      r.cycleReassert!();
      expect(adapter.restore).not.toHaveBeenCalled();
      expect(adapter.applyPatch).not.toHaveBeenCalled();
      expect(codex.applyPatch).toHaveBeenCalled();
      expect(desyncState.lastApplyAt).toBe(0);
    } finally { await teardown(actx); }
  });
});

describe("either-target honest status", () => {
  it("a transient Claude apply miss with a LIVE codex block does not relabel"
    + " the bar incompatible", async () => {
    const adapter = mkCc({ applyOk: false, isPatched: false });
    const codex = mkCodex({ isPatched: true });
    const { actx, statusBarSet, showActive } =
      await mkWebview({ adapter, codexAdapter: codex, claudeCompatible: true });
    try {
      expect(adapter.applyPatch).toHaveBeenCalled();        // tried (compatible)
      expect(statusBarSet).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "incompatible" }));
      expect(showActive).toHaveBeenCalled();                // deferred-to
    } finally { await teardown(actx); }
  });

  it("a Claude apply miss with NO patched target still labels incompatible"
    + " (no false-positive active)", async () => {
    const adapter = mkCc({ applyOk: false, isPatched: false });
    const { actx, statusBarSet } =
      await mkWebview({ adapter, codexAdapter: null, claudeCompatible: true });
    try {
      expect(statusBarSet).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "incompatible" }));
    } finally { await teardown(actx); }
  });

  it("claude-compatible path unchanged: the claude apply arms lastApplyAt"
    + " (codex never does)", async () => {
    const adapter = mkCc();
    const codex = mkCodex();
    const before = Date.now();
    const { actx, desyncState } =
      await mkWebview({ adapter, codexAdapter: codex });   // flag omitted
    try {
      expect(adapter.applyPatch).toHaveBeenCalled();
      expect(desyncState.lastApplyAt).toBeGreaterThanOrEqual(before);
    } finally { await teardown(actx); }
  });
});
