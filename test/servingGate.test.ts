/** Wave 2 serving-gate matrix (audit 2026-06-09 findings #3/#4/#6/#9/#14/#19).
 *
 *  One systemic bug: multiple independent timers wrote ad patches without
 *  consulting the global gates, so a killed or user-disabled install
 *  oscillated restore→re-patch forever. This suite parameterizes over the
 *  full mode matrix
 *
 *      {confirmed-kill, offline-unsure, healthy}
 *    × {K_ON on / off (deliberate disable)}
 *    × {crash-canary suspended / not}
 *
 *  for every writer — debug reassert tick, rotation tick, the 60s rotation
 *  refresh, the cliSync tick, bootCanary's boot-path writers, the webview
 *  reassert tick, cycleReassert, and the live loopback /ad route — and pins:
 *    • writes happen ONLY in (healthy, enabled, not-suspended);
 *    • restore happens ONLY on confirmed kill / deliberate disable;
 *    • offline-unsure FREEZES (no restore, no write);
 *    • /ad stops serving on confirmed kill / disable (webviews drop the
 *      overlay within one poll) but keeps serving through the offline freeze;
 *    • showActive never paints the green earning bar while gated;
 *    • the crash canary suspends the whole session until a manual re-enable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync }
  from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Hermetic module mocks (the cliSync leg must never touch the real
//    ~/.claude/settings.json, and the modes sentinels must read "on") ──────
const { cliApply, cliRestore } = vi.hoisted(() => ({
  cliApply: vi.fn(() => ({ ok: true })),
  cliRestore: vi.fn(() => ({ ok: true, restored: true })),
}));
vi.mock("../src/adapters/claude-cli/adapter", () => ({
  ClaudeCliStatuslineAdapter: class {
    spinnerVerbsSupported = true;
    constructor(_p: string) { /* hermetic stand-in */ }
    preflight() { return { ok: true, compatible: true, version: "cli" }; }
    applyPatch() { return cliApply(); }
    restore() { return cliRestore(); }
  },
}));
vi.mock("../src/adapters/claude-cli/cliVersion", () => ({
  // Never resolves: the detection re-sync path stays out of these tests.
  detectClaudeCliSpinnerSupport: () => new Promise(() => { /* pending */ }),
}));
vi.mock("../src/adapters/claude-cli/cliAd", () => ({
  writeCliAdCache: () => {},
  cliSessionActive: () => false,
  shouldCountCliImpression: () => false,
  shouldCountSpinnerImpression: () => false,
  FRESH_MS: 600_000,
}));
vi.mock("../src/modes", () => ({
  webviewMode: () => "on",
  cliMode: () => "on",
  bannerOverride: () => "server",
  setWebviewMode: () => {},
  setCliMode: () => {},
  setBannerOverride: () => {},
}));

import { resetServingGate, wireServingGateEnabled, setKillPosture,
  suspendServing, clearServingSuspension, servingSuspended,
  canPatch, canServeAds, servingVerdict } from "../src/servingGate";
import { setupAdRotation, type AdRotationDeps }
  from "../src/activation/adRotation";
import { setupCliSync } from "../src/activation/cliSync";
import { setupWebviewInjection } from "../src/activation/webviewInjection";
import { setupBootCanary } from "../src/activation/bootCanary";
import { setupEarningsRefresh } from "../src/activation/earningsRefresh";
import { DebugController } from "../src/debug";
import { createActivationContext, type ActivationContext }
  from "../src/activation/context";
import { SessionState } from "../src/sessionState";
import { EarningsClient } from "../src/earnings/client";
import type { AuthClient } from "../src/auth/client";
import { makeContext } from "./mocks/vscode";
import type { PatchAd, PortfolioResponse } from "../src/portfolio/client";

// ── The mode matrix ────────────────────────────────────────────────────────
interface Mode {
  kill: "clear" | "confirmed" | "offline";
  kOn: boolean;
  suspended: boolean;
}
const MODES: Mode[] = [];
for (const kill of ["clear", "confirmed", "offline"] as const)
  for (const kOn of [true, false])
    for (const suspended of [false, true])
      MODES.push({ kill, kOn, suspended });

/** Writes happen ONLY here. */
const writeAllowed = (m: Mode): boolean =>
  m.kill === "clear" && m.kOn && !m.suspended;
