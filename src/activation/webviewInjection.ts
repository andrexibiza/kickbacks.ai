import type * as vscode from "vscode";
import type { TargetAdapter, PatchParams } from "../adapters/types";
import type { AuthClient } from "../auth/client";
import type { DebugController } from "../debug";
import type { SessionState } from "../sessionState";
import type { PatchAd, PortfolioResponse } from "../portfolio/client";
import type { PortfolioClient } from "../portfolio/client";
import { newMetricEventUuid, type MetricsClient } from "../metrics/client";
import type { LogTail } from "../activity/logTail";
import type { TestHooks } from "../testHooks";
import type { ActivationContext } from "./context";
import type { SbState } from "../statusbar";
import { Loopback } from "../loopback";
import { bootLoopback } from "../util/loopbackBoot";
import { dlog, debugEnabled } from "../log";
import { errMsg } from "../util/errMsg";
import { resolveBannerOn } from "../banner";
import { webviewMode, bannerOverride } from "../modes";
import { ImpressionDedupe } from "../metrics/dedupe";
import { shouldReassert } from "../reassert";
import { canPatch, canServeAds, servingVerdict } from "../servingGate";
import type { DesyncState } from "./desyncDetector";
import { setupAdRotation, type AdRotationDeps } from "./adRotation";

/** Anti-misclick floor: a click within the first CLICK_THRESHOLD_MS of
 *  cumulative ad visibility is logged but NOT forwarded to the metrics
 *  ledger. 15s per product call. */
const CLICK_THRESHOLD_MS = 15_000;

/** Status decision for an injection cycle that can't (re)apply this tick — a
 *  loopback port race (EADDRINUSE on reload/self-update) or a single applyPatch
 *  failure. A live, already-patched block is STILL serving the ad, so it must
 *  not be relabeled "incompatible": return `null` to defer to the active /
 *  earnings state. `isPatched` is "ANY webview target is patched" — a serving
 *  Codex block counts exactly like a serving Claude Code block (S9 dual
 *  target). Only a genuinely un-patched install yields an incompatible
 *  status. Pure + exported so the honest-label contract is unit-tested without
 *  standing up the loopback. */
export function applyMissStatus(
  isPatched: boolean, ccVersion: string,
): SbState | null {
  return isPatched ? null : { kind: "incompatible", version: ccVersion };
}

export interface WebviewInjectionDeps {
  ctx: vscode.ExtensionContext;
  actx: ActivationContext;
  adapter: TargetAdapter;
  auth: AuthClient;
  debugCtl: DebugController;
  session: SessionState;
  portfolio: PortfolioClient;
  metrics: MetricsClient;
  logTail: LogTail;
  testHooks: TestHooks;
  statusBar: { set: (s: SbState) => void };
  ccVersion: string;
  killed: boolean;
  /** Mutated by the caller when the kill-switch state changes. */
  killedRef: { current: boolean };
  /** Mutable ref for the outer `ad` variable. */
  adRef: { current: PatchAd | null };
  portfolioResp: PortfolioResponse | null;
  viewThresholdMs: number;
  statusBarShowActive: () => Promise<void>;
  scheduleEarningsRefresh: () => void;
  desyncState: DesyncState;
  /** Whether the Claude Code target preflighted compatible at activation.
   *  False on a codex-only boot: the Claude applyPatch/reassert writers are
   *  skipped (they'd fail anchor validation every tick anyway) and Codex is
   *  the serving surface. Omitted ⇒ true (legacy callers/tests keep the
   *  Claude-primary semantics). */
  claudeCompatible?: boolean;
  /** Forwarded to ad rotation: fired after each ad apply so the CLI surface can
   *  re-sync immediately (sign-in swap / rotation) instead of waiting 60s. */
  onAdApplied?: () => void;
}

