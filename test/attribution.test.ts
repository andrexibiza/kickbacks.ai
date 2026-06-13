/** Rotation/poll-lag billing attribution (audit 2026-06-09 finding #17).
 *
 *  A rotation flips the host's activeAd instantly, but the webview only
 *  learns of it from its own 10s /ad poll — so for up to 10s it keeps
 *  emitting the OLD ad's view events (its metric GETs carry an `ad=` claim)
 *  and possibly a click on the OLD anchor. Pre-fix the host stamped
 *  adId/campaignId/sessionToken from the NEW activeAd at arrival time:
 *  cross-campaign billing misattribution on every rotation boundary.
 *
 *  Pins:
 *    • the loopback lifts the `ad=` claim into the onEvent payload and the
 *      onClick args;
 *    • an event/click claiming the OLD ad after a swap bills the OLD
 *      campaign AND old session token (10s-stale token is fine, TTL 300s);
 *    • the deployed block sends the ad TEXT as its claim (viewShow(AD, …)),
 *      so text claims resolve too;
 *    • unknown/absent claims fall back to activeAd (pre-fix behavior);
 *    • the impression dedupe keys on the RESOLVED ad, so the old ad's late
 *      impression can't consume the new ad's dedupe slot (and repeats of the
 *      old ad's impression are still deduped within its own ad);
 *    • the wave-2 canServeAds gate still runs FIRST — a gated install bills
 *      nothing even for a known old-ad claim.
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

import { Loopback } from "../src/loopback";
import { resetServingGate, setKillPosture } from "../src/servingGate";
import { setupWebviewInjection } from "../src/activation/webviewInjection";
import { createActivationContext, type ActivationContext }
  from "../src/activation/context";
import { resetSharedLoopbackForTest } from "../src/util/loopbackBoot";
import { SessionState } from "../src/sessionState";
import { makeContext } from "./mocks/vscode";
import type { PatchAd, PortfolioResponse } from "../src/portfolio/client";

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

beforeEach(() => { resetServingGate(); resetSharedLoopbackForTest(); });

// ── Harness: real loopback + real webview injection wiring ────────────────
async function mkHarness() {
  const actx = createActivationContext();
  const killedRef = { current: false };
  const adRef = { current: AD_A as PatchAd | null };
  const metricsSend = vi.fn();
  let inventory: PortfolioResponse | null = null;
  // Mutable so the namespace-guard tests can flip the live sign-in state
  // mid-scenario (the guard reads auth.accessToken() at event time).
  const authState = { token: "tok" as string | null };
  const deps = {
    ctx: makeContext(), actx,
    adapter: {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      isPatched: () => true,
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    },
    auth: { accessToken: () => authState.token, clientId: () => "cid" },
    debugCtl: { setPortfolioAd: () => {} },
    session: new SessionState(),
    portfolio: { fetchPortfolio: async () => inventory,
                 fetchDemoPortfolio: async () => inventory },
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
  expect(r.lbInfo).not.toBeNull();
  const base = r.lbInfo!.base;
  return {
    r, actx, metricsSend, base, authState,
    /** Swap the live inventory and force a rotation apply (the real
     *  refreshPortfolio path — flips activeAd, re-mints corr, resets the
     *  impression dedupe, exactly what the 120s rotation tick does). */
    swapTo: async (ads: PatchAd[]) => {
      inventory = mkResp(ads);
      await r.refreshPortfolioNow!(true);
    },
  };
}

async function teardown(actx: ActivationContext): Promise<void> {
  for (const t of actx.timers) clearInterval(t as NodeJS.Timeout);
  actx.timers.length = 0;
  if (actx.loopback) { await actx.loopback.stop(); actx.loopback = null; }
}

type SentArgs = { adId: string; campaignId: string; sessionToken?: string };
const sent = (m: ReturnType<typeof vi.fn>): [string, SentArgs][] =>
  m.mock.calls.map((c) => [c[0] as string, c[1] as SentArgs]);