/** Restore happens ONLY on confirmed kill / deliberate disable. */
const restoreExpected = (m: Mode): boolean =>
  m.kill === "confirmed" || !m.kOn;
/** /ad serving stops ONLY on confirmed kill / disable (freeze keeps it). */
const serveAllowed = (m: Mode): boolean =>
  m.kill !== "confirmed" && m.kOn;

function applyMode(m: Mode): void {
  setKillPosture(m.kill);
  wireServingGateEnabled(() => m.kOn);
  if (m.suspended) suspendServing(); else clearServingSuspension();
}

beforeEach(() => { resetServingGate(); });

// ── Shared fixtures ────────────────────────────────────────────────────────
const AD_A: PatchAd = {
  adId: "ad-a", campaignId: "c-a", adText: "Linear -- plan, build, ship",
  iconRef: "icon.a", iconUrl: "", clickUrl: "https://a.test",
  bannerEnabled: false, sessionToken: "tok-a",
};
const AD_B: PatchAd = {
  adId: "ad-b", campaignId: "c-b", adText: "Railway -- deploy in seconds",
  iconRef: "icon.b", iconUrl: "", clickUrl: "https://b.test",
  bannerEnabled: false, sessionToken: "tok-b",
};
function mkResp(ads: PatchAd[]): PortfolioResponse {
  return { ad: ads[0] ?? null, ads, queueId: "q", ttlMs: 60_000,
    rotationIntervalMs: 120_000, viewThresholdMs: 3_000, balances: null };
}

const CANARY = join(homedir(), ".vibe-ads", "boot.canary");
const clearCanary = (): void => {
  try { rmSync(CANARY, { force: true }); } catch { /* best-effort */ }
};

const mkCcAdapter = () => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
  version: () => "2.1.143",
  isPatched: vi.fn(() => false),       // always "drifted" so reasserts fire
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

// ── Pure gate semantics ────────────────────────────────────────────────────
describe("servingGate verdicts", () => {
  it.each(MODES)("verdict matrix kill=$kill kOn=$kOn susp=$suspended", (m) => {
    applyMode(m);
    expect(canPatch()).toBe(writeAllowed(m));
    expect(servingVerdict() === "restore").toBe(restoreExpected(m));
    expect(canServeAds()).toBe(serveAllowed(m));
  });

  it("resetServingGate returns to healthy defaults", () => {
    applyMode({ kill: "confirmed", kOn: false, suspended: true });
    resetServingGate();
    expect(canPatch()).toBe(true);
    expect(servingVerdict()).toBe("write");
    expect(servingSuspended()).toBe(false);
  });
});

// ── Writer: rotation 60s refresh apply ────────────────────────────────────
function mkRotation(fetchResp: PortfolioResponse | null) {
  const timers: NodeJS.Timeout[] = [];
  const applyPatch = vi.fn(() => ({ ok: true }));
  const adRef = { current: AD_A as PatchAd | null };
  const deps = {
    adapter: { applyPatch, isPatched: () => true,
               preflight: () => ({ compatible: true }), restore: () => {} },
    portfolio: { fetchPortfolio: async () => fetchResp,
                 fetchDemoPortfolio: async () => fetchResp },
    auth: { accessToken: () => "tok", clientId: () => "cid" },
    debugCtl: { setPortfolioAd: vi.fn() },
    session: { set: vi.fn() },
    ccVersion: "2.1.167",
    port: 12345,
    patchParams: { adText: "", iconRef: "", iconUrl: "", clickUrl: "" },
    activeAdRef: { current: AD_A },
    corrRef: { current: "corr" },
    adRef,
    impDedupe: { reset: vi.fn() },
    reapplyCodex: null,
    timers,
  } as unknown as AdRotationDeps;
  return { deps, timers, applyPatch };
}

