import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestHooks, type TestHooksContext } from "../src/testHooks";
import { MetricsClient } from "../src/metrics/client";
import { PortfolioClient, type PatchAd } from "../src/portfolio/client";
import { EarningsClient } from "../src/earnings/client";

const AD: PatchAd = {
  adId: "ad-1", campaignId: "c-1", adText: "Ramp - 30% faster",
  iconRef: "ramp", iconUrl: "", clickUrl: "https://ramp.com", bannerEnabled: false,
  sessionToken: "test-token",
};

function buildSuite(opts: { ad?: PatchAd | null;
                            signedIn?: boolean;
                            killed?: boolean;
                            viewThresholdMs?: number;
                            onBillableEvent?: () => void } = {}) {
  const calls: { url: string; body: Record<string, unknown>;
                 hdr: Record<string, string> }[] = [];
  const fakeFetch = vi.fn(async (url: string, init: { body: string;
      headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body), hdr: init.headers });
    return { ok: true, status: 200 } as Response;
  });
  const metrics = new MetricsClient("http://b", () => "tok",
    () => "cid", "0.1.0", fakeFetch as never);
  const portfolio = new PortfolioClient("http://b", () => "tok",
    fakeFetch as never);
  const earnings = new EarningsClient("http://b", () => "tok",
    fakeFetch as never);
  const ctx: TestHooksContext = {
    ad: opts.ad === undefined ? AD : opts.ad,
    signedIn: opts.signedIn ?? true,
    killed: opts.killed ?? false,
    ccVersion: "2.1.143",
    viewThresholdMs: opts.viewThresholdMs ?? 15000,
    loopback: { port: 12345, base: "http://127.0.0.1:12345/vibe-ads/tok" },
  };
  const hooks = new TestHooks(metrics, portfolio, earnings, () => ctx,
    opts.onBillableEvent ?? null);
  return { hooks, calls, fakeFetch, ctx };
}

