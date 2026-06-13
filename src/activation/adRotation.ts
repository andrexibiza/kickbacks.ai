import type { PatchAd, PortfolioResponse } from "../portfolio/client";
import { fetchPortfolioWithDemoFallback } from "../portfolio/client";
import type { PortfolioClient } from "../portfolio/client";
import type { TargetAdapter, PatchParams } from "../adapters/types";
import type { DebugController } from "../debug";
import type { AuthClient } from "../auth/client";
import type { SessionState } from "../sessionState";
import { canPatch, servingVerdict } from "../servingGate";
import { dlog } from "../log";

export interface AdRotationDeps {
  adapter: TargetAdapter;
  portfolio: PortfolioClient;
  auth: AuthClient;
  debugCtl: DebugController;
  session: SessionState;
  ccVersion: string;
  port: number;
  patchParams: PatchParams;
  /** Mutable ref: the currently active ad. Updated in-place by rotation.
   *  Null after a sign-out clear until the next portfolio apply. */
  activeAdRef: { current: PatchAd | null };
  /** Mutable ref: the current correlation id. Updated on ad change. */
  corrRef: { current: string };
  /** Mutable ref: the outer ad variable (closure-scope in activate). */
  adRef: { current: PatchAd | null };
  impDedupe: { reset(): void };
  reapplyCodex: (() => void) | null;
  /** Fired after every ad apply (initial, rotation, sign-in demo→real swap) so
   *  other surfaces — notably the timer-driven CLI sync — can refresh NOW
   *  instead of waiting for their own poll. Best-effort; must never throw. */
  onAdApplied?: () => void;
  timers: NodeJS.Timeout[];
}

export interface AdRotationState {
  adQueue: PatchAd[];
  rotationIdx: number;
  rotationTimer: ReturnType<typeof setInterval> | null;
  lastAdSetSig: string;
  /** Monotonic refresh identity. Bumped by every FORCED refresh (the sign-in
   *  demo→real swap) and by the sign-out clear; an in-flight refresh whose
   *  captured epoch is stale by the time its fetch resolves discards the
   *  response instead of reinstating outdated (e.g. demo) ads over the
   *  just-applied ones. */
  refreshEpoch: number;
}

/** Apply a new ad to the adapter + Codex, updating all shared refs.
 *  `force` re-applies even when the adId is unchanged — needed for the
 *  signed-out→signed-in swap, where the demo ad and the real ad can share an
 *  adId but the real ad carries a real (user-crediting) session token that the
 *  overlay's `activeAd` MUST pick up, or it would keep billing the demo token. */
function applyAd(
  next: PatchAd,
  deps: AdRotationDeps,
  state: AdRotationState,
  force = false,
): boolean {
  // Serving gate (wave 2, audit #3/#9): the rotation tick and the 60s
  // refresh were the un-gated writers that re-patched a killed install right
  // after checkKill restored it. Killed / offline-frozen / user-disabled /
  // canary-suspended ⇒ no ref swaps, no patch write, no new ad served; the
  // 60s reassert re-applies on its own first healthy tick after recovery.
  // Returns false when gated so refreshPortfolio knows NOT to latch the ad-set
  // signature (an unchanged set must still re-apply after recovery).
  if (!canPatch()) {
    dlog("ext", "rotation.gated", { verdict: servingVerdict(), adId: next.adId });
    return false;
  }
  const adChanged = force || next.adId !== deps.adRef.current?.adId;
  deps.adRef.current = next;
  deps.session.set({ hasAd: true });
  deps.debugCtl?.setPortfolioAd(next.adText, next.clickUrl || "");
  if (adChanged && deps.port > 0) {
    deps.activeAdRef.current = next;
    deps.corrRef.current = next.adId + "." + Math.random().toString(36).slice(2, 8);
    deps.impDedupe.reset();
    Object.assign(deps.patchParams, { adText: next.adText,
      iconRef: next.iconRef, iconUrl: next.iconUrl,
      clickUrl: next.clickUrl });
    deps.adapter.applyPatch(deps.patchParams);
    deps.reapplyCodex?.();
    dlog("ext", "portfolio.rotated", { adId: next.adId, corr: deps.corrRef.current });
  }
  // Outside the adChanged/port guard on purpose: the forced sign-in swap shares
  // an adId yet still needs the CLI surface re-synced to the real ad.
  try { deps.onAdApplied?.(); } catch { /* best-effort */ }
  return true;
}

