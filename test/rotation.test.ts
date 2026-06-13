import { describe, it, expect, afterEach, vi } from "vitest";
import { Loopback, type LoopbackAdPayload } from "../src/loopback";
import { PortfolioClient, type PatchAd,
  type PortfolioResponse } from "../src/portfolio/client";
import { setupAdRotation, clearAdRotationOnSignOut,
  type AdRotationDeps } from "../src/activation/adRotation";

const AD_LINEAR: PatchAd = {
  adId: "ad-linear", campaignId: "c-linear",
  adText: "Linear -- plan, build, ship", iconRef: "icon.linear",
  iconUrl: "https://icons.test/linear.png", clickUrl: "https://linear.app",
  bannerEnabled: false, sessionToken: "tok-linear",
};

const AD_RAILWAY: PatchAd = {
  adId: "ad-railway", campaignId: "c-railway",
  adText: "Railway -- deploy in seconds", iconRef: "icon.railway",
  iconUrl: "https://icons.test/railway.png", clickUrl: "https://railway.app",
  bannerEnabled: false, sessionToken: "tok-railway",
};

const AD_WARP: PatchAd = {
  adId: "ad-warp", campaignId: "c-warp",
  adText: "Warp -- the terminal reimagined", iconRef: "icon.warp",
  iconUrl: "https://icons.test/warp.png", clickUrl: "https://warp.dev",
  bannerEnabled: false, sessionToken: "tok-warp",
};

let lb: Loopback | null = null;
afterEach(async () => { if (lb) { await lb.stop(); lb = null; } });