describe("matrix: rotation 60s refresh apply", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    const { deps, timers, applyPatch } = mkRotation(mkResp([AD_B]));
    try {
      const handle = setupAdRotation(deps, mkResp([AD_A]));
      applyPatch.mockClear();
      applyMode(m);
      await handle.refreshNow(true);   // forced refresh = the 60s apply path
      expect(applyPatch.mock.calls.length > 0,
        "refresh apply writes only when healthy+enabled+not-suspended")
        .toBe(writeAllowed(m));
    } finally { timers.forEach((t) => clearInterval(t)); }
  });

  it("a gated refresh does NOT latch the ad-set sig: recovery re-applies an unchanged set", async () => {
    const { deps, timers, applyPatch } = mkRotation(mkResp([AD_B]));
    try {
      const handle = setupAdRotation(deps, mkResp([AD_A]));
      applyPatch.mockClear();
      applyMode({ kill: "confirmed", kOn: true, suspended: false });
      await handle.refreshNow(true);     // gated: nothing may be written…
      expect(applyPatch).not.toHaveBeenCalled();
      applyMode({ kill: "clear", kOn: true, suspended: false });
      await handle.refreshNow(false);    // …recovery, same AD_B set, unforced
      expect(applyPatch,
        "the first healthy refresh must re-apply even an unchanged ad set")
        .toHaveBeenCalled();
    } finally { timers.forEach((t) => clearInterval(t)); }
  });
});

// ── Writer: rotation tick ──────────────────────────────────────────────────
describe("matrix: rotation tick", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", (m) => {
    vi.useFakeTimers();
    try {
      const { deps, timers, applyPatch } = mkRotation(null);
      const handle = setupAdRotation(deps, mkResp([AD_A, AD_B]));
      expect(handle.rotationTimer).not.toBeNull();
      applyPatch.mockClear();
      applyMode(m);
      vi.advanceTimersByTime(120_000);   // one rotation interval
      expect(applyPatch.mock.calls.length > 0,
        "rotation tick re-patches only when the gate says write")
        .toBe(writeAllowed(m));
      timers.forEach((t) => clearInterval(t));
    } finally { vi.useRealTimers(); }
  });
});

// ── Writer: cliSync tick ───────────────────────────────────────────────────
describe("matrix: cliSync tick", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", (m) => {
    cliApply.mockClear();
    cliRestore.mockClear();
    const actx = createActivationContext();
    try {
      applyMode(m);
      setupCliSync({
        actx, ctx: makeContext() as never,
        adapter: { restore: vi.fn() } as never,
        auth: { accessToken: () => "tok" } as never,
        metrics: { send: vi.fn() } as never,
        debugCtl: { setReassert: vi.fn(), setReassertCodex: vi.fn() } as never,
        ccVersion: "2.1.167",
        adRef: { current: AD_A },
        killedRef: { current: m.kill !== "clear" },
        reapplyCodex: null,
      });
      // setupCliSync runs the first sync synchronously — the 60s tick body.
      expect(cliApply.mock.calls.length > 0,
        "settings.json write only when healthy+enabled+not-suspended")
        .toBe(writeAllowed(m));
      expect(cliRestore.mock.calls.length > 0,
        "restore ONLY on confirmed kill / deliberate disable — offline FREEZES")
        .toBe(restoreExpected(m));
    } finally { actx.timers.forEach((t) => clearInterval(t)); }
  });
});

// ── Writer: debug 60s reassert tick ────────────────────────────────────────
describe("matrix: debug reassert tick", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    const adapter = mkCcAdapter();
    const d = new DebugController(
      adapter as never, makeContext() as never, () => {});
    try {
      await d.setOn(true);             // opted in; debug loopback minted
      adapter.applyPatch.mockClear();
      applyMode(m);
      await d.reassertTick();          // patch "drifted" (isPatched=false)
      expect(adapter.applyPatch.mock.calls.length > 0,
        "the 60s debug reassert must never fight a kill/freeze/disable")
        .toBe(writeAllowed(m));
    } finally { await d.dispose(); }
  });
});

// ── Writer: bootCanary boot-path (auto-enable / reapplyIfOn / cyclePatch) ──
describe("matrix: bootCanary boot-path writers", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    clearCanary();
    const adapter = mkCcAdapter();
    const ctx = makeContext();
    await ctx.globalState.update("kickbacks.debug.on", true); // K_ON persisted
    const d = new DebugController(adapter as never, ctx as never, () => {});
    try {
      applyMode(m);                    // e.g. the persisted-kill boot gate
      await setupBootCanary(adapter as never, d, ctx as never);
      expect(adapter.applyPatch.mock.calls.length > 0,
        "boot-path patching only when the gate is clear at boot")
        .toBe(writeAllowed(m));
    } finally { await d.dispose(); clearCanary(); }
  });
});

