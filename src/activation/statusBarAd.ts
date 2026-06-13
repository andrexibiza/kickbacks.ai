import type { LogTail } from "../activity/logTail";
import type { MetricsClient } from "../metrics/client";
import type { PatchAd } from "../portfolio/client";
import type { SbState } from "../statusbar";
import { canPatch } from "../servingGate";
import { dlog } from "../log";

const AD_DISPLAY_HOLD_MS = 6_000;
const POLL_INTERVAL_MS = 1_000;
const VIEW_TICK_INTERVAL_MS = 5_000;
const FRESH_ACTIVITY_MS = 4_000;
// Time-boxed show cycle: agentic sessions keep `thinking` true for HOURS
// (every tool call rewrites the transcript), so "ad while thinking" used to
// degenerate into "ad forever" and the earnings display never surfaced
// (2026-06-10 report: "the ad never disappears"). A show now runs at most
// AD_SHOW_MAX_MS continuously, then the bar rests on the earnings/balance
// display for AD_REST_MS before the ad may return. Billing stops with each
// show (endShow), so the cap also bounds continuous statusbar dwell.
const AD_SHOW_MAX_MS = 60_000;
const AD_REST_MS = 20_000;

export interface StatusBarAdDeps {
  logTail: LogTail;
  metrics: MetricsClient;
  // `set` returns false when the paint was suppressed (the needs-reload lock
  // owns the bar) — a suppressed ad must never bill. A void-returning setter
  // counts as painted.
  statusBar: { set: (s: SbState) => boolean | void };
  adRef: { current: PatchAd | null };
  killedRef: { current: boolean };
  ccVersion: string;
  showActive: () => Promise<void>;
  timers: NodeJS.Timeout[];
  // Shared arbiter flag: set true while the ad owns the status-bar item so the
  // periodic earnings refresh (showActive) won't paint over it. The poll also
  // re-asserts the ad each tick as a backstop against other setters
  // (kill/offline/incompatible) clobbering it mid-display.
  barState: { adShowing: boolean };
  // TERMINAL-activity signal (the Steven fix): a second LogTail pinned to the
  // newest entrypoint:"cli" transcript (locateClaudeCliLog). A TUI-only user
  // never produces panel activity — locateClaudeCodeLog returns "" for them
  // by design (audit #24, desync-watchdog safety) — so without this signal
  // the statusbar ad never engages and their billing silently dies. The CLI
  // path is gated on `windowFocused` (below): a focused VS Code window with a
  // live terminal turn means the bar is actually on screen.
  cliTail?: Pick<LogTail, "current" | "activityAgeMs">;
  // True when this VS Code window has OS focus (vscode.window.state.focused).
  // Only consulted for the CLI-activity path — a turn running in an EXTERNAL
  // terminal while VS Code is backgrounded must not bill a bar nobody sees.
  // Absent (older call sites / tests) ⇒ the CLI path stays off entirely.
  windowFocused?: () => boolean;
}

