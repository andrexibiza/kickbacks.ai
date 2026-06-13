// /test/<name> driver routes on the loopback: lets external scripts (curl,
// CI runners) fire every kickbacks.test.* hook against a running extension
// without going through VS Code's command dispatcher. The extension wires
// these up in activate() (extension.ts) by passing `onTestRoute` to the
// Loopback constructor; this suite drives the contract directly against a
// real Loopback + TestHooks pair so it stays hermetic.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Loopback } from "../src/loopback";
import { TestHooks, type TestHooksContext } from "../src/testHooks";
import { MetricsClient } from "../src/metrics/client";
import { PortfolioClient, type PatchAd } from "../src/portfolio/client";
import { EarningsClient } from "../src/earnings/client";

const AD: PatchAd = { adId: "ad-route", campaignId: "c-route",
  adText: "x", iconRef: "i", iconUrl: "", clickUrl: "https://x", bannerEnabled: false,
  sessionToken: "test-token" };

let lb: Loopback | null = null;
afterEach(async () => { if (lb) { await lb.stop(); lb = null; } });

function wire(opts: { adOverride?: PatchAd | null;
                       viewThresholdMs?: number } = {}) {
  const calls: { url: string; method: string;
                 body?: unknown; headers: Record<string, string> }[] = [];
  const fakeFetch = vi.fn(async (url: string, init?: { method?: string;
      body?: string; headers?: Record<string, string> }) => {
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? (() => {
      try { return JSON.parse(init.body!); } catch { return init.body; } })() : undefined;
    calls.push({ url, method, body, headers: init?.headers || {} });
    if (url.includes("/v1/portfolio")) {
      return { ok: true, status: 200, json: async () => ({
        ttl_seconds: 30, view_threshold_seconds: 18,
        ads: [{ ad_id: "ad-fresh", campaign_id: "c-fresh",
          title_text: "x", icon_ref: "i", click_url: "https://x" }],
      }) } as Response;
    }
    if (url.includes("/v1/earnings")) {
      return { ok: true, status: 200, json: async () =>
        ({ lifetime_usd: "5.00", today_usd: "0.50" }) } as Response;
    }
    return { ok: true, status: 204, json: async () => ({}) } as Response;
  });
  const metrics = new MetricsClient("http://b", () => "tok",
    () => "cid", "0.1.0", fakeFetch as never);
  const portfolio = new PortfolioClient("http://b", () => "tok",
    fakeFetch as never);
  const earnings = new EarningsClient("http://b", () => "tok",
    fakeFetch as never);
  const ctx: TestHooksContext = {
    ad: opts.adOverride === undefined ? AD : opts.adOverride,
    signedIn: true,
    killed: false,
    ccVersion: "2.1.143",
    viewThresholdMs: opts.viewThresholdMs ?? 15000,
    loopback: null,
  };
  const hooks = new TestHooks(metrics, portfolio, earnings, () => ctx);
  return { hooks, calls };
}

async function makeServer(hooks: TestHooks): Promise<string> {
  lb = new Loopback({
    onEvent: () => {},
    onClick: () => {},
    getActivity: () => ({}),
    getCurrentAd: () => null,
    onTestRoute: (n, p) => hooks.handleTestRoute(n, p),
  });
  const { port, token } = await lb.start();
  return `http://127.0.0.1:${port}/vibe-ads/${token}`;
}

