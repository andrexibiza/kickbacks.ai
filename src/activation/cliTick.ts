import type { LogTail } from "../activity/logTail";
import type { MetricsClient } from "../metrics/client";
import type { PatchAd } from "../portfolio/client";
import { canPatch } from "../servingGate";
import { cliMode } from "../modes";
import { dlog } from "../log";

// The dwell/billing loop for the TERMINAL statusline surface. The statusline
// (and spinner-verb) ads are written into ~/.claude/settings.json by cliSync,
// which emits one impression_viewable per ad — but until this module existed
// NO TUI surface ever emitted view_tick, so a user consuming ads purely in
// the terminal saw ads all day and earned nothing (the Steven incident,
// 2026-06-10). Server-side, view_tick from surface:"statusline" is already
// allowlisted, block-debited, cooldown-gated (5s shared per user+ad across
// surfaces — so statusbar+statusline ticking the same ad can never
// double-credit), and daily-capped; the whole gap was client emission.
//
// Activity signal: a LogTail pinned to the newest entrypoint:"cli" transcript
// (locateClaudeCliLog). Ticks flow only while a terminal turn is actually
// running (done=false; LogTail forces done after 90s of transcript silence),
// which matches when the spinner is animating and the statusline is freshly
// painted. Deliberately NOT gated on window focus: the surface lives in the
// user's terminal (integrated or external), not in the VS Code chrome.

const POLL_INTERVAL_MS = 1_000;
const VIEW_TICK_INTERVAL_MS = 5_000;
const FRESH_ACTIVITY_MS = 4_000;

export interface CliTickDeps {
  cliTail: Pick<LogTail, "current" | "activityAgeMs">;
  metrics: MetricsClient;
  adRef: { current: PatchAd | null };
  killedRef: { current: boolean };
  /** Live sign-in probe (auth.accessToken truthiness). */
  signedIn: () => boolean;
  /** True when cliSync's adapter can actually render the statusline (its
   *  preflight().compatible) — billing must track a surface that paints. */
  surfaceApplied: () => boolean;
  ccVersion: string;
  timers: NodeJS.Timeout[];
  /** Injectable for tests; default to the shared modes/servingGate. */
  cliModeFn?: () => string;
  canPatchFn?: () => boolean;
}

export function setupCliTick(deps: CliTickDeps): void {
  const {
    cliTail, metrics, adRef, killedRef, signedIn, surfaceApplied,
    ccVersion, timers,
  } = deps;
  const cliModeFn = deps.cliModeFn ?? cliMode;
  const canPatchFn = deps.canPatchFn ?? canPatch;

  let showing = false;
  let shownAd: PatchAd | null = null;
  let corr = "";
  let viewTickTimer: NodeJS.Timeout | null = null;

  // Same suspend clamp as the statusbar (audit #23): accrue per poll tick,
  // capping any single gap, so a laptop sleep never bills as visible time.
  const VISIBLE_GAP_CAP_MS = 2 * POLL_INTERVAL_MS;
  let accruedVisibleMs = 0;
  let lastAccrualMs = 0;
  const accrueVisible = (): void => {
    const now = Date.now();
    const delta = now - lastAccrualMs;
    if (delta > 0) accruedVisibleMs += Math.min(delta, VISIBLE_GAP_CAP_MS);
    lastAccrualMs = now;
  };

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

  // Same token-freshness contract as the statusbar (audit #1): the 60s
  // portfolio refresh REPLACES ad objects to adopt fresh session tokens
  // (300s TTL) — re-read the live ad each billable emission and adopt its
  // token when it is still the same ad.
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
    if (viewTickTimer) {
      clearInterval(viewTickTimer); untrack(viewTickTimer); viewTickTimer = null;
    }
    // No final impression_viewable here: cliSync owns the statusline's
    // impression attribution (one per applied ad). This loop is ticks-only.
    dlog("ext", "clitick.end",
      { adId: shownAd.adId, visibleMs: accruedVisibleMs, corr });
    showing = false;
    shownAd = null;
  };

  const poll = (): void => {
    try {
      if (showing) accrueVisible();
      const act = cliTail.current();
      const age = cliTail.activityAgeMs();
      const fresh = age !== null && age <= FRESH_ACTIVITY_MS;
      const turnActive = act ? !act.done : fresh;
      const ad = adRef.current;
      const eligible = turnActive && !!ad && !ad.demo && signedIn()
        && !killedRef.current && canPatchFn() && cliModeFn() === "on"
        && surfaceApplied();

      // Rotation swap mid-show: unlike the statusbar (which keeps painting
      // the snapshot it showed), the statusline file is REWRITTEN with the
      // new ad on rotation (cliSync.syncNow at the ad-apply choke point) —
      // the old ad is no longer on screen, so end its session and let the
      // next poll open one for the live ad.
      if (showing && shownAd && ad && ad.adId !== shownAd.adId) endShow();

      if (eligible && !showing) {
        showing = true;
        shownAd = ad;
        accruedVisibleMs = 0;
        lastAccrualMs = Date.now();
        corr = "clitick." + ad!.adId + "."
          + Math.random().toString(36).slice(2, 8);
        dlog("ext", "clitick.show", { adId: ad!.adId, corr });
        viewTickTimer = track(setInterval(() => {
          if (!shownAd) return;
          accrueVisible();
          freshenToken();
          metrics.send("view_tick", {
            adId: shownAd.adId, campaignId: shownAd.campaignId,
            ccVersion, corr, surface: "statusline",
            visibleMs: accruedVisibleMs,
            sessionToken: shownAd.sessionToken,
          });
        }, VIEW_TICK_INTERVAL_MS));
      } else if (!eligible && showing) {
        endShow();
      }
    } catch { /* prime directive: never break activation */ }
  };

  timers.push(setInterval(poll, POLL_INTERVAL_MS));
}