// ── bootCanary either-target auto-enable (codex-only machines) ────────────
// The clean-boot auto-enable used to gate on the CLAUDE preflight alone, so
// a Codex-only machine never persisted K_ON and never served. The widened
// 4th arg folds the codex preflight in; DebugController.apply() already
// treats a codex-only patch as success (wave-2A-F07).
describe("bootCanary either-target auto-enable (codex-only)", () => {
  const mkIncompatCc = () => ({
    name: "claude-code" as const,
    preflight: () => ({ ok: true, compatible: false, version: null,
      reason: "target not found" }),
    version: () => null,
    isPatched: vi.fn(() => false),
    applyPatch: vi.fn(() => ({ ok: false, reason: "target not found" })),
    restore: vi.fn(() => ({ ok: true, restored: false })),
  });
  const mkCodex = () => ({
    name: "codex" as const,
    preflight: () => ({ ok: true, compatible: true, version: "26.513.21555" }),
    version: () => "26.513.21555",
    isPatched: vi.fn(() => false),
    applyPatch: vi.fn(() => ({ ok: true })),
    restore: vi.fn(() => ({ ok: true, restored: true })),
  });

  it("anyTargetCompatible=true: codex-only clean boot persists K_ON via the"
    + " codex-folded apply", async () => {
    clearCanary();
    applyMode({ kill: "clear", kOn: true, suspended: false });
    const adapter = mkIncompatCc();
    const codex = mkCodex();
    const ctx = makeContext();
    const d = new DebugController(adapter as never, ctx as never, () => {});
    d.setCodexAdapter(codex as never);
    try {
      await setupBootCanary(adapter as never, d, ctx as never, true);
      expect(ctx.globalState.get("kickbacks.debug.on"),
        "K_ON must persist when the codex leg patches").toBe(true);
      expect(codex.applyPatch).toHaveBeenCalled();
    } finally { await d.dispose(); clearCanary(); }
  });

  it("flag omitted: legacy claude-only gate — codex-only boot does NOT"
    + " auto-enable", async () => {
    clearCanary();
    applyMode({ kill: "clear", kOn: true, suspended: false });
    const adapter = mkIncompatCc();
    const codex = mkCodex();
    const ctx = makeContext();
    const d = new DebugController(adapter as never, ctx as never, () => {});
    d.setCodexAdapter(codex as never);
    try {
      await setupBootCanary(adapter as never, d, ctx as never);
      expect(ctx.globalState.get("kickbacks.debug.on")).toBeUndefined();
      expect(codex.applyPatch).not.toHaveBeenCalled();
    } finally { await d.dispose(); clearCanary(); }
  });
});

// ── Webview-injection writers + the live loopback /ad route ───────────────
async function mkWebview() {
  const actx = createActivationContext();
  const adapter = mkCcAdapter();
  const killedRef = { current: false };
  const adRef = { current: AD_A as PatchAd | null };
  const metricsSend = vi.fn();
  const deps = {
    ctx: makeContext(), actx, adapter,
    auth: { accessToken: () => "tok", clientId: () => "cid" },
    debugCtl: { setPortfolioAd: () => {} },
    session: new SessionState(),
    portfolio: { fetchPortfolio: async () => null,
                 fetchDemoPortfolio: async () => null },
    metrics: { send: metricsSend },
    logTail: { current: () => ({}), activityAgeMs: () => null },
    testHooks: { handleTestRoute: async () => ({ status: 404, body: {} }) },
    statusBar: { set: () => {} },
    ccVersion: "2.1.143",
    killed: false, killedRef, adRef,
    portfolioResp: mkResp([AD_A]),
    viewThresholdMs: 3_000,
    statusBarShowActive: async () => {},
    scheduleEarningsRefresh: () => {},
    desyncState: { lastApplyAt: 0, lastBlockStartAt: 0 },
  };
  const r = await setupWebviewInjection(deps as never);
  return { r, adapter, actx, killedRef, metricsSend };
}

async function teardownWebview(actx: ActivationContext): Promise<void> {
  for (const t of actx.timers) clearInterval(t as NodeJS.Timeout);
  actx.timers.length = 0;
  if (actx.loopback) { await actx.loopback.stop(); actx.loopback = null; }
}