describe("rotation/poll-lag attribution (audit #17)", () => {

  it("a view event claiming the OLD ad id after a swap bills the OLD"
    + " campaign + session token; the new ad's events bill the new one",
    async () => {
    const h = await mkHarness();
    try {
      // Prime: one event while AD_A serves — registers it as recently served.
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=5000`);
      expect(sent(h.metricsSend)[0][1]).toMatchObject(
        { adId: "ad-a", campaignId: "c-a", sessionToken: "tok-a" });
      await h.swapTo([AD_B]);
      h.metricsSend.mockClear();
      // The webview hasn't polled /ad yet: its OLD view session keeps firing.
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=10000`);
      await fetch(
        `${h.base}/view_threshold_met?surface=overlay&ad=ad-a&visible_ms=16000`);
      // …and after its poll, the NEW ad's session fires too.
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-b&visible_ms=2000`);
      const calls = sent(h.metricsSend);
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toBe("view_tick");
      expect(calls[0][1]).toMatchObject(
        { adId: "ad-a", campaignId: "c-a", sessionToken: "tok-a" });
      expect(calls[1][0]).toBe("view_threshold_met");
      expect(calls[1][1]).toMatchObject(
        { adId: "ad-a", campaignId: "c-a", sessionToken: "tok-a" });
      expect(calls[2][1]).toMatchObject(
        { adId: "ad-b", campaignId: "c-b", sessionToken: "tok-b" });
    } finally { await teardown(h.actx); }
  });

  it("claims by ad TEXT resolve too (the deployed block keys its view"
    + " sessions by AD text and sends that as ad=)", async () => {
    const h = await mkHarness();
    try {
      await fetch(`${h.base}/view_tick?surface=overlay&visible_ms=5000`);
      await h.swapTo([AD_B]);
      h.metricsSend.mockClear();
      await fetch(`${h.base}/view_tick?surface=overlay`
        + `&ad=${encodeURIComponent(AD_A.adText)}&visible_ms=9000`);
      expect(sent(h.metricsSend)[0][1]).toMatchObject(
        { adId: "ad-a", campaignId: "c-a", sessionToken: "tok-a" });
    } finally { await teardown(h.actx); }
  });

  it("a click claiming the OLD ad (above the 15s floor) bills the OLD"
    + " campaign + token", async () => {
    const h = await mkHarness();
    try {
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=5000`);
      await h.swapTo([AD_B]);
      h.metricsSend.mockClear();
      await fetch(
        `${h.base}/click?ct=ck&surface=overlay&visible_ms=20000&ad=ad-a`);
      const calls = sent(h.metricsSend);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("click");
      expect(calls[0][1]).toMatchObject(
        { adId: "ad-a", campaignId: "c-a", sessionToken: "tok-a" });
    } finally { await teardown(h.actx); }
  });

  it("unknown claimed ad — and an absent claim — fall back to activeAd"
    + " (events and clicks)", async () => {
    const h = await mkHarness();
    try {
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=5000`);
      await h.swapTo([AD_B]);
      h.metricsSend.mockClear();
      await fetch(
        `${h.base}/view_tick?surface=overlay&ad=never-served&visible_ms=1000`);
      await fetch(`${h.base}/view_tick?surface=overlay&visible_ms=1000`);
      await fetch(`${h.base}/click?ct=ck&surface=overlay&visible_ms=20000`);
      const calls = sent(h.metricsSend);
      expect(calls).toHaveLength(3);
      for (const [, a] of calls) {
        expect(a).toMatchObject(
          { adId: "ad-b", campaignId: "c-b", sessionToken: "tok-b" });
      }
    } finally { await teardown(h.actx); }
  });

  it("impression dedupe keys on the RESOLVED ad: the old ad's late"
    + " impression doesn't consume the new ad's slot, and repeats are deduped"
    + " within their own ad", async () => {
    const h = await mkHarness();
    try {
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=5000`);
      await h.swapTo([AD_B]);
      h.metricsSend.mockClear();
      // Old ad's straggler impression (the poll-lag window)…
      await fetch(`${h.base}/impression_viewable?surface=overlay&ad=ad-a`);
      // …must NOT have consumed the NEW ad's dedupe slot…
      await fetch(`${h.base}/impression_viewable?surface=overlay&ad=ad-b`);
      // …while a REPEAT of the old ad's impression is deduped in its own ad.
      await fetch(`${h.base}/impression_viewable?surface=overlay&ad=ad-a`);
      const calls = sent(h.metricsSend);
      expect(calls).toHaveLength(2);
      expect(calls[0][1].adId).toBe("ad-a");
      expect(calls[1][1].adId).toBe("ad-b");
    } finally { await teardown(h.actx); }
  });

  it("the wave-2 canServeAds gate runs FIRST: a confirmed kill drops even a"
    + " known old-ad claim (event and click)", async () => {
    const h = await mkHarness();
    try {
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=5000`);
      await h.swapTo([AD_B]);
      h.metricsSend.mockClear();
      setKillPosture("confirmed");
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=9000`);
      await fetch(
        `${h.base}/click?ct=ck&surface=overlay&visible_ms=20000&ad=ad-a`);
      expect(h.metricsSend).not.toHaveBeenCalled();
    } finally { await teardown(h.actx); }
  });
});