export interface WebviewInjectionResult {
  lbInfo: { port: number; base: string } | null;
  reapplyCodex: (() => void) | null;
  /** Production-path "hard" reassert: restore + re-applyPatch so the file's
   *  identity changes and VS Code re-evaluates a stale-cached webview module.
   *  Health-gated, guarded, never throws. Null when injection didn't set up
   *  (no ad / killed / loopback unavailable). Used by the desync watchdog. */
  cycleReassert: (() => void) | null;
  /** Force an immediate portfolio refresh. Used by the sign-in handler to swap
   *  the signed-out DEMO ad for a real, user-crediting one (and re-point the
   *  overlay's billing token) without waiting for the 60s rotation timer. Null
   *  when injection didn't set up (no ad at activation / killed). */
  refreshPortfolioNow: ((force?: boolean) => Promise<void>) | null;
}

/** Boot the loopback, patch the webview, set up reassert + ad rotation.
 *  Returns the loopback info and a Codex reapply function. */
export async function setupWebviewInjection(
  deps: WebviewInjectionDeps,
): Promise<WebviewInjectionResult> {
  const {
    ctx, actx, adapter, auth, debugCtl, session, portfolio,
    metrics, logTail, testHooks, statusBar, ccVersion, killedRef, adRef,
    portfolioResp, viewThresholdMs, statusBarShowActive,
    scheduleEarningsRefresh, desyncState,
  } = deps;
  const ad = adRef.current;
  if (!ad || deps.killed || webviewMode() !== "on") {
    return { lbInfo: null, reapplyCodex: null, cycleReassert: null,
             refreshPortfolioNow: null };
  }

  // Stable snapshot of the activation-time ad.
  let activeAd = ad;
  let corr = activeAd.adId + "." + Math.random().toString(36).slice(2, 8);
  const impDedupe = new ImpressionDedupe();

  // Rotation/poll-lag attribution (audit #17): a rotation flips activeAd
  // instantly, but the webview only learns of it from its own 10s /ad poll —
  // so for up to 10s it keeps emitting the OLD ad's view events (and clicks),
  // which used to be stamped with the NEW ad's adId/campaignId/sessionToken
  // at arrival time (cross-campaign misattribution on every rotation
  // boundary). Keep a small registry of recently-served ads, lazily refreshed
  // from the live activeAd on every event/click, and attribute by the ad the
  // webview CLAIMS (its `ad=` param) when we recently served it. The deployed
  // block keys its view sessions by ad TEXT (viewShow(AD, …)) and sends that
  // as `ad=`, so claims resolve by adId OR adText. A ~10s-stale session token
  // is fine — the server TTL is 300s. Unknown/absent claims fall back to
  // activeAd, exactly the pre-fix behavior.
  const RECENT_ADS_MAX = 8;
  type AdAttribution =
    { adId: string; campaignId: string; sessionToken: string;
      demo?: boolean };
  const recentAds = new Map<string, AdAttribution & { adText: string }>();
  const resolveAttribution = (claimed?: string): AdAttribution => {
    const live = activeAd;
    if (live) {
      // Delete + re-set: bump recency and adopt a refreshed session token.
      // The demo stamp travels with the token (BL-187 contract): a registry
      // entry minted while signed out holds a demo:<client_id>-namespace
      // token, and the namespace guard below needs to see that.
      recentAds.delete(live.adId);
      recentAds.set(live.adId, { adId: live.adId,
        campaignId: live.campaignId, sessionToken: live.sessionToken,
        demo: live.demo, adText: live.adText });
      while (recentAds.size > RECENT_ADS_MAX) {
        recentAds.delete(recentAds.keys().next().value as string);
      }
    }
    if (claimed) {
      const byId = recentAds.get(claimed);
      if (byId) return byId;
      let byText: AdAttribution | undefined;
      for (const e of recentAds.values()) {   // last match = most recent
        if (e.adText === claimed) byText = e;
      }
      if (byText) return byText;
    }
    return live;
  };

  // Token-namespace guard (2026-06-11): MetricsClient routes by LIVE auth
  // state (token present → /v1/metrics, absent → /v1/metrics/demo), but the
  // attribution above rides whatever session token the registry holds. A
  // demo-era token POSTed on the authed route (or a real token on the demo
  // route, after a sign-out) binds to the WRONG uid namespace and the server
  // rejects it 403 "invalid or expired session_token" — every tick, for the
  // life of the stale entry; in prod this showed as a chronic all-403 stream
  // of full view sessions. The mismatch is decidable client-side with no
  // clock assumptions: bill only when the token's namespace matches the
  // route the send will take. Mismatched events are dropped with a dlog —
  // they were 100%-guaranteed server rejects, so this loses no revenue.
  const namespaceMismatch = (attr: AdAttribution): boolean =>
    !!attr.demo === !!auth.accessToken();

  const codexAdapter = actx.codexAdapter;
  actx.loopback = new Loopback({
    onEvent: (k, payload) => {
      // Billing gate (wave 2, audit #3): the webview's pollAd ignores the
      // empty /ad payload (it only adopts a NEW ad), so an already-running
      // overlay keeps emitting view events straight through a confirmed kill
      // or a deliberate disable. The extension side is the billing authority:
      // drop the forwarding here so a stale overlay can render but never bill.
      if (!canServeAds()) {
        dlog("ext", "metric.gated", { event: k, verdict: servingVerdict() },
          { corr });
        return;
      }
      // Audit #17: bill the ad the webview claims (post-rotation poll lag),
      // not necessarily the current activeAd — see resolveAttribution above.
      const attr = resolveAttribution(payload.claimedAdId);
      if (namespaceMismatch(attr)) {
        dlog("ext", "metric.namespace_drop",
          { event: k, adId: attr.adId, demo: !!attr.demo,
            authed: !!auth.accessToken() }, { corr });
        return;
      }
      const eventUuid = payload.eventUuid || newMetricEventUuid();
      if (k !== "view_tick" && k !== "error_impression"
          && !impDedupe.shouldSend(k, attr.adId, payload.surface)) {
        dlog("ext", "metric.deduped",
          { event: k, surface: payload.surface, eventUuid }, { corr });
        return;
      }
      dlog("ext", "metric.send", { event: k, adId: attr.adId,
        surface: payload.surface, visibleMs: payload.visibleMs, eventUuid },
        { corr });
      metrics.send(k, {
        adId: attr.adId,
        campaignId: attr.campaignId,
        ccVersion,
        corr,
        sessionToken: attr.sessionToken,
        ...payload,
        eventUuid,
      });
      if (k === "view_threshold_met" || k === "impression_viewable"
          || k === "error_impression") {
        scheduleEarningsRefresh();
      }
    },
    onClick: (_ct, surface, visibleMs, eventUuidFromLoopback, claimedAdId) => {
      // Same billing gate as onEvent: a click on a stale (gated) overlay
      // still opens the advertiser URL webview-side, but is never billed.
      if (!canServeAds()) {
        dlog("ext", "metric.gated", { event: "click",
          verdict: servingVerdict() }, { corr });
        return;
      }
      // Audit #17: a click on the OLD ad's anchor during the /ad poll lag
      // must bill the OLD campaign/token, not the freshly-rotated one.
      const attr = resolveAttribution(claimedAdId);
      if (namespaceMismatch(attr)) {
        dlog("ext", "metric.namespace_drop",
          { event: "click", adId: attr.adId, demo: !!attr.demo,
            authed: !!auth.accessToken() }, { corr });
        return;
      }
      const eventUuid = eventUuidFromLoopback || newMetricEventUuid();
      if (typeof visibleMs === "number" && visibleMs < CLICK_THRESHOLD_MS) {
        dlog("ext", "metric.click.early", { adId: attr.adId,
          surface, visibleMs, thresholdMs: CLICK_THRESHOLD_MS, eventUuid },
          { corr });
        return;
      }
      dlog("ext", "metric.send", { event: "click", adId: attr.adId,
        surface, visibleMs, eventUuid }, { corr });
      metrics.send("click", { adId: attr.adId, campaignId: attr.campaignId,
        ccVersion, corr, sessionToken: attr.sessionToken,
        eventUuid, ...(surface ? { surface } : {}) });
      scheduleEarningsRefresh();
    },
    getActivity: () => logTail.current() ?? {},
    // Gate /ad (wave 2, audit #3): a confirmed kill or a deliberate disable
    // stops handing out NEW ads. NOTE: an already-shown overlay is NOT
    // dropped by this — pollAd ignores the empty payload and keeps the last
    // creative painted until idle/reload. That is why onEvent/onClick above
    // are also gated: the stale overlay can render but never bill.
    // /activity and /log relay stay untouched.
    getCurrentAd: () => activeAd && canServeAds() ? {
      adText: activeAd.adText, clickUrl: activeAd.clickUrl,
      iconUrl: activeAd.iconUrl, adId: activeAd.adId,
      campaignId: activeAd.campaignId,
    } : null,
    onTestRoute: (n, p) => testHooks.handleTestRoute(n, p),
    onWebviewLog: (raw) => {
      try {
        if (raw.includes('"block.start"') || raw.includes("block.start")) {
          desyncState.lastBlockStartAt = Date.now();
        }
      } catch { /* best-effort */ }
    },
  });

  const { port, token, base: lbBase } = await bootLoopback(actx.loopback, ctx);
  const lbInfo = { port, base: lbBase };
  dlog("ext", "loopback", { port, base: lbBase });

  let patchParams: PatchParams = {
    tier: 3, adText: activeAd.adText, iconRef: activeAd.iconRef,
    iconUrl: activeAd.iconUrl, clickToken: "ck", clickUrl: activeAd.clickUrl,
    corr, loopbackPort: port,
    loopbackToken: token, loopbackBase: lbBase, debug: debugEnabled(),
    bannerOn: resolveBannerOn(activeAd.bannerEnabled === true, bannerOverride()),
    viewThresholdMs,
  };

  const claudeCompatible = deps.claudeCompatible ?? true;

  // Honest status: a transient miss THIS cycle (a loopback port race on
  // reload/self-update, or a single applyPatch failure) must NOT clobber a
  // still-live, ad-serving block to a scary "incompatible" label. EITHER
  // target counts — a serving Codex block keeps the label honest exactly
  // like a serving Claude Code block.
  const anyTargetPatched = (): boolean => {
    try { if (adapter.isPatched?.() === true) return true; }
    catch { /* fall through to codex */ }
    try { return codexAdapter?.isPatched?.() === true; }
    catch { return false; }
  };
  const setIncompatibleUnlessPatched = (): void => {
    const s = applyMissStatus(anyTargetPatched(), ccVersion);
    if (s) statusBar.set(s);
    else void statusBarShowActive();
  };

  if (port < 0) {
    // EADDRINUSE / port-exhaustion: skip the apply (but keep an existing patch's
    // status honest — a stale loopback from the prior host doesn't mean the file
    // is unpatched).
    setIncompatibleUnlessPatched();
    dlog("ext", "loopback.unavailable",
      { port, patched: adapter.isPatched?.() === true });
    return { lbInfo, reapplyCodex: null, cycleReassert: null,
             refreshPortfolioNow: null };
  }

  // Serving gate (wave 2, audit #14/#19): a crash-canary suspension or a
  // persisted kill must also stop THIS production-path write — pre-fix only
  // the bootCanary's own debug-path calls were skipped, and the activation
  // path re-patched seconds after the "skipping automatic patch" toast.
  // A codex-only boot (claude incompatible) skips the doomed Claude write
  // entirely: it would fail anchor validation and clobber the status bar.
  if (!canPatch()) {
    dlog("ext", "applyPatch.skip", { gate: servingVerdict() });
  } else if (!claudeCompatible) {
    dlog("ext", "applyPatch.skip", { reason: "claude-incompatible" });
  } else {
    const res = adapter.applyPatch(patchParams);
    dlog("ext", "applyPatch", { ok: res.ok, reason: res.reason });
    if (res.ok) {
      desyncState.lastApplyAt = Date.now();
      void statusBarShowActive();
    }
    else setIncompatibleUnlessPatched();
  }

  // S9: patch Codex with the SAME ad/loopback params. A Codex success drives
  // the "active" status bar (it IS the serving surface on a codex-only boot)
  // but must NEVER set desyncState.lastApplyAt — that would arm the CLAUDE
  // webview-cache desync watchdog (cycle → reload → toast ladder) with no
  // Claude apply to heal; lastApplyAt === 0 keeps it deliberately passive
  // (reassert.ts::desyncDecision "no-apply").
  const applyCodex = (): void => {
    if (!codexAdapter) return;
    if (!canPatch()) { dlog("ext", "codex.skip", { reason: "serving-gate" }); return; }
    if (port < 0) { dlog("ext", "codex.skip", { reason: "no-loopback" }); return; }
    try {
      const cpf = codexAdapter.preflight();
      if (!cpf.compatible) {
        dlog("ext", "codex.skip", { reason: cpf.reason });
        return;
      }
      const cr = codexAdapter.applyPatch(patchParams);
      dlog("ext", "codex.applyPatch", { ok: cr.ok, reason: cr.reason });
      if (cr.ok) void statusBarShowActive();
    } catch (e) {
      dlog("ext", "codex.error", { msg: errMsg(e) });
    }
  };
  const reapplyCodex = applyCodex;
  // Codex-only boot: apply NOW — the deferred call below would leave the
  // first 10s of the session unserved (and the status bar unconfirmed).
  // Idempotent: the 10s pass re-validates via isPatched/marker checks.
  if (!claudeCompatible) applyCodex();
  actx.timers.push(setTimeout(applyCodex, 10_000));

  // Reassert the injection on a timer. The Claude branch is gated on the
  // boot-time compatibility flag: a codex-only boot would otherwise retry a
  // doomed anchor-validation failure every 60s (a mid-session CC install
  // lands in a NEW versioned directory this adapter's fixed target can't
  // see — only a reload re-preflights, same as today).
  const reassertWebview = (): void => {
    try {
      // canPatch() folds in the serving gate (kill posture incl. the offline
      // freeze, master toggle, canary suspension) — wave 2, audit #4/#9.
      if (!canPatch() || !shouldReassert({
          haveAd: !!adRef.current, killed: killedRef.current })) return;
      if (claudeCompatible && adapter.isPatched?.() !== true) {
        const r = adapter.applyPatch(patchParams);
        if (!r.ok) dlog("ext", "reassert.skip", { reason: r.reason });
      }
      if (codexAdapter && codexAdapter.isPatched?.() !== true) {
        applyCodex();
      }
    } catch { /* prime directive: never break activation */ }
  };
  actx.timers.push(setInterval(reassertWebview, 60_000));

  // "Hard" reassert for the webview-cache desync (file is patched but the
  // webview cached the pre-patch module, so isPatched()-gated reasserts can't
  // see it). restore() + applyPatch() changes the file's identity, nudging VS
  // Code to re-evaluate the module. Health-gated like reassertWebview; only
  // ever invoked by the desync watchdog after sustained, CC-active silence.
  const cycleReassert = (): void => {
    try {
      // Same gate as reassertWebview: the restore+re-apply cycle must never
      // fire on a killed / frozen / disabled / suspended install (wave 2).
      if (!canPatch() || !shouldReassert({
          haveAd: !!adRef.current, killed: killedRef.current })) return;
      if (claudeCompatible) {
        adapter.restore();
        const r = adapter.applyPatch(patchParams);
        if (r.ok) desyncState.lastApplyAt = Date.now();
        dlog("ext", "reassert.cycle", { ok: r.ok, reason: r.reason });
      }
      applyCodex();
    } catch { /* prime directive: never break activation */ }
  };

  // Ad rotation subsystem.
  const rotation = setupAdRotation({
    adapter, portfolio, auth, debugCtl, session, ccVersion, port,
    patchParams,
    activeAdRef: { get current() { return activeAd; }, set current(v) { activeAd = v; } },
    corrRef: { get current() { return corr; }, set current(v) { corr = v; } },
    adRef,
    impDedupe,
    reapplyCodex,
    onAdApplied: deps.onAdApplied,
    timers: actx.timers,
  } as AdRotationDeps, portfolioResp);

  return { lbInfo, reapplyCodex, cycleReassert,
           refreshPortfolioNow: rotation.refreshNow };
}