export function setupStatusBarAd(deps: StatusBarAdDeps): void {
  const {
    logTail, metrics, statusBar, adRef, killedRef,
    ccVersion, showActive, timers, barState,
    cliTail, windowFocused,
  } = deps;

  let showing = false;
  let corr = "";
  let revertTimer: NodeJS.Timeout | null = null;
  let viewTickTimer: NodeJS.Timeout | null = null;
  let shownAd: PatchAd | null = null;
  let showStartedAt = 0;
  let restUntil = 0;

  // Visible-time accrual with a suspend clamp (the audit-#23 contract, same
  // as the CC block): visibleMs used to be a raw wall-clock span
  // (now - showStart), so a laptop suspend mid-show billed the whole sleep
  // gap as visible time in the next view_tick / final impression_viewable.
  // Accrue per timer tick instead, capping any single gap at 2 poll
  // intervals — timer coalescing across a suspend then contributes at most
  // one capped slice.
  const VISIBLE_GAP_CAP_MS = 2 * POLL_INTERVAL_MS;
  let accruedVisibleMs = 0;
  let lastAccrualMs = 0;
  const accrueVisible = (): void => {
    const now = Date.now();
    const delta = now - lastAccrualMs;
    if (delta > 0) accruedVisibleMs += Math.min(delta, VISIBLE_GAP_CAP_MS);
    lastAccrualMs = now;
  };

  // The per-show viewTick/revert timers must be tracked in `timers` so
  // deactivate() (which clears actx.timers) stops them — otherwise a
  // disable/uninstall mid-display leaves a viewTick interval firing
  // metrics.send against a stale closure. We also splice on clear so the
  // shared array doesn't grow one stale handle per show.
  const track = (t: NodeJS.Timeout): NodeJS.Timeout => {
    timers.push(t);
    try { t.unref?.(); } catch { /* never disrupt */ }
    return t;
  };
  const untrack = (t: NodeJS.Timeout | null): void => {
    if (!t) return;
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
  };

  const stopViewTicks = (): void => {
    if (viewTickTimer) {
      clearInterval(viewTickTimer); untrack(viewTickTimer); viewTickTimer = null;
    }
  };

  const clearRevert = (): void => {
    if (revertTimer) {
      clearTimeout(revertTimer); untrack(revertTimer); revertTimer = null;
    }
  };

  // The 60s portfolio refresh adopts fresh session tokens by REPLACING the
  // ad objects in adRef (server tokens carry a 300s TTL; adRotation's
  // token-adopt branch builds new objects), so the `shownAd` snapshot keeps
  // its aged token — on a show outliving the TTL every later billable event
  // would 403. Re-read the live ad at each billable emission and, when it is
  // still the SAME ad, adopt its token. Never changes which ad is displayed —
  // token freshness only (audit #1).
  const freshenToken = (): void => {
    const live = adRef.current;
    if (shownAd && live && live.adId === shownAd.adId
        && live.sessionToken !== shownAd.sessionToken) {
      shownAd = { ...shownAd, sessionToken: live.sessionToken };
    }
  };

  const endShow = (): void => {
    if (!showing || !shownAd) return;
    accrueVisible();
    const visibleMs = accruedVisibleMs;
    stopViewTicks();
    freshenToken();
    metrics.send("impression_viewable", {
      adId: shownAd.adId, campaignId: shownAd.campaignId,
      ccVersion, corr, surface: "statusbar",
      visibleMs, sessionToken: shownAd.sessionToken,
    });
    dlog("ext", "statusbar.ad.hide", { adId: shownAd.adId, visibleMs, corr });
    showing = false;
    shownAd = null;
    barState.adShowing = false;
  };

  const poll = (): void => {
    try {
      // The 1s poll is the accrual clock while a show is live — each tick
      // contributes at most VISIBLE_GAP_CAP_MS, so a suspend gap collapses
      // to one capped slice instead of the whole sleep.
      if (showing) accrueVisible();
      const activity = logTail.current();
      const activityAgeMs = logTail.activityAgeMs();
      const freshTranscript = activityAgeMs !== null
        && activityAgeMs <= FRESH_ACTIVITY_MS;
      const panelThinking = activity ? !activity.done : freshTranscript;
      // Terminal turns count too — but only while THIS window is focused
      // (integrated-terminal TUI usage: the bar is visibly on screen). The
      // panel path is checked first so the common case pays no extra stat.
      let cliThinking = false;
      if (!panelThinking && cliTail && windowFocused?.()) {
        const cliAct = cliTail.current();
        const cliAge = cliTail.activityAgeMs();
        const cliFresh = cliAge !== null && cliAge <= FRESH_ACTIVITY_MS;
        cliThinking = cliAct ? !cliAct.done : cliFresh;
      }
      const thinking = panelThinking || cliThinking;
      const ad = adRef.current;
      // Eligible to show the ad: Claude is thinking, we have a REAL (user-
      // crediting) ad, and not killed. Demo ads (signed-out preview) are
      // intentionally EXCLUDED from the status bar — the lower status-bar text
      // must stay the red "Kickbacks: Sign in" prompt while signed out so the
      // bar reads as a call-to-action, not as serving inventory. Demo ads still
      // render in-window (the overlay surface); only this status-bar surface
      // gates on sign-in. Kill / no-ad / demo are NOT just "skip" — if we're
      // mid-display they must END the show (stop view_tick), else the timer
      // keeps emitting view metrics for a gone ad. canPatch() folds in the
      // serving gate so a deliberate "Disable Kickbacks" (or a crash-canary
      // suspension) also ends the show and stops billing (wave 2, audit #4).
      const eligible = thinking && !!ad && !ad.demo && !killedRef.current
        && canPatch() && Date.now() >= restUntil;

      // Show time-box: a continuous show hits its cap mid-thinking → end it
      // (billing stops, impression_viewable fires with the real visible
      // time), paint the earnings display IMMEDIATELY (that's the point —
      // the balance must get screen time), and rest before re-showing.
      if (showing && Date.now() - showStartedAt >= AD_SHOW_MAX_MS) {
        endShow();
        restUntil = Date.now() + AD_REST_MS;
        clearRevert();
        if (!killedRef.current) void showActive();
        return;
      }

      if (eligible) {
        clearRevert();
        if (!showing) {
          // Paint FIRST: a false return means the needs-reload lock owns the
          // bar and the ad was never displayed — don't start the show and
          // never bill (no impression_rendered, no view_tick). Audit #29.
          if (statusBar.set({ kind: "ad", adText: ad!.adText }) === false) {
            return;
          }
          showing = true;
          accruedVisibleMs = 0;
          lastAccrualMs = Date.now();
          showStartedAt = Date.now();
          shownAd = ad;
          barState.adShowing = true;
          corr = "statusbar." + ad!.adId + "." +
            Math.random().toString(36).slice(2, 8);

          dlog("ext", "statusbar.ad.show", { adId: ad!.adId, corr });
          metrics.send("impression_rendered", {
            adId: ad!.adId, campaignId: ad!.campaignId,
            ccVersion, corr, surface: "statusbar",
          });

          viewTickTimer = track(setInterval(() => {
            if (!shownAd) return;
            accrueVisible();
            freshenToken();
            metrics.send("view_tick", {
              adId: shownAd.adId, campaignId: shownAd.campaignId,
              ccVersion, corr, surface: "statusbar",
              visibleMs: accruedVisibleMs,
              sessionToken: shownAd.sessionToken,
            });
          }, VIEW_TICK_INTERVAL_MS));
        } else {
          // Re-assert each tick: self-heals any clobber by another setter
          // (the 30s earnings refresh, offline/incompatible) so whenever a
          // view_tick fires, a visible ad was repainted within the last ~1s.
          // A suppressed repaint (needs-reload lock engaged mid-show) means
          // the ad is no longer visible — end the show so billing stops.
          if (statusBar.set({ kind: "ad", adText: shownAd!.adText }) === false) {
            endShow();
          }
        }
      } else if (showing) {
        // No longer eligible while mid-display. Always end the show so
        // view_tick stops and impression_viewable fires with the real
        // visible duration.
        endShow();
        // Schedule the 6s revert ONLY on a clean thinking→idle transition.
        // showActive() itself branches on sign-in (it paints the signed-out
        // label when there's no token), so demo and real both revert cleanly.
        // When kill interrupted the show, that setter already owns the bar —
        // don't paint over it.
        if (!thinking && !killedRef.current && !revertTimer) {
          revertTimer = track(setTimeout(() => {
            untrack(revertTimer);
            revertTimer = null;
            void showActive();
          }, AD_DISPLAY_HOLD_MS));
        }
      }
    } catch { /* prime directive: never break activation */ }
  };

  timers.push(setInterval(poll, POLL_INTERVAL_MS));
}
