import * as vscode from "vscode";
import type { AuthClient } from "../auth/client";
import type { EarningsClient } from "../earnings/client";
import type { SessionState } from "../sessionState";
import type { SbState } from "../statusbar";
import type { EarningCap } from "../earnings/client";
import { servingGateSnapshot } from "../servingGate";
import { EARNINGS_STALE_MS, type FleetSignals } from "../fleetSignals";

export interface EarningsRefreshResult {
  showActive: () => Promise<void>;
  scheduleEarningsRefresh: (delayMs?: number) => void;
}

export function setupEarningsRefresh(
  auth: AuthClient,
  earningsClient: EarningsClient,
  session: SessionState,
  statusBar: { set: (s: SbState) => void },
  ccVersion: string,
  ctx: vscode.ExtensionContext,
  // Arbiter: true while the status-bar ad owns the item (set by statusBarAd).
  // When an ad is showing, showActive keeps the earnings data fresh but does
  // NOT paint over the ad — statusBarAd repaints the earnings label itself
  // when the ad reverts. Defaults to "never showing" for callers that don't
  // wire the arbiter (tests, other surfaces).
  isAdShowing: () => boolean = () => false,
  // The red cap-warning pill (a SEPARATE status-bar item). show() when a cap
  // is hit, hide() in every not-earning safety state so it never lingers next
  // to a kill/offline/sign-in bar. Defaults to a no-op for callers that don't
  // wire it (tests, other surfaces) — back-compat.
  capWarning: { show: (c: EarningCap) => void; hide: () => void } =
    { show: () => {}, hide: () => {} },
  // Fleet-signal store (fleet-chattiness fix): when the backend piggybacks
  // `balances` (incl. the cap) on portfolio/metrics responses, showActive
  // paints from the store and the standalone GET /v1/earnings stands down.
  // null/old-backend (no `cap` key on the carrier) keeps today's behavior.
  signals: FleetSignals | null = null,
): EarningsRefreshResult {
  let lastUsd: string | undefined;
  let lastToday: string | undefined;

  let pendingRefreshTimer: NodeJS.Timeout | null = null;
  const scheduleEarningsRefresh = (delayMs = 2500): void => {
    if (pendingRefreshTimer) clearTimeout(pendingRefreshTimer);
    pendingRefreshTimer = setTimeout(() => {
      pendingRefreshTimer = null;
      void showActive();
    }, delayMs);
    try { pendingRefreshTimer.unref?.(); } catch { /* never disrupt */ }
  };

  const showActive = async (): Promise<void> => {
    // Serving gate (wave 2, audit #4): pre-fix this 30s repaint clobbered
    // the killed/offline/Off bar back to green "active ($… today)" within
    // 30s of a kill or a deliberate "Disable Kickbacks". Safety/truth
    // states always win (the Wave-1 status-bar contract): paint the gated
    // state and never the earning label while the gate says no-serve.
    const gate = servingGateSnapshot();
    if (gate.kill === "confirmed") {
      capWarning.hide();
      statusBar.set({ kind: "killed" });
      return;
    }
    if (gate.kill === "offline") {
      capWarning.hide();
      statusBar.set({ kind: "offline" });
      return;
    }
    if (!auth.accessToken()) {
      capWarning.hide();
      statusBar.set({ kind: "signed-out" });
      session.set({ signedIn: false });
      return;
    }
    if (!gate.enabled || gate.suspended) {
      // User-disabled (or crash-canary suspended): the red "Kickbacks: Off —
      // click to re-enable" bar, the existing debug-OFF SbState.
      capWarning.hide();
      statusBar.set({ kind: "debug", on: false });
      return;
    }
    // Fleet-signal fast path: fresh piggybacked balances from an AUTHED 2xx
    // carrier replace the network fetch entirely. `capCapable` (the carrier
    // had the `cap` KEY) is the new-backend marker — without it the
    // standalone fetch below must keep running, it's the only cap source.
    // The carrier being an authed 200 also vouches for auth health.
    const snap = signals?.earningsSnapshot();
    if (snap && snap.capCapable
        && signals?.earningsFreshWithin(EARNINGS_STALE_MS)) {
      lastUsd = snap.lifetimeUsd; lastToday = snap.todayUsd;
      session.set({ signedIn: true, authHealthy: "ok" });
      if (snap.cap) capWarning.show(snap.cap);
      else capWarning.hide();
      if (isAdShowing()) return;
      statusBar.set({ kind: "active", version: ccVersion,
                      usd: lastUsd, usdToday: lastToday });
      return;
    }
    const r = await earningsClient.fetchDetailed();
    // Token died during the await (sign-out / failed rotation mid-fetch):
    // paint signed-out instead of a stale green "active" bar (audit #34).
    if (!auth.accessToken()) {
      capWarning.hide();
      statusBar.set({ kind: "signed-out" });
      session.set({ signedIn: false });
      return;
    }
    if (r.outcome === "ok") {
      lastUsd = r.earnings.lifetimeUsd; lastToday = r.earnings.todayUsd;
      session.set({ signedIn: true, authHealthy: "ok" });
      // Drive the red cap pill from the authoritative cap state. Done BEFORE
      // the isAdShowing() guard below so the cap warning shows even while a
      // status-bar ad owns the main earnings item (separate item).
      if (r.earnings.cap) capWarning.show(r.earnings.cap);
      else capWarning.hide();
    } else if (r.outcome === "401") {
      // Only a REAL backend 401 may raise the session-expired signal.
      session.set({ signedIn: true, authHealthy: "401" });
    } else {
      // Transient failure (network blip / 5xx / malformed body): keep the
      // previous authHealthy verdict — pre-fix this branch asserted "401"
      // and the debug menu falsely showed "Sign in again — your session
      // expired" on every offline poll (audit #34).
      session.set({ signedIn: true });
    }
    // Don't clobber a live status-bar ad — it owns the item until it reverts,
    // at which point statusBarAd calls showActive() again (adShowing=false)
    // to paint these freshly-fetched figures.
    if (isAdShowing()) return;
    statusBar.set({ kind: "active", version: ccVersion,
                    usd: lastUsd, usdToday: lastToday });
  };

  // Piggybacked balances repaint immediately — this replaces the old
  // "schedule a /v1/earnings refetch ~2.5s after a billable event" with
  // zero requests: the billed metrics RESPONSE delivered the numbers, and
  // showActive's fast path above paints them without touching the network.
  signals?.onEarningsUpdated(() => void showActive());

  // Initial status bar state + sign-in nudge.
  if (!auth.accessToken()) {
    statusBar.set({ kind: "signed-out" });
    const NUDGE_KEY = "kickbacks.signinNudge.shownAt";
    const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const lastShownAt = Number(ctx.globalState.get<number>(NUDGE_KEY) || 0);
    if (Date.now() - lastShownAt > NUDGE_COOLDOWN_MS) {
      void ctx.globalState.update(NUDGE_KEY, Date.now());
      void (async () => {
        try {
          const choice = await vscode.window.showInformationMessage?.(
            "Kickbacks: sign in to start earning on Claude Code spinner ads.",
            "Sign in", "Later");
          if (choice === "Sign in") {
            await vscode.commands.executeCommand("kickbacks.signIn");
          }
        } catch { /* toast is best-effort */ }
      })();
    }
  } else void showActive();

  return { showActive, scheduleEarningsRefresh };
}