describe("loopback /test/<name> driver routes", () => {

  it("fireClick returns 200 with FireResult JSON and POSTs /v1/metrics",
    async () => {
      const { hooks, calls } = wire();
      const base = await makeServer(hooks);
      const r = await fetch(`${base}/test/fireClick?surface=banner&ct=mytok`);
      expect(r.status).toBe(200);
      const body = await r.json() as { ok: boolean; sent: { event: string; surface: string; adId: string } };
      expect(body.ok).toBe(true);
      expect(body.sent.event).toBe("click");
      expect(body.sent.surface).toBe("banner");
      expect(body.sent.adId).toBe("ad-route");
      const metricsPosts = calls.filter((c) => c.url.endsWith("/v1/metrics"));
      expect(metricsPosts).toHaveLength(1);
      expect(metricsPosts[0].body).toMatchObject({
        event_type: "click", ad_id: "ad-route", campaign_id: "c-route",
        surface: "banner",
      });
    });

  it("fireImpressionRendered / fireImpressionViewable / fireViewTick /"
    + " fireViewThresholdMet each round-trip through the route and into"
    + " MetricsClient (every event type exercised over HTTP)", async () => {
    const { hooks, calls } = wire({ viewThresholdMs: 20000 });
    const base = await makeServer(hooks);
    const r1 = await (await fetch(`${base}/test/fireImpressionRendered`)).json();
    const r2 = await (await fetch(`${base}/test/fireImpressionViewable?visibleMs=8000`)).json();
    const r3 = await (await fetch(`${base}/test/fireViewTick?visibleMs=5000`)).json();
    const r4 = await (await fetch(`${base}/test/fireViewThresholdMet`)).json();
    expect((r1 as { ok: boolean }).ok).toBe(true);
    expect((r2 as { ok: boolean }).ok).toBe(true);
    expect((r3 as { ok: boolean }).ok).toBe(true);
    expect((r4 as { ok: boolean }).ok).toBe(true);
    const posts = calls.filter((c) => c.url.endsWith("/v1/metrics"));
    expect(posts.map((p) => (p.body as { event_type: string }).event_type))
      .toEqual([
        "impression_rendered", "impression_viewable",
        "view_tick", "view_threshold_met",
      ]);
    // view_threshold_met defaults visibleMs to viewThresholdMs from context.
    const last = posts[3].body as { visible_ms: number; view_ms: number };
    expect(last.visible_ms).toBe(20000);
    expect(last.view_ms).toBe(20000);
  });

  it("adId/campaignId/corr query params override the live ad context",
    async () => {
      const { hooks, calls } = wire({ adOverride: null });
      const base = await makeServer(hooks);
      const url = `${base}/test/fireImpressionRendered`
        + `?surface=codex_overlay&adId=X&campaignId=Y&corr=my.fixed.corr`;
      const r = await (await fetch(url)).json() as { ok: boolean };
      expect(r.ok).toBe(true);
      const post = calls.find((c) => c.url.endsWith("/v1/metrics"))!;
      expect(post.body).toMatchObject({
        event_type: "impression_rendered", ad_id: "X",
        campaign_id: "Y", surface: "codex_overlay",
      });
      expect(post.headers["X-Vibe-Corr"]).toBe("my.fixed.corr");
    });

  it("refreshPortfolio + refreshEarnings + getState + clearEventLog "
    + "read-only / state routes", async () => {
    const { hooks } = wire();
    const base = await makeServer(hooks);
    // refreshPortfolio returns the new ad
    const port = await (await fetch(`${base}/test/refreshPortfolio`)).json() as
      { adId: string };
    expect(port.adId).toBe("ad-fresh");
    // refreshEarnings returns parsed payload
    const earn = await (await fetch(`${base}/test/refreshEarnings`)).json() as
      { lifetimeUsd: string; todayUsd: string };
    expect(earn).toEqual({ lifetimeUsd: "5.00", todayUsd: "0.50" });
    // getState reflects ring state
    await fetch(`${base}/test/fireImpressionRendered`);
    const s1 = await (await fetch(`${base}/test/getState`)).json() as
      { lastEvents: { event: string }[] };
    expect(s1.lastEvents).toHaveLength(1);
    // clearEventLog wipes the ring
    await fetch(`${base}/test/clearEventLog`);
    const s2 = await (await fetch(`${base}/test/getState`)).json() as
      { lastEvents: unknown[] };
    expect(s2.lastEvents).toHaveLength(0);
  });

  it("unknown route returns 404 JSON instead of crashing", async () => {
    const { hooks } = wire();
    const base = await makeServer(hooks);
    const r = await fetch(`${base}/test/notARealHook`);
    expect(r.status).toBe(404);
    const body = await r.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/unknown route/);
  });

  it("/test/* is invisible without an onTestRoute handler (default Loopback"
    + " falls through to 404 — confirms routes are opt-in per host)",
    async () => {
      lb = new Loopback({
        onEvent: () => {},
        onClick: () => {},
        getActivity: () => ({}),
      getCurrentAd: () => null,
      });
      const { port, token } = await lb.start();
      const r = await fetch(
        `http://127.0.0.1:${port}/vibe-ads/${token}/test/fireClick`);
      expect(r.status).toBe(404);
    });

  it("CORS preflight: OPTIONS /test/* gets a 204 with the loopback headers",
    async () => {
      const { hooks } = wire();
      const base = await makeServer(hooks);
      const r = await fetch(`${base}/test/fireClick`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
    });
});

describe("loopback /test/* gated off", () => {
  afterEach(async () => { if (lb) { await lb.stop(); lb = null; } });

  it("returns 403 when testHooksEnabled() is false at request time",
    async () => {
      vi.resetModules();
      vi.doMock("../src/log", () => ({
        debugEnabled: () => false, dlog: () => {}, dlogRaw: () => {},
        codexEnabled: () => false, testHooksEnabled: () => false,
        LOG_PATH: "/tmp/test-log",
      }));
      const { Loopback: L } = await import("../src/loopback");
      const { TestHooks: TH } = await import("../src/testHooks");
      const { MetricsClient: M } = await import("../src/metrics/client");
      const { PortfolioClient: P } = await import("../src/portfolio/client");
      const { EarningsClient: E } = await import("../src/earnings/client");
      const fakeFetch = vi.fn(async () =>
        ({ ok: true, status: 204, json: async () => ({}) } as Response));
      const hooks = new TH(
        new M("http://b", () => "tok", () => "cid", "0.1.0", fakeFetch as never),
        new P("http://b", () => "tok", fakeFetch as never),
        new E("http://b", () => "tok", fakeFetch as never),
        () => ({ ad: AD, signedIn: true, killed: false,
          ccVersion: "v", viewThresholdMs: 15000, loopback: null }));
      lb = new L({
        onEvent: () => {}, onClick: () => {}, getActivity: () => ({}),
        getCurrentAd: () => null,
        onTestRoute: (n, p) => hooks.handleTestRoute(n, p),
      });
      const { port, token } = await lb.start();
      const r = await fetch(
        `http://127.0.0.1:${port}/vibe-ads/${token}/test/fireClick`);
      expect(r.status).toBe(403);
      const body = await r.json() as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toMatch(/disabled/);
      vi.doUnmock("../src/log");
    });
});