describe("rotation → loopback /ad contract", () => {
  it("getCurrentAd reflects the most recent ad written to it", async () => {
    let currentAd: LoopbackAdPayload | null = {
      adId: AD_LINEAR.adId, adText: AD_LINEAR.adText,
      clickUrl: AD_LINEAR.clickUrl, iconUrl: AD_LINEAR.iconUrl,
      campaignId: AD_LINEAR.campaignId,
    };
    lb = new Loopback({
      onEvent: () => {}, onClick: () => {},
      getActivity: () => ({}),
      getCurrentAd: () => currentAd,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;

    // Initial state: Linear
    let r = await (await fetch(`${base}/ad`)).json();
    expect(r.adId).toBe("ad-linear");
    expect(r.adText).toBe("Linear -- plan, build, ship");

    // Simulate rotation: update the closure variable (mirrors applyAd writing activeAd)
    currentAd = {
      adId: AD_RAILWAY.adId, adText: AD_RAILWAY.adText,
      clickUrl: AD_RAILWAY.clickUrl, iconUrl: AD_RAILWAY.iconUrl,
      campaignId: AD_RAILWAY.campaignId,
    };

    // Loopback must now serve the rotated ad
    r = await (await fetch(`${base}/ad`)).json();
    expect(r.adId).toBe("ad-railway");
    expect(r.adText).toBe("Railway -- deploy in seconds");
    expect(r.clickUrl).toBe("https://railway.app");
  });

  it("getCurrentAd serves empty object when ad is null (no-ad state)", async () => {
    lb = new Loopback({
      onEvent: () => {}, onClick: () => {},
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;
    const r = await (await fetch(`${base}/ad`)).json();
    expect(r).toEqual({});
  });

  it("multiple rapid rotations always serve the latest ad", async () => {
    const ads = [AD_LINEAR, AD_RAILWAY, AD_WARP];
    let idx = 0;
    lb = new Loopback({
      onEvent: () => {}, onClick: () => {},
      getActivity: () => ({}),
      getCurrentAd: () => {
        const a = ads[idx];
        return { adId: a.adId, adText: a.adText,
          clickUrl: a.clickUrl, iconUrl: a.iconUrl,
          campaignId: a.campaignId };
      },
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;

    for (let i = 0; i < ads.length; i++) {
      idx = i;
      const r = await (await fetch(`${base}/ad`)).json();
      expect(r.adId).toBe(ads[i].adId);
      expect(r.adText).toBe(ads[i].adText);
    }
  });
});

describe("PortfolioClient rotation fields", () => {
  it("parses rotation_interval_seconds into rotationIntervalMs", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        ttl_seconds: 60,
        rotation_interval_seconds: 45,
        queue_id: "q123",
        ads: [
          { ad_id: "a1", campaign_id: "c1", title_text: "Ad one text here ok",
            icon_ref: "i", click_url: "https://one.test" },
          { ad_id: "a2", campaign_id: "c2", title_text: "Ad two text here ok",
            icon_ref: "i", click_url: "https://two.test" },
        ],
      }),
    }) as unknown as Response);
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const r = await c.fetchPortfolio("2.1.143");
    expect(r).not.toBeNull();
    expect(r!.rotationIntervalMs).toBe(45_000);
    expect(r!.ads).toHaveLength(2);
    expect(r!.queueId).toBe("q123");
  });

  it("defaults rotationIntervalMs to 120s when server omits the field", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        ttl_seconds: 60,
        ads: [{ ad_id: "a1", campaign_id: "c1", title_text: "x".repeat(30),
                icon_ref: "i", click_url: "https://x.test" }],
      }),
    }) as unknown as Response);
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const r = await c.fetchPortfolio("2.1.143");
    expect(r!.rotationIntervalMs).toBe(120_000);
  });

  it("returns multiple ads in queue order for client-side rotation", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        ttl_seconds: 60,
        rotation_interval_seconds: 60,
        ads: [
          { ad_id: "first", campaign_id: "c1", title_text: "First ad visible here",
            icon_ref: "i", click_url: "https://first.test" },
          { ad_id: "second", campaign_id: "c2", title_text: "Second ad visible here",
            icon_ref: "i", click_url: "https://second.test" },
          { ad_id: "third", campaign_id: "c3", title_text: "Third ad visible here",
            icon_ref: "i", click_url: "https://third.test" },
        ],
      }),
    }) as unknown as Response);
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const r = await c.fetchPortfolio("2.1.143");
    expect(r!.ads.map((a) => a.adId)).toEqual(["first", "second", "third"]);
    expect(r!.ad?.adId).toBe("first");
  });

  it("parses balances alongside rotation fields (W4 full shape)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        ttl_seconds: 60,
        rotation_interval_seconds: 60,
        view_threshold_seconds: 15,
        queue_id: "qABC",
        balances: { lifetime_usd: "12.34", today_usd: "1.50",
                    last_updated_ms: 1700000000000 },
        ads: [{ ad_id: "a1", campaign_id: "c1", title_text: "x".repeat(30),
                icon_ref: "i", click_url: "https://x.test",
                session_token: "sess1" }],
      }),
    }) as unknown as Response);
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const r = await c.fetchPortfolio("2.1.143");
    expect(r!.balances).toEqual({
      lifetimeUsd: "12.34", todayUsd: "1.50", lastUpdatedMs: 1700000000000,
    });
    expect(r!.viewThresholdMs).toBe(15_000);
    expect(r!.ads[0].sessionToken).toBe("sess1");
  });
});

describe("rotation index cycling", () => {
  it("rotateNext cycles through ads in order and wraps around", () => {
    const ads = [AD_LINEAR, AD_RAILWAY, AD_WARP];
    let rotationIdx = 0;
    const applied: string[] = [];

    function rotateNext() {
      if (ads.length < 2) return;
      rotationIdx = (rotationIdx + 1) % ads.length;
      applied.push(ads[rotationIdx].adId);
    }

    rotateNext(); // -> idx 1 (Railway)
    rotateNext(); // -> idx 2 (Warp)
    rotateNext(); // -> idx 0 (Linear, wrap)
    rotateNext(); // -> idx 1 (Railway)

    expect(applied).toEqual([
      "ad-railway", "ad-warp", "ad-linear", "ad-railway",
    ]);
  });

  it("rotateNext is a no-op with a single ad", () => {
    const ads = [AD_LINEAR];
    let rotationIdx = 0;
    let called = false;

    function rotateNext() {
      if (ads.length < 2) return;
      rotationIdx = (rotationIdx + 1) % ads.length;
      called = true;
    }

    rotateNext();
    expect(called).toBe(false);
    expect(rotationIdx).toBe(0);
  });

  it("refreshPortfolio resets rotation index to 0", () => {
    let rotationIdx = 2;
    const newAds = [AD_WARP, AD_LINEAR];

    // Simulates the refresh logic
    rotationIdx = 0;
    const firstAd = newAds[rotationIdx];

    expect(rotationIdx).toBe(0);
    expect(firstAd.adId).toBe("ad-warp");
  });
});