function rotateNext(deps: AdRotationDeps, state: AdRotationState): void {
  if (state.adQueue.length < 2) return;
  state.rotationIdx = (state.rotationIdx + 1) % state.adQueue.length;
  applyAd(state.adQueue[state.rotationIdx], deps, state);
}

async function refreshPortfolio(
  deps: AdRotationDeps,
  state: AdRotationState,
  force = false,
): Promise<void> {
  try {
    // Demo-aware: a signed-out client refreshes from the public demo portfolio
    // so the preview rotates like the live product. A signed-in client uses the
    // authed portfolio (real, user-crediting session tokens). `force` (the
    // sign-in swap) re-applies even when the adId set is unchanged so the
    // overlay drops the demo token for the real one.
    // A forced refresh starts a new epoch so any slower refresh already in
    // flight (e.g. the 60s timer's signed-out DEMO fetch racing the sign-in
    // swap) is recognised as stale below and discarded instead of applied.
    if (force) state.refreshEpoch++;
    const epoch = state.refreshEpoch;
    // Dead-token recovery (the "frozen ads" 401 loop, 2026-06-11): a client
    // whose cached access token the server rejects used to 401 here every 60s
    // FOREVER — the catch below swallowed it, no new inventory ever arrived,
    // and every surface kept the last-baked creative. The fallback helper
    // applies the same conservative ladder as activation: signed-out → demo;
    // signed-in failure → ONE auth refresh (re-mint → real ads), demote to
    // demo only on an authoritative rejection (token cleared), and hold —
    // no demotion, no churn — on transient failures (offline/5xx).
    const r = await fetchPortfolioWithDemoFallback(
      deps.portfolio, deps.auth, deps.ccVersion,
      // Active campaign scopes the piggybacked kill verdict (parity with
      // the standalone /v1/killswitch poll's `campaign=` param).
      deps.activeAdRef.current?.campaignId || "");
    if (epoch !== state.refreshEpoch) {
      // The world changed while this fetch was in flight (forced swap or
      // sign-out clear): applying the response would reinstate stale ads.
      dlog("ext", "portfolio.refresh_stale",
        { epoch, current: state.refreshEpoch });
      return;
    }
    if (!r || r.ads.length === 0) return;
    const newSig = r.ads.map(a => a.adId).sort().join(",");
    const adsChanged = force || newSig !== state.lastAdSetSig;
    if (adsChanged) {
      state.adQueue = r.ads;
      state.rotationIdx = 0;
      // Latch the signature only when the apply actually went through: a
      // gated apply (kill/offline/disabled) must leave the sig unlatched so
      // the first healthy refresh re-applies even an UNCHANGED ad set —
      // otherwise recovery would serve the stale pre-kill creative until the
      // inventory happened to change.
      if (applyAd(state.adQueue[0], deps, state, force)) {
        state.lastAdSetSig = newSig;
      }
      dlog("ext", "portfolio.refresh", { adId: state.adQueue[0].adId, queueLen: state.adQueue.length, changed: true, forced: force });
      if (state.rotationTimer) clearInterval(state.rotationTimer);
      if (state.adQueue.length > 1) {
        state.rotationTimer = setInterval(() => rotateNext(deps, state), r.rotationIntervalMs);
        deps.timers.push(state.rotationTimer);
      }
    } else {
      // Same ad SET, but the server mints a FRESH session token on every fetch
      // (300s TTL). Adopt the new tokens so the in-use token never ages out and
      // starts 403-ing billable view events — WITHOUT re-patching the overlay
      // (adText/clickUrl/iconRef are unchanged, so there's no visible churn and
      // no reason to re-mint the loopback/corr). This closes the silent "billing
      // stops after ~5 min on stable inventory" bug: pre-fix the refreshed
      // response was discarded wholesale, so `activeAd.sessionToken` aged out.
      //
      // The `demo` stamp travels WITH the token: a mid-session demotion (token
      // death → this refresh comes from the DEMO portfolio) can return the same
      // adId set, and an adopted demo token on an object still marked demo:false
      // would keep the status bar showing ads while signed out — bypassing its
      // deliberate sign-in gate (statusBarAd keys on `!ad.demo`, audit BL-187).
      // Same in reverse: a re-auth must clear the stamp so real ads aren't
      // suppressed as demo.
      const freshByAdId = new Map(r.ads.map((a) => [a.adId, a]));
      state.adQueue = state.adQueue.map((a) => {
        const fresh = freshByAdId.get(a.adId);
        return fresh
          ? { ...a, sessionToken: fresh.sessionToken, demo: fresh.demo }
          : a;
      });
      const active = deps.activeAdRef.current;
      const freshActive = active ? freshByAdId.get(active.adId) : undefined;
      if (active && freshActive) {
        deps.activeAdRef.current = {
          ...active, sessionToken: freshActive.sessionToken,
          demo: freshActive.demo };
        if (deps.adRef.current && deps.adRef.current.adId === active.adId) {
          deps.adRef.current = {
            ...deps.adRef.current, sessionToken: freshActive.sessionToken,
            demo: freshActive.demo };
        }
      }
      dlog("ext", "portfolio.token_refreshed",
        { queueLen: r.ads.length, rotationIdx: state.rotationIdx, adId: active?.adId });
    }
  } catch { /* prime directive */ }
}

