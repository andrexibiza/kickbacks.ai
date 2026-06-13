import { describe, it, expect, vi } from "vitest";
import { ViewTimer, type ThresholdEvent, type TickEvent,
  type ErrorImpressionEvent } from "../src/viewTracking/timer";

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// NOTE (audit 2026-06-09 #23 / wave-1 EXT-03, verified 2026-06-10): the
// ViewTimer class under test is NOT shipped — no production code imports it
// (the live timers are block.asset.js `_vt`, codex/block.asset.js, and
// statusBarAd.ts's inline interval). The no-op hide()/pause() and unbounded
// catch-up semantics pinned below are therefore DEAD-CODE contracts kept for
// the reference implementation only; the shipped surfaces END sessions on
// hide and clamp suspend/wake gaps — see test/cc-viewtimer.test.ts for the
// production contract. Port that clamp before ever wiring this class up.
describe("ViewTimer (W3)", () => {
  // Tests focused on the natural threshold-met path disable the
  // error_impression safety net (`maxSessionMs: 0`). With the default cap of
  // 5s and threshold of 15s, mutual exclusion (added 2026-05-21 to fix the
  // Codex-flagged double-bill) would make error_impression fire first and
  // suppress threshold_met. The "fires onErrorImpression exactly once" test
  // below covers the safety-net case independently.
  it("fires onThresholdMet exactly once after 15s of visibility", () => {
    const c = clock();
    const met = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 15_000, maxSessionMs: 0,
      now: c.now, onThresholdMet: met });
    vt.show("ad-A", "overlay", "sess-1");
    for (let i = 0; i < 16; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(1);
    const [evt] = met.mock.calls[0] as [ThresholdEvent];
    expect(evt.adId).toBe("ad-A");
    expect(evt.surface).toBe("overlay");
    expect(evt.sessionNonce).toBe("sess-1");
    expect(evt.thresholdMs).toBe(15_000);

    // Continuing past the threshold must NOT re-fire.
    for (let i = 0; i < 30; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(1);
  });

  it("does not fire threshold below the configured time", () => {
    const c = clock();
    const met = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 15_000, maxSessionMs: 0,
      now: c.now, onThresholdMet: met });
    vt.show("ad-A", "overlay", "s");
    for (let i = 0; i < 14; i++) { c.advance(1_000); vt.poll(); }
    expect(met).not.toHaveBeenCalled();
  });

  it("hide() is a no-op under the absolute-epoch baseline", () => {
    // Post-refactor (2026-05-22): elapsed time = now() - sessionStartedAt,
    // not an accumulator. hide() no longer pauses accumulation because the
    // 250ms poll cadence can't be relied on to re-anchor accurately under
    // throttling. A hidden ad still progresses toward billing; mutual
    // exclusion + server-side gates bound the impact.
    const c = clock();
    const met = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 15_000, maxSessionMs: 0,
      now: c.now, onThresholdMet: met });
    vt.show("ad-A", "overlay", "s");
    for (let i = 0; i < 5; i++) { c.advance(1_000); vt.poll(); }
    vt.hide("ad-A", "overlay");
    // Elapsed clock keeps running through "hidden"; threshold fires at 15s.
    for (let i = 0; i < 10; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(1);
  });

  it("pause() and resume() are no-ops under the absolute-epoch baseline", () => {
    // Same rationale as hide(): the baseline is sticky; pause() no longer
    // gates accumulation. Kept as public API so callers don't need rewriting.
    const c = clock();
    const met = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 15_000, maxSessionMs: 0,
      now: c.now, onThresholdMet: met });
    vt.show("ad-A", "overlay", "s");
    vt.pause();
    for (let i = 0; i < 15; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(1);   // fires anyway at 15s elapsed
    vt.resume();   // no-op, no crash
  });

  it("tracks overlay and banner independently for the same ad", () => {
    const c = clock();
    const met = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 15_000, maxSessionMs: 0,
      now: c.now, onThresholdMet: met });
    vt.show("ad-A", "overlay", "s1");
    vt.show("ad-A", "banner", "s1");
    for (let i = 0; i < 16; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(2);
    const surfaces = met.mock.calls.map((c) => (c[0] as ThresholdEvent).surface);
    expect(surfaces.sort()).toEqual(["banner", "overlay"]);
  });

  it("emits view_tick at every tickMs of accumulated visible time", () => {
    const c = clock();
    const tick = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 60_000, tickMs: 5_000, now: c.now,
      onTick: tick });
    vt.show("ad-A", "overlay", "s");
    for (let i = 0; i < 16; i++) { c.advance(1_000); vt.poll(); }
    // Visible 16s, ticks at 5/10/15 → 3 ticks.
    expect(tick).toHaveBeenCalledTimes(3);
    const visibleAt = tick.mock.calls.map((c) => (c[0] as TickEvent).visibleMs);
    expect(visibleAt).toEqual([5_000, 10_000, 15_000]);
  });

  it("fires onErrorImpression at every maxSessionMs boundary (5s cadence)", () => {
    // New repeated-billing contract (2026-05-22): error_impression is
    // not one-shot — it fires at every multiple of maxSessionMs (5/10/
    // 15/20/...) so a stuck session keeps generating billable events.
    // The backend cooldown gate decides which credit.
    const c = clock();
    const met = vi.fn();
    const errImp = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 60_000, maxSessionMs: 5_000,
      now: c.now, onThresholdMet: met, onErrorImpression: errImp });
    vt.show("ad-A", "overlay", "s1");
    for (let i = 0; i < 4; i++) { c.advance(1_000); vt.poll(); }
    expect(errImp).not.toHaveBeenCalled();   // not yet at 5s
    c.advance(1_000); vt.poll();             // 5s → fire #1
    expect(errImp).toHaveBeenCalledTimes(1);
    const [evt] = errImp.mock.calls[0] as [ErrorImpressionEvent];
    expect(evt.adId).toBe("ad-A");
    expect(evt.surface).toBe("overlay");
    expect(evt.sessionNonce).toBe("s1");
    expect(evt.maxSessionMs).toBe(5_000);
    expect(evt.visibleMs).toBeGreaterThanOrEqual(5_000);

    // 10s → fire #2; 15s → fire #3; ... etc.
    for (let i = 0; i < 5; i++) { c.advance(1_000); vt.poll(); }
    expect(errImp).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) { c.advance(1_000); vt.poll(); }
    expect(errImp).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 25; i++) { c.advance(1_000); vt.poll(); }
    expect(errImp).toHaveBeenCalledTimes(8);   // 5/10/15/20/25/30/35/40s

    // threshold_met is suppressed for the whole stuck session — any
    // error_impression having fired blocks it permanently.
    expect(met).not.toHaveBeenCalled();
  });

  it("does NOT burst-fire on a throttled poll (one fire per call)", () => {
    // If poll() skips many boundaries (e.g. the tab was throttled for
    // 30s and only one poll fires), we MUST NOT spam N fires in one
    // tick — that would double-bill on a recovery from throttling.
    // The contract is "fire one, advance counter by one, fire the rest
    // on subsequent polls."
    const c = clock();
    const errImp = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 60_000, maxSessionMs: 5_000,
      now: c.now, onErrorImpression: errImp });
    vt.show("ad-A", "overlay", "s1");
    c.advance(30_000);   // 30s elapsed in one jump
    vt.poll();           // single poll
    expect(errImp).toHaveBeenCalledTimes(1);  // only one fire, not 6
    vt.poll();
    expect(errImp).toHaveBeenCalledTimes(2);
    vt.poll();
    expect(errImp).toHaveBeenCalledTimes(3);
  });

  it("threshold_met and error_impression mutex still holds with repeated firing", () => {
    // Codex adversarial review (2026-05-21) plus the every-5s refactor
    // (2026-05-22): the two billing paths must not BOTH bill a session.
    //
    // threshold-first config (threshold < cap): threshold_met fires at 3s,
    // error_impression at 5s is suppressed (thresholdMet flag latches it).
    const c1 = clock();
    const met1 = vi.fn();
    const err1 = vi.fn();
    const vt1 = new ViewTimer({ thresholdMs: 3_000, maxSessionMs: 5_000,
      now: c1.now, onThresholdMet: met1, onErrorImpression: err1 });
    vt1.show("ad-A", "overlay", "s1");
    for (let i = 0; i < 30; i++) { c1.advance(1_000); vt1.poll(); }
    expect(met1).toHaveBeenCalledTimes(1);
    expect(err1).not.toHaveBeenCalled();

    // error-first config (cap < threshold; current ship default of 5s/15s):
    // error_impression fires at 5/10/15/20s (4 events in 20s), threshold_met
    // is suppressed for the whole session.
    const c2 = clock();
    const met2 = vi.fn();
    const err2 = vi.fn();
    const vt2 = new ViewTimer({ thresholdMs: 15_000, maxSessionMs: 5_000,
      now: c2.now, onThresholdMet: met2, onErrorImpression: err2 });
    vt2.show("ad-B", "overlay", "s2");
    for (let i = 0; i < 20; i++) { c2.advance(1_000); vt2.poll(); }
    expect(err2).toHaveBeenCalledTimes(4);   // 5/10/15/20s
    expect(met2).not.toHaveBeenCalled();
  });

  it("error_impression resets with a new sessionNonce", () => {
    const c = clock();
    const errImp = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 60_000, maxSessionMs: 5_000,
      now: c.now, onErrorImpression: errImp });
    vt.show("ad-A", "overlay", "s1");
    for (let i = 0; i < 6; i++) { c.advance(1_000); vt.poll(); }
    expect(errImp).toHaveBeenCalledTimes(1);
    vt.show("ad-A", "overlay", "s2");   // fresh session
    for (let i = 0; i < 6; i++) { c.advance(1_000); vt.poll(); }
    expect(errImp).toHaveBeenCalledTimes(2);
  });

  it("maxSessionMs: 0 disables the error_impression safety net", () => {
    const c = clock();
    const errImp = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 60_000, maxSessionMs: 0,
      now: c.now, onErrorImpression: errImp });
    vt.show("ad-A", "overlay", "s");
    for (let i = 0; i < 60; i++) { c.advance(1_000); vt.poll(); }
    expect(errImp).not.toHaveBeenCalled();
  });

  it("new sessionNonce resets accumulation for the same (ad, surface)", () => {
    const c = clock();
    const met = vi.fn();
    const vt = new ViewTimer({ thresholdMs: 15_000, maxSessionMs: 0,
      now: c.now, onThresholdMet: met });
    vt.show("ad-A", "overlay", "s1");
    for (let i = 0; i < 16; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(1);
    vt.show("ad-A", "overlay", "s2");   // fresh session
    for (let i = 0; i < 14; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) { c.advance(1_000); vt.poll(); }
    expect(met).toHaveBeenCalledTimes(2);
  });
});