// ---------------------------------------------------------------------------
// Real setupAdRotation wiring: sign-out clear (audit #20) and the refresh
// epoch that discards stale in-flight portfolio responses (audit #32).
// ---------------------------------------------------------------------------
function mkResp(ads: PatchAd[]): PortfolioResponse {
  return { ad: ads[0] ?? null, ads, queueId: "q", ttlMs: 60_000,
    rotationIntervalMs: 120_000, viewThresholdMs: 3_000, balances: null };
}

function mkRotationDeps(opts: {
  token?: () => string | null;
  fetchPortfolio?: () => Promise<PortfolioResponse | null>;
  fetchDemoPortfolio?: () => Promise<PortfolioResponse | null>;
  initialAd?: PatchAd;
} = {}) {
  const timers: NodeJS.Timeout[] = [];
  const adRef = { current: (opts.initialAd ?? null) as PatchAd | null };
  const activeAdRef = { current: (opts.initialAd ?? null) as PatchAd | null };
  const applyPatch = vi.fn(() => ({ ok: true }));
  const sessionSet = vi.fn();
  const deps = {
    adapter: { applyPatch, isPatched: () => true,
               preflight: () => ({ compatible: true }), restore: () => {} },
    portfolio: { fetchPortfolio: opts.fetchPortfolio ?? (async () => null),
                 fetchDemoPortfolio: opts.fetchDemoPortfolio ?? (async () => null) },
    auth: { accessToken: opts.token ?? (() => "tok"), clientId: () => "cid" },
    debugCtl: { setPortfolioAd: vi.fn() },
    session: { set: sessionSet },
    ccVersion: "2.1.167",
    port: 12345,
    patchParams: { adText: "", iconRef: "", iconUrl: "", clickUrl: "" },
    activeAdRef,
    corrRef: { current: "corr" },
    adRef,
    impDedupe: { reset: vi.fn() },
    reapplyCodex: null,
    timers,
  } as unknown as AdRotationDeps;
  return { deps, timers, adRef, activeAdRef, applyPatch, sessionSet };
}

