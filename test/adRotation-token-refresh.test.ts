import { describe, it, expect, vi, afterEach } from "vitest";
import { setupAdRotation, type AdRotationDeps } from "../src/activation/adRotation";
import type { PatchAd, PortfolioResponse } from "../src/portfolio/client";

// Regression: the server mints a FRESH session token on every /v1/portfolio(/demo)
// fetch (300s TTL). adRotation used to discard the refreshed response whenever the
// ad SET (adId signature) was unchanged — so the in-use `activeAd.sessionToken`
// aged out and every billable view event started returning 403 after ~5 min on
// stable inventory. The fix adopts the fresh token without re-patching the overlay.

function ad(adId: string, sessionToken: string): PatchAd {
  return {
    adId, campaignId: "c-" + adId, adText: "Ad " + adId,
    iconRef: "i", iconUrl: "", clickUrl: "https://x.test",
    bannerEnabled: false, sessionToken,
  };
}

function resp(ads: PatchAd[]): PortfolioResponse {
  return {
    ad: ads[0] ?? null, ads, queueId: "q", ttlMs: 60_000,
    rotationIntervalMs: 120_000, viewThresholdMs: 3_000, balances: null,
  };
}

function makeDeps(initial: PortfolioResponse, fetchImpl: () => Promise<PortfolioResponse>) {
  const timers: NodeJS.Timeout[] = [];
  const activeAdRef = { current: initial.ads[0] };
  const adRef = { current: initial.ads[0] as PatchAd | null };
  const applyPatch = vi.fn(() => ({ ok: true }));
  const deps = {
    adapter: { applyPatch, isPatched: () => true,
               preflight: () => ({ compatible: true }), restore: () => {} },
    portfolio: { fetchPortfolio: fetchImpl, fetchDemoPortfolio: fetchImpl },
    auth: { accessToken: () => "tok", clientId: () => "cid" },
    debugCtl: { setPortfolioAd: vi.fn() },
    session: { set: vi.fn() },
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
  return { deps, timers, activeAdRef, adRef, applyPatch };
}

describe("adRotation session-token refresh", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { cleanups.forEach((c) => c()); cleanups.length = 0; });

  it("adopts the fresh session token when the ad set is unchanged (no re-patch)", async () => {
    const initial = resp([ad("a1", "tok-OLD")]);
    const fetchImpl = vi.fn(async () => resp([ad("a1", "tok-NEW")])); // same adId, new token
    const { deps, timers, activeAdRef, adRef, applyPatch } = makeDeps(initial, fetchImpl);
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    applyPatch.mockClear();              // ignore any setup-time apply
    await handle.refreshNow(false);      // unchanged ad set → must still refresh token

    expect(fetchImpl).toHaveBeenCalled();
    expect(activeAdRef.current.sessionToken).toBe("tok-NEW");
    expect(adRef.current?.sessionToken).toBe("tok-NEW");
    // Unchanged text/clickUrl ⇒ the overlay must NOT be re-patched on a pure
    // token refresh (no visible churn, no loopback re-mint).
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("still swaps fully (re-patch) when the ad actually changes", async () => {
    const initial = resp([ad("a1", "tok-OLD")]);
    const fetchImpl = vi.fn(async () => resp([ad("a2", "tok-A2")])); // different adId
    const { deps, timers, activeAdRef, applyPatch } = makeDeps(initial, fetchImpl);
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    applyPatch.mockClear();
    await handle.refreshNow(false);

    expect(activeAdRef.current.adId).toBe("a2");
    expect(activeAdRef.current.sessionToken).toBe("tok-A2");
    expect(applyPatch).toHaveBeenCalled(); // real ad change ⇒ overlay re-patched
  });

  // BL-187: the demo stamp must travel WITH the adopted token. A mid-session
  // demotion can return the SAME adId from the demo portfolio; adopting only
  // the token left the object demo:false, so the status bar (whose signed-out
  // gate is `!ad.demo` — it has no signedIn() probe) kept showing and billing
  // ads while signed out.
  it("adopts the demo stamp when a demotion swaps to demo ads with the same id", async () => {
    const initial = resp([ad("a1", "tok-REAL")]);          // real: no demo flag
    const fetchImpl = vi.fn(async () =>
      resp([{ ...ad("a1", "demo-tok"), demo: true }]));    // demoted, same adId
    const { deps, timers, activeAdRef, adRef, applyPatch } = makeDeps(initial, fetchImpl);
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    applyPatch.mockClear();
    await handle.refreshNow(false);

    expect(activeAdRef.current.sessionToken).toBe("demo-tok");
    expect(activeAdRef.current.demo).toBe(true);   // statusbar gate re-engages
    expect(adRef.current?.demo).toBe(true);
    expect(applyPatch).not.toHaveBeenCalled();     // still a churn-free adopt
  });

  it("clears the demo stamp when a re-auth swaps back to real ads", async () => {
    const initial = resp([{ ...ad("a1", "demo-tok"), demo: true }]);
    const fetchImpl = vi.fn(async () => resp([ad("a1", "tok-REAL")])); // real again
    const { deps, timers, activeAdRef, adRef } = makeDeps(initial, fetchImpl);
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    await handle.refreshNow(false);

    expect(activeAdRef.current.sessionToken).toBe("tok-REAL");
    expect(activeAdRef.current.demo).toBeFalsy();  // real ads aren't suppressed
    expect(adRef.current?.demo).toBeFalsy();
  });
});

// Dead-token recovery (the "frozen ads" 401 loop, 2026-06-11): a client whose
// cached access token the server rejects used to 401 on /v1/portfolio every
// 60s FOREVER — refreshPortfolio swallowed the error, no fresh inventory ever
// arrived, and every surface kept the last-baked creative. The 60s refresh
// now routes through fetchPortfolioWithDemoFallback (same ladder as
// activation): one auth refresh, demote to demo ONLY on authoritative
// rejection, hold (no demotion) on transient failure.
describe("adRotation dead-token recovery (frozen-ads 401 loop)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { cleanups.forEach((c) => c()); cleanups.length = 0; });

  function makeAuthDeps(initial: PortfolioResponse, opts: {
    fetchPortfolio: () => Promise<PortfolioResponse | null>;
    fetchDemoPortfolio: () => Promise<PortfolioResponse | null>;
    refresh: () => Promise<boolean>;
    token: () => string | null;
  }) {
    const timers: NodeJS.Timeout[] = [];
    const activeAdRef = { current: initial.ads[0] };
    const adRef = { current: initial.ads[0] as PatchAd | null };
    const applyPatch = vi.fn(() => ({ ok: true }));
    const deps = {
      adapter: { applyPatch, isPatched: () => true,
                 preflight: () => ({ compatible: true }), restore: () => {} },
      portfolio: { fetchPortfolio: opts.fetchPortfolio,
                   fetchDemoPortfolio: opts.fetchDemoPortfolio },
      auth: { accessToken: opts.token, clientId: () => "cid",
              refresh: opts.refresh },
      debugCtl: { setPortfolioAd: vi.fn() },
      session: { set: vi.fn() },
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
    return { deps, timers, activeAdRef, adRef, applyPatch };
  }

  it("authoritative rejection: 401 portfolio + failed refresh that CLEARS "
    + "the token demotes to DEMO ads instead of spinning frozen", async () => {
    const initial = resp([ad("a1", "tok-DEAD")]);
    let token: string | null = "tok-DEAD";
    const fetchPortfolio = vi.fn(async () => null);          // 401, no cache
    const fetchDemoPortfolio = vi.fn(async () =>
      resp([{ ...ad("a1", "demo-tok"), demo: true }]));
    const refresh = vi.fn(async () => { token = null; return false; });
    const { deps, timers, activeAdRef, adRef } = makeAuthDeps(initial,
      { fetchPortfolio, fetchDemoPortfolio, refresh, token: () => token });
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    await handle.refreshNow(false);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchDemoPortfolio).toHaveBeenCalled();
    // Same adId → churn-free adopt of the demo token + stamp (BL-187 path).
    expect(activeAdRef.current.sessionToken).toBe("demo-tok");
    expect(activeAdRef.current.demo).toBe(true);
    expect(adRef.current?.demo).toBe(true);
  });

  it("transient failure: refresh fails but the token survives → HOLD the "
    + "current ad (no demo demotion, no churn)", async () => {
    const initial = resp([ad("a1", "tok-MAYBE-FINE")]);
    const fetchPortfolio = vi.fn(async () => null);          // offline this tick
    const fetchDemoPortfolio = vi.fn(async () =>
      resp([{ ...ad("a1", "demo-tok"), demo: true }]));
    const refresh = vi.fn(async () => false);                // transport failure
    const { deps, timers, activeAdRef, applyPatch } = makeAuthDeps(initial,
      { fetchPortfolio, fetchDemoPortfolio, refresh,
        token: () => "tok-MAYBE-FINE" });                    // token KEPT
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    applyPatch.mockClear();
    await handle.refreshNow(false);

    expect(fetchDemoPortfolio).not.toHaveBeenCalled();       // no demotion
    expect(activeAdRef.current.sessionToken).toBe("tok-MAYBE-FINE");
    expect(activeAdRef.current.demo).toBeFalsy();
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("revived token: 401 portfolio + successful refresh re-fetches REAL ads "
    + "(no demo detour)", async () => {
    const initial = resp([ad("a1", "tok-OLD")]);
    let refreshed = false;
    const fetchPortfolio = vi.fn(async () =>
      refreshed ? resp([ad("a1", "tok-REVIVED")]) : null);
    const fetchDemoPortfolio = vi.fn(async () => null);
    const refresh = vi.fn(async () => { refreshed = true; return true; });
    const { deps, timers, activeAdRef } = makeAuthDeps(initial,
      { fetchPortfolio, fetchDemoPortfolio, refresh, token: () => "tok-OLD" });
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    await handle.refreshNow(false);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchDemoPortfolio).not.toHaveBeenCalled();
    expect(activeAdRef.current.sessionToken).toBe("tok-REVIVED");
    expect(activeAdRef.current.demo).toBeFalsy();
  });
});