describe("matrix: webview cycleReassert", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    const { r, adapter, actx, killedRef } = await mkWebview();
    try {
      expect(r.cycleReassert).not.toBeNull();
      adapter.applyPatch.mockClear();
      adapter.restore.mockClear();
      applyMode(m);
      killedRef.current = m.kill !== "clear";  // what checkKill would set
      r.cycleReassert!();
      expect(adapter.applyPatch.mock.calls.length > 0,
        "cycle re-apply only when the gate says write")
        .toBe(writeAllowed(m));
      // The cycle's restore must not fire when gated either — a gated cycle
      // stripping the patch without re-applying would be its own bug.
      expect(adapter.restore.mock.calls.length > 0)
        .toBe(writeAllowed(m));
    } finally { await teardownWebview(actx); }
  });
});

describe("matrix: webview 60s reassert tick", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    vi.useFakeTimers();
    try {
      const { adapter, actx, killedRef } = await mkWebview();
      adapter.applyPatch.mockClear();
      applyMode(m);
      killedRef.current = m.kill !== "clear";
      vi.advanceTimersByTime(60_000);
      expect(adapter.applyPatch.mock.calls.length > 0,
        "the 60s production reassert must never fight a kill/freeze/disable")
        .toBe(writeAllowed(m));
      vi.useRealTimers();
      await teardownWebview(actx);
    } finally { vi.useRealTimers(); }
  });
});

describe("matrix: loopback /ad serving", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    const { r, actx, killedRef } = await mkWebview();
    try {
      expect(r.lbInfo).not.toBeNull();
      applyMode(m);
      killedRef.current = m.kill !== "clear";
      const res = await (await fetch(`${r.lbInfo!.base}/ad`)).json();
      if (serveAllowed(m)) {
        // Offline-unsure FREEZES: the running webview keeps its current ad.
        expect(res.adText).toBe(AD_A.adText);
      } else {
        // Confirmed kill / disable: the same empty payload as no-inventory —
        // new polls adopt nothing. NOTE an already-shown overlay ignores the
        // empty payload (pollAd only adopts NEW ads); its billing is cut by
        // the gated onEvent/onClick forwarding, pinned in the next describe.
        expect(res).toEqual({});
      }
    } finally { await teardownWebview(actx); }
  });
});

// ── The billing leg of audit #3: a live overlay outlives the /ad gate ─────
// pollAd ignores the empty /ad payload, so an already-running webview keeps
// POSTing view/click events straight through a confirmed kill or disable.
// The extension is the billing authority — the loopback onEvent/onClick
// forwarding must drop them itself.
describe("matrix: loopback event/click billing forwarding", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    const { r, actx, killedRef, metricsSend } = await mkWebview();
    try {
      expect(r.lbInfo).not.toBeNull();
      applyMode(m);
      killedRef.current = m.kill !== "clear";
      await fetch(`${r.lbInfo!.base}/view_tick?surface=overlay&visible_ms=5000`);
      await fetch(
        `${r.lbInfo!.base}/click?ct=overlay&surface=overlay&visible_ms=20000`);
      expect(metricsSend.mock.calls.length > 0,
        "billable forwarding only while the gate serves ads")
        .toBe(serveAllowed(m));
      if (serveAllowed(m)) {
        expect(metricsSend.mock.calls.map((c) => c[0]))
          .toEqual(expect.arrayContaining(["view_tick", "click"]));
      }
    } finally { await teardownWebview(actx); }
  });
});

// ── UI: showActive never paints the green earning bar while gated ─────────
function mkShowActive() {
  let tok: string | null = null;
  const statusBar = { set: vi.fn() };
  const session = new SessionState();
  const auth = { accessToken: () => tok } as unknown as AuthClient;
  const f = (async () => ({
    ok: true,
    json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }),
  })) as unknown as typeof fetch;
  const client = new EarningsClient("http://x", () => tok, f);
  const { showActive } = setupEarningsRefresh(
    auth, client, session, statusBar, "2.1.143", makeContext() as never);
  return { statusBar, showActive,
           setToken: (t: string | null) => { tok = t; } };
}

