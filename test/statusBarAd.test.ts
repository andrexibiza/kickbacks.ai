import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupStatusBarAd, type StatusBarAdDeps } from "../src/activation/statusBarAd";
import type { Activity } from "../src/activity/logTail";

function makeDeps(overrides: Partial<StatusBarAdDeps> = {}): StatusBarAdDeps & {
  statusBar: { set: ReturnType<typeof vi.fn>; lastState: unknown };
  metrics: { send: ReturnType<typeof vi.fn> };
  showActive: ReturnType<typeof vi.fn>;
  logTail: {
    current: ReturnType<typeof vi.fn>;
    activityAgeMs: ReturnType<typeof vi.fn>;
  };
} {
  const statusBar = { set: vi.fn(), lastState: null as unknown };
  statusBar.set.mockImplementation((s: unknown) => { statusBar.lastState = s; });
  const metrics = { send: vi.fn() };
  const showActive = vi.fn().mockResolvedValue(undefined);
  const logTail = {
    current: vi.fn().mockReturnValue(null),
    activityAgeMs: vi.fn().mockReturnValue(null),
  };
  return {
    logTail: logTail as any,
    metrics: metrics as any,
    statusBar,
    adRef: { current: { adId: "ad1", campaignId: "c1",
      adText: "Try Acme Widgets", iconRef: "", iconUrl: "",
      clickUrl: "https://acme.com", bannerEnabled: false,
      sessionToken: "tok1" } },
    killedRef: { current: false },
    ccVersion: "2.1.143",
    showActive,
    timers: [],
    barState: { adShowing: false },
    ...overrides,
  } as any;
}

function thinking(): Activity {
  return { tool: "Edit", elapsedMs: 1000, ts: Date.now(), done: false };
}
function idle(): Activity {
  return { tool: "Edit", elapsedMs: 5000, ts: Date.now(), done: true };
}