// ── Token-namespace guard (2026-06-11) ─────────────────────────────────────
// A session token is HMAC-bound to a uid namespace (real g-* vs
// demo:<client_id>), but MetricsClient picks its route by LIVE auth state.
// A demo-era token forwarded on the authed route (or a real token after a
// sign-out, forwarded on the demo route) is a 100%-guaranteed server 403 —
// in prod this was a chronic all-403 stream of entire view sessions. The
// host now drops the mismatch at the relay instead of burning the send.
describe("token-namespace guard", () => {
  const AD_DEMO: PatchAd = { ...AD_B, sessionToken: "demo-tok", demo: true };

  it("drops view events whose attribution is demo-stamped while signed in", async () => {
    const h = await mkHarness();
    try {
      await h.swapTo([AD_DEMO]);                 // demo object, authed host
      h.metricsSend.mockClear();
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-b&visible_ms=5000`);
      await fetch(`${h.base}/click?ct=ck&surface=overlay&visible_ms=20000&ad=ad-b`);
      expect(h.metricsSend).not.toHaveBeenCalled();
    } finally { await teardown(h.actx); }
  });

  it("drops view events carrying a REAL token once signed out", async () => {
    const h = await mkHarness();
    try {
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=5000`);
      h.metricsSend.mockClear();
      h.authState.token = null;                  // sign-out; registry keeps tok-a
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-a&visible_ms=9000`);
      expect(h.metricsSend).not.toHaveBeenCalled();
    } finally { await teardown(h.actx); }
  });

  it("demo attribution + signed-out still bills (the legitimate demo path)", async () => {
    const h = await mkHarness();
    try {
      await h.swapTo([AD_DEMO]);
      h.authState.token = null;
      h.metricsSend.mockClear();
      await fetch(`${h.base}/view_tick?surface=overlay&ad=ad-b&visible_ms=5000`);
      const calls = sent(h.metricsSend);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject(
        { adId: "ad-b", campaignId: "c-b", sessionToken: "demo-tok" });
    } finally { await teardown(h.actx); }
  });
});

// ── The loopback lift itself (route → handler contract) ───────────────────
describe("loopback lifts the ad= claim (audit #17)", () => {
  it("metric routes surface claimedAdId in the payload; absent param stays"
    + " undefined; the click route passes it as the 5th onClick arg",
    async () => {
    const events: { kind: string; claimedAdId?: string }[] = [];
    const clicks: (string | undefined)[] = [];
    const lb = new Loopback({
      onEvent: (k, p) => { events.push({ kind: k, claimedAdId: p.claimedAdId }); },
      onClick: (_ct, _s, _v, _u, claimedAdId) => { clicks.push(claimedAdId); },
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;
    try {
      await fetch(`${base}/view_tick?surface=overlay&ad=ad-77&visible_ms=5000`);
      await fetch(`${base}/view_tick?surface=overlay&visible_ms=5000`);
      await fetch(`${base}/click?ct=ck&surface=overlay&visible_ms=1&ad=ad-77`);
      await fetch(`${base}/click?ct=ck&surface=overlay&visible_ms=1`);
      expect(events).toEqual([
        { kind: "view_tick", claimedAdId: "ad-77" },
        { kind: "view_tick", claimedAdId: undefined },
      ]);
      expect(clicks).toEqual(["ad-77", undefined]);
    } finally { await lb.stop(); }
  });
});