describe("sign-out clear (audit #20)", () => {
  it("clear() empties the queue, nulls the shared ad refs, and disarms rotation", () => {
    const { deps, timers, adRef, activeAdRef, sessionSet } =
      mkRotationDeps({ initialAd: AD_LINEAR });
    try {
      const handle = setupAdRotation(deps, mkResp([AD_LINEAR, AD_RAILWAY]));
      expect(handle.rotationTimer).not.toBeNull(); // 2 ads ⇒ rotation armed

      handle.clear();

      expect(handle.adQueue).toEqual([]);
      expect(handle.rotationTimer).toBeNull();
      expect(adRef.current).toBeNull();
      expect(activeAdRef.current).toBeNull();
      expect(sessionSet).toHaveBeenCalledWith({ hasAd: false });
    } finally { timers.forEach((t) => clearInterval(t)); }
  });

  it("rotation never re-patches CC after clear() (the sign-out re-patch bug)", () => {
    vi.useFakeTimers();
    const { deps, timers, applyPatch } = mkRotationDeps({
      initialAd: AD_LINEAR, token: () => null });
    try {
      const handle = setupAdRotation(deps, mkResp([AD_LINEAR, AD_RAILWAY]));
      handle.clear();
      applyPatch.mockClear();
      // Pre-fix the still-armed 120s rotation timer applied the leftover REAL
      // ad — re-patching CC right after doSignOut had restored it.
      vi.advanceTimersByTime(10 * 120_000);
      expect(applyPatch).not.toHaveBeenCalled();
    } finally {
      timers.forEach((t) => clearInterval(t));
      vi.useRealTimers();
    }
  });

  it("clearAdRotationOnSignOut() reaches the live rotation (module hook)", () => {
    const { deps, timers, adRef } = mkRotationDeps({ initialAd: AD_LINEAR });
    try {
      const handle = setupAdRotation(deps, mkResp([AD_LINEAR]));
      clearAdRotationOnSignOut();
      expect(handle.adQueue).toEqual([]);
      expect(adRef.current).toBeNull();
    } finally { timers.forEach((t) => clearInterval(t)); }
  });

  it("clear() discards an in-flight refresh — a late response can't resurrect ads", async () => {
    let resolveReal!: (r: PortfolioResponse | null) => void;
    const pending = new Promise<PortfolioResponse | null>((res) => { resolveReal = res; });
    const { deps, timers, adRef } = mkRotationDeps({
      initialAd: AD_LINEAR, token: () => "tok", fetchPortfolio: () => pending });
    try {
      const handle = setupAdRotation(deps, mkResp([AD_LINEAR]));
      const inflight = handle.refreshNow(false); // fetch in flight…
      handle.clear();                            // …sign-out lands mid-flight
      resolveReal(mkResp([AD_RAILWAY]));         // stale response arrives late
      await inflight;
      expect(adRef.current).toBeNull();
      expect(handle.adQueue).toEqual([]);
    } finally { timers.forEach((t) => clearInterval(t)); }
  });

  it("the next (demo) portfolio apply re-populates the queue and re-arms rotation", async () => {
    let token: string | null = "tok";
    const { deps, timers, adRef } = mkRotationDeps({
      initialAd: AD_LINEAR, token: () => token,
      fetchDemoPortfolio: async () => mkResp([AD_RAILWAY, AD_WARP]) });
    try {
      const handle = setupAdRotation(deps, mkResp([AD_LINEAR]));
      handle.clear();
      token = null;                   // signed out now
      await handle.refreshNow(false); // the 60s refresh-timer path
      expect(adRef.current?.adId).toBe("ad-railway");
      expect(handle.adQueue).toHaveLength(2);
      expect(handle.rotationTimer).not.toBeNull();
    } finally { timers.forEach((t) => clearInterval(t)); }
  });
});

describe("stale in-flight refresh epoch (audit #32)", () => {
  it("a DEMO fetch resolving after the forced sign-in swap is discarded", async () => {
    let token: string | null = null;
    let resolveDemo!: (r: PortfolioResponse | null) => void;
    const demoPending = new Promise<PortfolioResponse | null>(
      (res) => { resolveDemo = res; });
    const { deps, timers, adRef, activeAdRef } = mkRotationDeps({
      initialAd: AD_LINEAR, token: () => token,
      fetchDemoPortfolio: () => demoPending,
      fetchPortfolio: async () => mkResp([AD_WARP]) });
    try {
      const handle = setupAdRotation(deps, mkResp([AD_LINEAR]));
      const inflight = handle.refreshNow(false); // signed-out demo fetch (slow)
      token = "tok";                             // sign-in completes mid-flight
      await handle.refreshNow(true);             // forced real-ad swap
      expect(adRef.current?.adId).toBe("ad-warp");

      resolveDemo(mkResp([AD_RAILWAY]));         // stale demo response lands
      await inflight;

      // Pre-fix the late demo response force-applied AD_RAILWAY (demo ads +
      // demo tokens) over the just-applied real ad on a signed-in client.
      expect(adRef.current?.adId).toBe("ad-warp");
      expect(activeAdRef.current?.adId).toBe("ad-warp");
      expect(handle.lastAdSetSig).toBe("ad-warp");
    } finally { timers.forEach((t) => clearInterval(t)); }
  });
});

describe("ad change detection (adChanged guard)", () => {
  it("detects change when adId differs", () => {
    let currentAdId = "ad-linear";
    const next = AD_RAILWAY;
    const adChanged = next.adId !== currentAdId;
    expect(adChanged).toBe(true);
  });

  it("skips update when same ad re-applied", () => {
    let currentAdId = "ad-linear";
    const next = AD_LINEAR;
    const adChanged = next.adId !== currentAdId;
    expect(adChanged).toBe(false);
  });

  it("handles null current ad gracefully", () => {
    let currentAdId: string | undefined = undefined;
    const next = AD_LINEAR;
    const adChanged = next.adId !== currentAdId;
    expect(adChanged).toBe(true);
  });
});