describe("TestHooks", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fires impression_rendered through MetricsClient with default surface", async () => {
    const { hooks, calls } = buildSuite();
    const r = await hooks.fireImpressionRendered();
    expect(r.ok).toBe(true);
    expect(r.sent?.event).toBe("impression_rendered");
    expect(r.sent?.surface).toBe("overlay");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://b/v1/metrics");
    expect(calls[0].body).toMatchObject({
      event_type: "impression_rendered",
      ad_id: "ad-1",
      campaign_id: "c-1",
      claude_code_version: "2.1.143",
      surface: "overlay",
    });
    expect(typeof calls[0].body.nonce).toBe("string");
    expect(calls[0].hdr.authorization).toBe("Bearer tok");
    expect(calls[0].hdr["X-Vibe-Corr"]).toBeTypeOf("string");
  });

  it("honors surface override and accepts adId/campaignId when no ad loaded",
    async () => {
      const { hooks, calls } = buildSuite({ ad: null });
      const r = await hooks.fireClick({ surface: "banner",
        adId: "x1", campaignId: "y1" });
      expect(r.ok).toBe(true);
      expect(calls[0].body).toMatchObject({
        event_type: "click", ad_id: "x1", campaign_id: "y1", surface: "banner",
      });
    });

  it("returns ok:false when no ad and no override is supplied", async () => {
    const { hooks, calls } = buildSuite({ ad: null });
    const r = await hooks.fireImpressionRendered();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no ad/i);
    expect(calls).toHaveLength(0);
  });

  it("fireViewThresholdMet sets viewable/viewPct/viewMs and defaults visibleMs"
    + " to the configured threshold", async () => {
    const { hooks, calls } = buildSuite({ viewThresholdMs: 20000 });
    const r = await hooks.fireViewThresholdMet();
    expect(r.ok).toBe(true);
    expect(calls[0].body).toMatchObject({
      event_type: "view_threshold_met",
      viewable: true,
      view_pct: 100,
      visible_ms: 20000,
      view_ms: 20000,
      surface: "overlay",
    });
  });

  it("fireImpressionViewable marks viewable:true / viewPct:100", async () => {
    const { hooks, calls } = buildSuite();
    await hooks.fireImpressionViewable({ visibleMs: 7000 });
    expect(calls[0].body).toMatchObject({
      event_type: "impression_viewable",
      viewable: true,
      view_pct: 100,
      visible_ms: 7000,
    });
  });

  it("records each successful send in the ring and surfaces it via getState",
    async () => {
      const { hooks } = buildSuite();
      await hooks.fireImpressionRendered();
      await hooks.fireImpressionViewable({ surface: "banner" });
      await hooks.fireClick({ surface: "codex_overlay" });
      const state = hooks.getState();
      expect(state.lastEvents).toHaveLength(3);
      expect(state.lastEvents.map((e) => e?.event)).toEqual([
        "impression_rendered", "impression_viewable", "click",
      ]);
      expect(state.ad?.adId).toBe("ad-1");
      expect(state.loopback?.port).toBe(12345);
      hooks.clearEventLog();
      expect(hooks.getState().lastEvents).toHaveLength(0);
    });

  it("uses caller-supplied corr verbatim when provided", async () => {
    const { hooks, calls } = buildSuite();
    await hooks.fireClick({ corr: "fixed.corr.abc" });
    expect(calls[0].hdr["X-Vibe-Corr"]).toBe("fixed.corr.abc");
  });

  it("fireViewTick sends a heartbeat event with no viewable/viewPct fields"
    + " and threads visibleMs through", async () => {
    const { hooks, calls } = buildSuite();
    const r = await hooks.fireViewTick({ visibleMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.sent?.event).toBe("view_tick");
    expect(calls[0].body).toMatchObject({
      event_type: "view_tick", visible_ms: 5000, surface: "overlay",
    });
    expect("viewable" in calls[0].body).toBe(false);
    expect("view_pct" in calls[0].body).toBe(false);
  });

  it("fireViewTick bypasses ImpressionDedupe — three fires => three POSTs",
    async () => {
      const { hooks, calls } = buildSuite();
      await hooks.fireViewTick();
      await hooks.fireViewTick();
      await hooks.fireViewTick();
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.body.event_type === "view_tick")).toBe(true);
    });

  it("schedules earnings refresh after successful billable test-hook events",
    async () => {
      const onBillableEvent = vi.fn();
      const { hooks } = buildSuite({ onBillableEvent });
      await hooks.fireImpressionRendered();
      await hooks.fireViewTick();
      expect(onBillableEvent).not.toHaveBeenCalled();
      await hooks.fireImpressionViewable();
      await hooks.fireViewThresholdMet();
      await hooks.fireErrorImpression();
      await hooks.fireClick();
      expect(onBillableEvent).toHaveBeenCalledTimes(4);
    });

  it("refreshPortfolio calls PortfolioClient.fetchPortfolio with ccVersion"
    + " and surfaces the new ad", async () => {
    const ad2: PatchAd = { adId: "ad-2", campaignId: "c-2",
      adText: "New ad text", iconRef: "x", iconUrl: "", clickUrl: "https://x", bannerEnabled: false,
      sessionToken: "test-token-2" };
    // Override fetch on the suite to return a portfolio body with ad2.
    const ringCalls: { url: string; init: { headers: Record<string, string> } }[] = [];
    const portfolioBody = {
      ttl_seconds: 30,
      view_threshold_seconds: 25,
      ads: [{ ad_id: ad2.adId, campaign_id: ad2.campaignId, title_text: ad2.adText,
        icon_ref: ad2.iconRef, click_url: ad2.clickUrl, banner_enabled: false }],
    };
    const fakeFetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      ringCalls.push({ url, init });
      if (url.includes("/v1/portfolio")) {
        return {
          ok: true, status: 200,
          json: async () => portfolioBody,
        } as unknown as Response;
      }
      return { ok: true, status: 200 } as Response;
    });
    const { MetricsClient: M } = await import("../src/metrics/client");
    const { PortfolioClient: P } = await import("../src/portfolio/client");
    const { EarningsClient: E } = await import("../src/earnings/client");
    const metrics = new M("http://b", () => "tok",
      () => "cid", "0.1.0", fakeFetch as never);
    const portfolio = new P("http://b", () => "tok", fakeFetch as never);
    const earnings = new E("http://b", () => "tok", fakeFetch as never);
    const ctx: TestHooksContext = { ad: AD, signedIn: true, killed: false,
      ccVersion: "2.1.143", viewThresholdMs: 15000, loopback: null };
    const hooks = new TestHooks(metrics, portfolio, earnings, () => ctx);
    const got = await hooks.refreshPortfolio();
    expect(got?.adId).toBe("ad-2");
    expect(ringCalls[0].url).toContain("/v1/portfolio?claude_code_version=2.1.143");
    expect(ringCalls[0].init.headers.authorization).toBe("Bearer tok");
  });

  it("refreshEarnings returns whatever EarningsClient.fetch returns",
    async () => {
      const fakeFetch = vi.fn(async (url: string) => {
        if (url.includes("/v1/earnings")) {
          return {
            ok: true, status: 200,
            json: async () => ({ lifetime_usd: "12.34", today_usd: "1.50" }),
          } as unknown as Response;
        }
        return { ok: true, status: 200 } as Response;
      });
      const { MetricsClient: M } = await import("../src/metrics/client");
      const { PortfolioClient: P } = await import("../src/portfolio/client");
      const { EarningsClient: E } = await import("../src/earnings/client");
      const hooks = new TestHooks(
        new M("http://b", () => "tok", () => "cid", "0.1.0", fakeFetch as never),
        new P("http://b", () => "tok", fakeFetch as never),
        new E("http://b", () => "tok", fakeFetch as never),
        () => ({ ad: AD, signedIn: true, killed: false, ccVersion: "v",
          viewThresholdMs: 15000, loopback: null }));
      const earnings = await hooks.refreshEarnings();
      expect(earnings).toEqual({ lifetimeUsd: "12.34", todayUsd: "1.50" });
    });

  it("clearEventLog wipes the ring; subsequent fires record again", async () => {
    const { hooks } = buildSuite();
    await hooks.fireImpressionRendered();
    await hooks.fireImpressionViewable();
    await hooks.fireClick();
    expect(hooks.getState().lastEvents).toHaveLength(3);
    hooks.clearEventLog();
    expect(hooks.getState().lastEvents).toHaveLength(0);
    await hooks.fireViewTick();
    const ring = hooks.getState().lastEvents;
    expect(ring).toHaveLength(1);
    expect(ring[0]?.event).toBe("view_tick");
  });

  it("registerCommands wires every kickbacks.test.* id exactly once and"
    + " each handler invokes the corresponding TestHooks method", async () => {
    const { hooks } = buildSuite();
    // Hand-rolled minimal mock so the spy assertions stay focused on this
    // contract; reuses the real vscode mock's dispatching pattern.
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const subs: { dispose(): void }[] = [];
    const fakeCtx = { subscriptions: subs } as unknown as
      Parameters<typeof hooks.registerCommands>[0];
    const fakeVscode = await import("./mocks/vscode");
    // Reset shared handler map (it's module-scoped on the mock).
    fakeVscode.commands._handlers.clear();
    fakeVscode.commands._executed.length = 0;
    // Spy on the mock's registerCommand so we capture insertion order.
    const ids: string[] = [];
    const origReg = fakeVscode.commands.registerCommand.bind(fakeVscode.commands);
    fakeVscode.commands.registerCommand = function (id, h) {
      ids.push(id);
      handlers.set(id, h);
      return origReg(id, h);
    };
    try {
      hooks.registerCommands(fakeCtx);
      const expected = [
        "kickbacks.test.fireImpressionRendered",
        "kickbacks.test.fireImpressionViewable",
        "kickbacks.test.fireViewTick",
        "kickbacks.test.fireViewThresholdMet",
        "kickbacks.test.fireErrorImpression",
        "kickbacks.test.fireClick",
        "kickbacks.test.refreshPortfolio",
        "kickbacks.test.refreshEarnings",
        "kickbacks.test.getState",
        "kickbacks.test.clearEventLog",
      ];
      expect(ids).toEqual(expected);
      // Each id is registered exactly once.
      const counts = new Map<string, number>();
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
      // ExtensionContext gets a disposable per command.
      expect(subs.length).toBe(expected.length);
      // Invoking a fire command actually drives the hook (one POST queued).
      const r = await fakeVscode.commands.executeCommand(
        "kickbacks.test.fireClick", { surface: "banner" }) as { ok: boolean };
      expect(r.ok).toBe(true);
      expect(hooks.getState().lastEvents.some(
        (e) => e?.event === "click" && e.surface === "banner")).toBe(true);
      // getState is reachable via the dispatcher and returns a snapshot.
      const snap = await fakeVscode.commands.executeCommand(
        "kickbacks.test.getState") as { enabled: boolean };
      expect(snap.enabled).toBe(true);
    } finally {
      fakeVscode.commands.registerCommand = origReg;
    }
  });
});