/** Sign-out teardown: drop every leftover REAL ad so no surface keeps serving
 *  — or billing — it signed-out. Empties the queue, disarms the rotation
 *  timer, nulls the shared ad refs (statusBarAd / reassert / the loopback's
 *  active-ad snapshot all key off them), and bumps the refresh epoch so an
 *  in-flight refresh can't re-apply a stale response. The 60s refresh interval
 *  stays armed on purpose: its next (demo or real) portfolio apply is what
 *  re-populates the queue and re-arms rotation. */
function clearAds(deps: AdRotationDeps, state: AdRotationState): void {
  state.refreshEpoch++;
  if (state.rotationTimer) {
    clearInterval(state.rotationTimer);
    state.rotationTimer = null;
  }
  state.adQueue = [];
  state.rotationIdx = 0;
  state.lastAdSetSig = "";
  deps.adRef.current = null;
  deps.activeAdRef.current = null;
  deps.session.set({ hasAd: false });
  dlog("ext", "rotation.cleared", {});
}

// Exactly one rotation subsystem exists per activation; setup replaces the
// hook. Module-scoped so the sign-out command (activation/commands.ts) can
// reach the live rotation state without threading the handle through
// activate() → registerCommands.
let liveClear: (() => void) | null = null;

/** Clear the live rotation's ad state on sign-out — see clearAds(). Safe
 *  no-op when rotation never set up (no ad at activation). Never throws. */
export function clearAdRotationOnSignOut(): void {
  try { liveClear?.(); } catch { /* best-effort */ }
}

/** The state object plus a `refreshNow` trigger. `refreshNow(force)` runs a
 *  portfolio refresh immediately (used by the sign-in handler to swap demo ads
 *  for real, user-crediting ones without waiting for the 60s timer). */
export type AdRotationHandle = AdRotationState & {
  refreshNow: (force?: boolean) => Promise<void>;
  /** Sign-out teardown — see clearAds(). */
  clear: () => void;
};

/** Set up the ad-rotation subsystem. Returns the live state augmented with a
 *  `refreshNow` trigger (timers are pushed into the shared `deps.timers`). */
export function setupAdRotation(
  deps: AdRotationDeps,
  portfolioResp: PortfolioResponse | null,
): AdRotationHandle {
  const state: AdRotationState = {
    adQueue: portfolioResp?.ads ?? [],
    rotationIdx: 0,
    rotationTimer: null,
    lastAdSetSig: (portfolioResp?.ads ?? []).map(a => a.adId).sort().join(","),
    refreshEpoch: 0,
  };
  const initialRotationMs = portfolioResp?.rotationIntervalMs ?? 120_000;
  if (state.adQueue.length > 1) {
    state.rotationTimer = setInterval(() => rotateNext(deps, state), initialRotationMs);
    deps.timers.push(state.rotationTimer);
    dlog("ext", "rotation.init", { intervalMs: initialRotationMs, queueLen: state.adQueue.length });
  }

  deps.timers.push(setInterval(() => void refreshPortfolio(deps, state), 60_000));
  // Augment the LIVE state object in place (don't copy — the timers mutate it).
  const handle = state as AdRotationHandle;
  handle.refreshNow = (force = false) => refreshPortfolio(deps, state, force);
  handle.clear = () => clearAds(deps, state);
  liveClear = handle.clear;
  return handle;
}
