/** Strict-xfail tripwire for DEFERRED audit-2026-06-09 finding #16
 * (mid-show rotation 2x credit). Backend siblings live in
 * backend/tests/test_audit_deferred_xfail.py (#26 consent default,
 * #41 multi-surface viewable counts).
 *
 * `it.fails` is vitest's strict-xfail: the body asserts the DESIRED
 * (post-fix) behavior, so today the test "passes" by failing. When the fix
 * lands the body starts passing, vitest reports the it.fails as a failure,
 * and whoever ships the fix flips it to a plain `it` — promoting this into
 * a real regression test. No silent drift in either direction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupStatusBarAd } from "../src/activation/statusBarAd";
import type { Activity } from "../src/activity/logTail";

function makeDeps() {
  const statusBar = { set: vi.fn() };
  const metrics = { send: vi.fn() };
  const logTail = {
    current: vi.fn().mockReturnValue(null),
    activityAgeMs: vi.fn().mockReturnValue(null),
  };
  return {
    logTail: logTail as any,
    metrics: metrics as any,
    statusBar,
    adRef: {
      current: {
        adId: "ad1", campaignId: "c1", adText: "Try Acme Widgets",
        iconRef: "", iconUrl: "", clickUrl: "https://acme.com",
        bannerEnabled: false, sessionToken: "tok1",
      },
    },
    killedRef: { current: false },
    ccVersion: "2.1.143",
    showActive: vi.fn().mockResolvedValue(undefined),
    timers: [] as NodeJS.Timeout[],
    barState: { adShowing: false },
  } as any;
}

function thinking(): Activity {
  return { tool: "Edit", elapsedMs: 1000, ts: Date.now(), done: false };
}

describe("audit #16 (deferred): mid-show ad rotation must not split surfaces onto two adIds", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.fails("stops billing the OLD ad once rotation swaps adRef mid-show", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);

    // t=1s: show starts and snapshots ad1.
    vi.advanceTimersByTime(1000);
    expect(d.metrics.send).toHaveBeenCalledWith("impression_rendered",
      expect.objectContaining({ adId: "ad1", surface: "statusbar" }));
    const callsBeforeSwap = d.metrics.send.mock.calls.length;

    // Mid-show rotation: every other surface (overlay, CLI, patchParams)
    // swaps to ad2; the per-(user,ad) cooldown bucket is keyed by ad_id, so
    // a statusbar still billing ad1 while the overlay bills ad2 credits
    // twice concurrently.
    d.adRef.current = {
      adId: "ad2", campaignId: "c2", adText: "Try Globex",
      iconRef: "", iconUrl: "", clickUrl: "https://globex.com",
      bannerEnabled: false, sessionToken: "tok2",
    };

    // Two view_tick intervals later, still thinking.
    vi.advanceTimersByTime(10_000);

    // DESIRED: the swap either ends the ad1 show (impression_viewable fires,
    // ticks stop) or re-snapshots to ad2 — either way, no billable view_tick
    // may carry the stale adId after the swap. TODAY: the eligibility check
    // never compares adIds, so the frozen shownAd keeps emitting ad1 ticks.
    const staleTicks = d.metrics.send.mock.calls
      .slice(callsBeforeSwap)
      .filter(([event, payload]: [string, any]) =>
        event === "view_tick" && payload?.adId === "ad1");
    expect(staleTicks).toHaveLength(0);
  });
});