// Separate suite that disables the gate via a per-suite mock.
describe("TestHooks gated off", () => {
  beforeEach(() => { vi.resetModules(); });
  it("returns ok:false and skips the network when test hooks are disabled",
    async () => {
      vi.doMock("../src/log", () => ({
        debugEnabled: () => false, dlog: () => {}, dlogRaw: () => {},
        codexEnabled: () => false, testHooksEnabled: () => false,
        LOG_PATH: "/tmp/test-log",
      }));
      const { TestHooks: GatedHooks } = await import("../src/testHooks");
      const { MetricsClient: M } = await import("../src/metrics/client");
      const { PortfolioClient: P } = await import("../src/portfolio/client");
      const { EarningsClient: E } = await import("../src/earnings/client");
      const calls: unknown[] = [];
      const f = vi.fn(async () => {
        calls.push("hit"); return { ok: true, status: 200 } as Response;
      });
      const hooks = new GatedHooks(
        new M("http://b", () => "tok", () => "cid", "0.1.0", f as never),
        new P("http://b", () => "tok", f as never),
        new E("http://b", () => "tok", f as never),
        () => ({ ad: AD, signedIn: true, killed: false,
                 ccVersion: "v", viewThresholdMs: 15000, loopback: null }));
      const r = await hooks.fireImpressionRendered();
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/disabled/);
      expect(calls).toHaveLength(0);
      vi.doUnmock("../src/log");
    });
});