describe("matrix: showActive paint (audit #4)", () => {
  it.each(MODES)("kill=$kill kOn=$kOn susp=$suspended", async (m) => {
    const { statusBar, showActive, setToken } = mkShowActive();
    setToken("tok");                  // signed in with healthy earnings
    applyMode(m);
    statusBar.set.mockClear();
    await showActive();
    const kinds = statusBar.set.mock.calls.map(
      (c) => (c[0] as { kind: string }).kind);
    if (writeAllowed(m)) {
      expect(kinds).toContain("active");
    } else {
      expect(kinds, "never green while killed/offline/disabled/suspended")
        .not.toContain("active");
      const expected = m.kill === "confirmed" ? "killed"
        : m.kill === "offline" ? "offline" : "debug";
      expect(kinds).toContain(expected);
    }
  });
});

// ── Crash canary (audit #14): session-wide suspension, manual lift ────────
describe("crash-canary suspension (audit #14)", () => {
  it("a fresh crash canary suspends the WHOLE session's automatic writers;"
    + " only an explicit setOn(true) lifts it", async () => {
    const adapter = mkCcAdapter();
    const ctx = makeContext();
    await ctx.globalState.update("kickbacks.debug.on", true);
    const d = new DebugController(adapter as never, ctx as never, () => {});
    try {
      // Write the canary IMMEDIATELY before the call (no await in between):
      // a pending settle-unlink timer from an earlier test must not be able
      // to race the freshly-written file away.
      mkdirSync(join(homedir(), ".vibe-ads"), { recursive: true });
      writeFileSync(CANARY, String(Date.now()));
      await setupBootCanary(adapter as never, d, ctx as never);
      // The canary path patched nothing…
      expect(adapter.applyPatch).not.toHaveBeenCalled();
      // …and the suspension now gates the PRODUCTION activation path too
      // (pre-fix only setupBootCanary's own calls skipped, and the normal
      // path re-patched seconds after the "skipping automatic patch" toast).
      expect(servingSuspended()).toBe(true);
      expect(canPatch()).toBe(false);
      // The 60s debug reassert is suspended as well.
      await d.reassertTick();
      expect(adapter.applyPatch).not.toHaveBeenCalled();
      // Manual re-enable — the toast's "click the status bar to manually
      // re-enable" — lifts the suspension and patches again.
      await d.setOn(true);
      expect(servingSuspended()).toBe(false);
      expect(canPatch()).toBe(true);
      expect(adapter.applyPatch).toHaveBeenCalled();
    } finally { await d.dispose(); clearCanary(); }
  });
});

// ── Settle-unlink token guard: the 5s canary-clear timer may only delete the
//    canary it OWNS. The file lives in the shared ~/.vibe-ads, so a second
//    VS Code window (or a parallel test worker) can re-write it between our
//    write and our settle — an unguarded unlink stripped THAT activation's
//    crash protection (and was the source of this suite's cross-test flake).
describe("bootCanary settle-unlink token guard", () => {
  // setupBootCanary's writer legs are exercised by the matrix above; here a
  // stub DebugController keeps these tests to the canary file mechanics only
  // (on()=true skips auto-enable, so no loopback is minted under fake timers).
  const stubDebugCtl = () => ({
    on: () => true,
    shouldAutoEnableOnSignIn: () => false,
    setOn: vi.fn(async () => {}),
    reapplyIfOn: vi.fn(async () => {}),
    cyclePatch: () => ({ ok: true, reason: "stub" }),
  });

  it("clears its own canary once the settle window elapses", async () => {
    vi.useFakeTimers();
    clearCanary();
    try {
      await setupBootCanary(
        mkCcAdapter() as never, stubDebugCtl() as never, makeContext() as never);
      expect(existsSync(CANARY)).toBe(true);
      vi.advanceTimersByTime(6000);
      expect(existsSync(CANARY), "own canary clears after settle").toBe(false);
    } finally { vi.useRealTimers(); clearCanary(); }
  });

  it("leaves a canary re-written by another activation alone", async () => {
    vi.useFakeTimers();
    clearCanary();
    try {
      await setupBootCanary(
        mkCcAdapter() as never, stubDebugCtl() as never, makeContext() as never);
      // A second window / parallel worker re-writes the shared file before
      // our settle timer fires.
      writeFileSync(CANARY, "someone-elses-fresh-canary");
      vi.advanceTimersByTime(6000);
      expect(existsSync(CANARY),
        "a foreign canary must survive our settle timer").toBe(true);
      expect(readFileSync(CANARY, "utf8")).toBe("someone-elses-fresh-canary");
    } finally { vi.useRealTimers(); clearCanary(); }
  });
});