describe("setupStatusBarAd", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does nothing when logTail returns null", () => {
    const d = makeDeps();
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("shows ad text when the transcript is fresh but not parseable yet", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(null);
    d.logTail.activityAgeMs.mockReturnValue(500);
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad", adText: "Try Acme Widgets" }));
    expect(d.metrics.send).toHaveBeenCalledWith("impression_rendered",
      expect.objectContaining({ surface: "statusbar" }));
  });

  it("ignores stale transcript writes when the tail cannot be parsed", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(null);
    d.logTail.activityAgeMs.mockReturnValue(5000);
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("does nothing when done === true (idle)", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(idle());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("shows ad text on first thinking detection", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad", adText: "Try Acme Widgets" }));
  });

  it("fires impression_rendered with surface statusbar", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    expect(d.metrics.send).toHaveBeenCalledWith("impression_rendered",
      expect.objectContaining({
        adId: "ad1", campaignId: "c1", surface: "statusbar",
      }));
  });

  it("does not re-fire impression_rendered while still thinking", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(5000);
    const renderedCalls = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_rendered");
    expect(renderedCalls).toHaveLength(1);
  });

  it("fires view_tick every 5 seconds while showing", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(11_000);
    const tickCalls = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(tickCalls.length).toBeGreaterThanOrEqual(2);
    expect(tickCalls[0][1]).toMatchObject({ surface: "statusbar" });
  });

  it("fires impression_viewable when thinking ends", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    const viewableCalls = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_viewable");
    expect(viewableCalls).toHaveLength(1);
    expect(viewableCalls[0][1]).toMatchObject({ surface: "statusbar" });
    expect(viewableCalls[0][1].visibleMs).toBeGreaterThan(0);
  });

  it("calls showActive after 6-second hold when thinking ends", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(2000);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    expect(d.showActive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6000);
    expect(d.showActive).toHaveBeenCalledTimes(1);
  });

  it("does NOT show a (demo) ad when signed out — keeps the Sign-in label", () => {
    // Demo mode: a signed-out user has a demo ad in hand (from the demo
    // portfolio), but the status bar must NOT render it — the lower status-bar
    // text stays the red "Kickbacks: Sign in" call-to-action while signed out.
    // The demo ad still renders in-window (the overlay surface); only this
    // status-bar surface gates on sign-in. No impression metrics fire either,
    // since nothing is shown here.
    const d = makeDeps();
    d.adRef.current = { ...d.adRef.current!, demo: true, sessionToken: "" };
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("does not show ad when killed", () => {
    const d = makeDeps();
    d.killedRef.current = true;
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("does not show ad when no ad available", () => {
    const d = makeDeps();
    d.adRef.current = null;
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("re-shows ad on next thinking burst after idle", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(2000);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(8000);
    d.metrics.send.mockClear();
    d.logTail.current.mockReturnValue(thinking());
    vi.advanceTimersByTime(1000);
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad" }));
    expect(d.metrics.send).toHaveBeenCalledWith("impression_rendered",
      expect.objectContaining({ surface: "statusbar" }));
  });

  // H4: arbiter flag is set while the ad owns the bar, cleared when it ends.
  it("sets barState.adShowing while the ad holds the bar and clears it on hide", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    expect(d.barState.adShowing).toBe(true);
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    expect(d.barState.adShowing).toBe(false);
  });

  // H4: a clobber by another setter (e.g. the 30s earnings refresh) self-heals
  // — the next poll re-asserts kind:"ad" so a firing view_tick always matches a
  // visible ad.
  it("re-asserts the ad each tick while thinking (self-heals clobbers)", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);            // first show
    d.statusBar.set.mockClear();
    vi.advanceTimersByTime(1000);            // next tick re-asserts
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad", adText: "Try Acme Widgets" }));
  });

  // M3 / H4: kill flipping ON mid-display must END the show — view_tick must
  // STOP and impression_viewable must fire, not keep emitting for a killed ad.
  it("ends the show (stops view_tick) when killed mid-display", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(6000);            // showing + at least one view_tick
    d.killedRef.current = true;              // kill switch trips mid-burst
    vi.advanceTimersByTime(1000);            // next poll sees killed
    expect(d.metrics.send).toHaveBeenCalledWith("impression_viewable",
      expect.objectContaining({ surface: "statusbar" }));
    expect(d.barState.adShowing).toBe(false);
    const ticksBefore = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    vi.advanceTimersByTime(15_000);          // ad still "thinking" but killed
    const ticksAfter = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    expect(ticksAfter).toBe(ticksBefore);    // no ghost view_tick after kill
  });

  // M3: when killed mid-display, the kill setter owns the bar — statusBarAd
  // must NOT call showActive() (which would paint over the "killed" state).
  it("does not call showActive when killed mid-display", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    d.killedRef.current = true;
    vi.advanceTimersByTime(2000);
    expect(d.showActive).not.toHaveBeenCalled();
  });

  // Audit #1: the 60s portfolio refresh adopts fresh session tokens by
  // REPLACING the ad object in adRef (300s server TTL). Every billable
  // emission must carry the CURRENT token for the shown adId — a frozen
  // snapshot token 403s on any show outliving the TTL.
  it("adopts a fresh session token from adRef mid-show (view_tick + viewable)", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);            // show starts, snapshots tok1
    // 60s refresh: same ad, fresh token, NEW object (adRotation token-adopt).
    d.adRef.current = { ...d.adRef.current!, sessionToken: "tok2" };
    vi.advanceTimersByTime(5000);            // next view_tick fires
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[ticks.length - 1][1]).toMatchObject(
      { adId: "ad1", sessionToken: "tok2" });
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);            // endShow
    const viewable = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_viewable");
    expect(viewable).toHaveLength(1);
    expect(viewable[0][1]).toMatchObject(
      { adId: "ad1", sessionToken: "tok2" });
  });

  // Audit #1 guard: token adoption must never cross ad identities. When the
  // rotation swaps adRef to a DIFFERENT ad mid-show, the show keeps billing
  // (and displaying) the ad it actually shows — old id, old token, old text.
  it("does not adopt a different ad's token mid-show (rotation swap)", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(1000);
    d.adRef.current = { ...d.adRef.current!, adId: "ad2",
      sessionToken: "tok9", adText: "Other Ad" };
    vi.advanceTimersByTime(5000);
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks[ticks.length - 1][1]).toMatchObject(
      { adId: "ad1", sessionToken: "tok1" });
    expect(d.statusBar.lastState).toMatchObject(
      { kind: "ad", adText: "Try Acme Widgets" });
  });

  // Audit #29: a paint suppressed by the needs-reload lock (StatusBar.set
  // returns false) must not start billing — no impression_rendered, no
  // view_tick, and the arbiter flag stays false.
  it("never bills when the bar suppresses the ad paint (reloadLock)", () => {
    const d = makeDeps();
    d.statusBar.set.mockImplementation((s: unknown) => {
      d.statusBar.lastState = s; return false; });
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(12_000);
    expect(d.metrics.send).not.toHaveBeenCalled();
    expect(d.barState.adShowing).toBe(false);
  });

  // Audit #29: if the lock engages MID-show, the next 1s re-assert paint is
  // suppressed — the show must end (impression_viewable with the accrued
  // visible time) and view_tick must stop; no new show starts while locked.
  it("ends the show when the re-assert paint is suppressed mid-show", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(6000);            // showing + ≥1 view_tick
    d.statusBar.set.mockImplementation((s: unknown) => {
      d.statusBar.lastState = s; return false; });
    vi.advanceTimersByTime(1000);            // next poll: repaint suppressed
    expect(d.metrics.send).toHaveBeenCalledWith("impression_viewable",
      expect.objectContaining({ surface: "statusbar" }));
    expect(d.barState.adShowing).toBe(false);
    const ticksBefore = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    const renderedBefore = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_rendered").length;
    vi.advanceTimersByTime(15_000);          // still thinking, still locked
    const ticksAfter = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    const renderedAfter = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_rendered").length;
    expect(ticksAfter).toBe(ticksBefore);    // billing stopped with the show
    expect(renderedAfter).toBe(renderedBefore); // no new show while locked
  });

  // The Steven fix: a TUI-only user has NO panel transcript (logTail null,
  // by design since audit #24) — terminal activity via cliTail must engage
  // the bar, but ONLY while this VS Code window is focused.
  it("shows + bills on terminal (cliTail) activity when the window is focused", () => {
    const d = makeDeps({
      cliTail: { current: vi.fn().mockReturnValue(thinking()),
        activityAgeMs: vi.fn().mockReturnValue(500) },
      windowFocused: () => true,
    } as any);
    setupStatusBarAd(d);
    vi.advanceTimersByTime(6000);
    expect(d.statusBar.set).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ad", adText: "Try Acme Widgets" }));
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0][1]).toMatchObject({ surface: "statusbar" });
  });

  it("ignores terminal activity when the window is NOT focused", () => {
    const d = makeDeps({
      cliTail: { current: vi.fn().mockReturnValue(thinking()),
        activityAgeMs: vi.fn().mockReturnValue(500) },
      windowFocused: () => false,
    } as any);
    setupStatusBarAd(d);
    vi.advanceTimersByTime(6000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("ignores terminal activity when no cliTail is wired (old call sites)", () => {
    const d = makeDeps({ windowFocused: () => true } as any);
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);
    expect(d.statusBar.set).not.toHaveBeenCalled();
  });

  it("ends a cli-driven show when the terminal turn completes", () => {
    const cliCurrent = vi.fn().mockReturnValue(thinking());
    const d = makeDeps({
      cliTail: { current: cliCurrent,
        activityAgeMs: vi.fn().mockReturnValue(500) },
      windowFocused: () => true,
    } as any);
    setupStatusBarAd(d);
    vi.advanceTimersByTime(2000);
    cliCurrent.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    const viewable = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_viewable");
    expect(viewable).toHaveLength(1);
    expect(d.barState.adShowing).toBe(false);
  });

  // The show time-box (2026-06-10 "the ad never disappears" report): agentic
  // sessions keep `thinking` true for hours, so without a cap the earnings
  // display never surfaced. A continuous show must end at AD_SHOW_MAX_MS,
  // paint the balance immediately, rest AD_REST_MS, then may re-show.
  it("time-boxes a continuous show: ends at the cap and paints earnings", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(61_000);          // past AD_SHOW_MAX_MS
    const viewable = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_viewable");
    expect(viewable).toHaveLength(1);        // show ended despite thinking
    expect(d.showActive).toHaveBeenCalled(); // balance painted immediately
    expect(d.barState.adShowing).toBe(false);
  });

  it("stops view_tick during the rest window even while still thinking", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(61_000);          // cap hit, rest begins
    const ticksAtCap = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    vi.advanceTimersByTime(15_000);          // inside the 20s rest
    const ticksInRest = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    expect(ticksInRest).toBe(ticksAtCap);
  });

  it("re-shows the ad after the rest window when still thinking", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(61_000);          // cap → rest
    d.metrics.send.mockClear();
    vi.advanceTimersByTime(25_000);          // rest (20s) elapsed
    expect(d.metrics.send).toHaveBeenCalledWith("impression_rendered",
      expect.objectContaining({ surface: "statusbar" }));
    expect(d.barState.adShowing).toBe(true);
  });

  it("a show shorter than the cap keeps the existing idle-revert behavior", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(10_000);          // well under the cap
    d.logTail.current.mockReturnValue(idle());
    vi.advanceTimersByTime(1000);
    expect(d.metrics.send).toHaveBeenCalledWith("impression_viewable",
      expect.objectContaining({ surface: "statusbar" }));
    expect(d.showActive).not.toHaveBeenCalled();  // 6s hold first
    vi.advanceTimersByTime(6000);
    expect(d.showActive).toHaveBeenCalledTimes(1);
  });

  it("suspend clamp: a sleep gap mid-show is not billed as visible time", () => {
    // Pre-fix visibleMs was a raw wall-clock span (now - showStart): an 8h
    // laptop suspend mid-show inflated the next view_tick and the final
    // impression_viewable by the whole sleep. Now each timer tick accrues at
    // most 2 poll intervals, so the gap collapses to one capped slice.
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(5000);            // 5s genuinely visible
    // Suspend: wall clock jumps 8h with NO timer ticks, then one poll fires.
    vi.setSystemTime(Date.now() + 8 * 3600_000);
    vi.advanceTimersByTime(1000);
    d.logTail.current.mockReturnValue(idle()); // end the show
    vi.advanceTimersByTime(1000);
    const viewable = d.metrics.send.mock.calls.find(
      (c: unknown[]) => c[0] === "impression_viewable");
    expect(viewable).toBeTruthy();
    const visibleMs = (viewable![1] as { visibleMs: number }).visibleMs;
    expect(visibleMs).toBeLessThan(20_000);  // ~7s real, never 8h
    expect(visibleMs).toBeGreaterThanOrEqual(5000);
  });

  // The audit-#29 suppression contract: StatusBar.set() returns false when
  // the needs-reload lock owns the bar — an ad whose paint never landed (or
  // stopped landing) must never bill. These pin both `=== false` gates; the
  // default mock returns undefined (a void setter counts as painted), so
  // without an explicit false neither gate is ever exercised.
  it("never starts a show or bills when the reload lock suppresses the paint", () => {
    const d = makeDeps();
    d.statusBar.set.mockReturnValue(false);  // needs-reload lock owns the bar
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(12_000);
    expect(d.metrics.send).not.toHaveBeenCalled();
    expect(d.barState.adShowing).toBe(false);
  });

  it("ends the show (and stops billing) when a mid-show repaint is suppressed", () => {
    const d = makeDeps();
    d.logTail.current.mockReturnValue(thinking());
    setupStatusBarAd(d);
    vi.advanceTimersByTime(3000);            // show opened, painting normally
    expect(d.barState.adShowing).toBe(true);
    d.statusBar.set.mockReturnValue(false);  // lock engages mid-show
    vi.advanceTimersByTime(1000);            // next re-assert is suppressed
    expect(d.barState.adShowing).toBe(false);
    const viewable = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_viewable");
    expect(viewable).toHaveLength(1);        // final viewable fired on endShow
    const ticksBefore = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    vi.advanceTimersByTime(15_000);          // suppressed restarts never bill
    const ticksAfter = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    expect(ticksAfter).toBe(ticksBefore);
  });
});
