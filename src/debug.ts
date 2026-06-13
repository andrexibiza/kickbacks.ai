import * as vscode from "vscode";
import type { TargetAdapter, PatchParams } from "./adapters/types";
import { Loopback,
  type LoopbackMetricKind, type LoopbackMetricPayload } from "./loopback";
import { bootLoopback } from "./util/loopbackBoot";
import { buildLabel, buildVersion, humanAge, BUILD_TS } from "./buildinfo";
import { dlog, debugEnabled, debugIconDataUri, LOG_PATH } from "./log";
import { resolveBannerOn, type BannerOverride } from "./banner";
import { errMsg } from "./util/errMsg";
import type { SessionSnapshot } from "./sessionState";
import { reloadSentinelPath, parseSentinel } from "./reloadSignal";
import {
  webviewMode, cliMode,
  bannerOverride as modesBannerOverride, setBannerOverride,
} from "./modes";
import { readFileSync } from "node:fs";
import { ensureConfigFile } from "./config";
import { canPatch, canServeAds, clearServingSuspension } from "./servingGate";

/** Auth surface the debug menu needs. Injected post-construction because the
 *  DebugController is built before auth (it must work on incompatible/early-
 *  return builds where auth never initializes). Absent => menu omits auth. */
export interface AuthHook {
  signedIn(): boolean;
  storageInfo(): { scheme: string; keyringDurable?: boolean };
  signOut(): Promise<void>;
}

const K_TEXT = "kickbacks.debug.text";
const K_ON = "kickbacks.debug.on";
// Remembers whether injection was ON at the moment of an explicit sign-out so
// the next sign-in can RESTORE it. doSignOut() forces K_ON=false (a signed-out
// session must not serve ads), but that false is byte-identical to the false a
// user writes by clicking "Disable Kickbacks". Without this flag the sign-in
// auto-enable gate (neverToggled) stays false forever after the first sign-out,
// so signing back in left the user silently disabled — see
// shouldAutoEnableOnSignIn(). Undefined ⇒ "no remembered sign-out intent".
const K_PRESIGNOUT = "kickbacks.debug.onBeforeSignOut";
// Legacy storage keys read once on init for the rename migration (W1). New
// state always lands under the kickbacks.* keys; the vibe-ads.* keys are
// kept readable (never deleted) so a downgrade keeps working.
const K_TEXT_LEGACY = "vibe-ads.debug.text";
const K_ON_LEGACY = "vibe-ads.debug.on";
const DEFAULT_TEXT = "Your ad here — kickbacks.ai";
const DEFAULT_CLICK = "https://kickbacks.ai";
/** Click-threshold floor for the DEBUG-injection path. Mirrors
 *  CLICK_THRESHOLD_MS in extension.ts (kept local to avoid an
 *  extension→debug import cycle). 15s per product call. */
const DEBUG_CLICK_THRESHOLD_MS = 15_000;

/** Menu info-row label: "v0.3.79 · 1m ago · 7:42 PM".
 *  Version comes from the bundle define; relative age + local-time clock
 *  are computed from __BUILD_TS__. Returns "v… · dev build" when running
 *  unbundled (vitest/ts-node) so the menu never lies. Delegates the
 *  relative-age computation to buildinfo.ts::humanAge(). */
function builtAgo(now: number = Date.now()): string {
  const ver = buildVersion();
  const ts = BUILD_TS;
  const t = Date.parse(ts);
  if (!ts || Number.isNaN(t)) return `v${ver} · dev build`;
  const ago = humanAge(ts, now);
  let clock: string;
  try {
    clock = new Date(t).toLocaleTimeString(undefined,
      { hour: "numeric", minute: "2-digit", hour12: true });
  } catch { clock = ""; }
  return clock ? `v${ver} · ${ago} · ${clock}` : `v${ver} · ${ago}`;
}

/** Sender wired post-construction so the debug-injection overlay's
 *  impressions / views / clicks reach the real backend ledger via the same
 *  MetricsClient that the production ad path uses. Default is a no-op so
 *  builds without the wiring (older tests, Codex-only paths) keep the
 *  prior "visual-only" semantics. The DebugController only knows the
 *  loopback shape; the actual MetricsClient + portfolio resolution lives in
 *  extension.ts. */
export type DebugMetricSender = (
  kind: LoopbackMetricKind | "click",
  payload: LoopbackMetricPayload & { surface?: LoopbackMetricPayload["surface"] },
) => void;

/** Manual admin/debug override driven from the status bar. Lets an operator
 *  set a custom spinner message and toggle the injection on/off without the
 *  server-driven ad path. Never throws (prime directive); patch failures are
 *  surfaced as messages, not exceptions. */
export class DebugController {
  private lb: Loopback | null = null;
  private auth: AuthHook | null = null;
  private reassertFn: (() => void) | null = null;
  private reassertCodexFn: (() => void) | null = null;
  /** Real-ledger forwarder for debug-mode events. Defaults to a no-op so
   *  the controller is fully usable on early/incompatible builds where the
   *  metrics client + portfolio context aren't ready yet. extension.ts wires
   *  the real sender right after constructing MetricsClient. */
  private metricsSender: DebugMetricSender = () => {};
  private portfolioAd: { text: string; clickUrl: string } | null = null;
  /** S9: the Codex target, patched alongside CC on the DEBUG-injection path
   *  (the production server-ad path wires Codex separately in extension.ts).
   *  Null when no Codex install is present. */
  private codexAdapter: TargetAdapter | null = null;
  /** Remember the last params apply() built so `cyclePatch()` can re-
   *  apply the SAME patch without going through apply() (which would
   *  tear down + re-mint the loopback, introducing a ~250ms async
   *  window where the file is pristine). Sync restore + applyPatch
   *  with these params is microseconds-fast and never yields. */
  private lastApplyParams: PatchParams | null = null;
  /** Snapshot accessor for the cross-component session state. Wired
   *  post-construction by extension.ts after SessionState exists. Used
   *  by `openMenu()` to flip the auth row to "Sign in (token broken)"
   *  when the backend has rejected our access token — pre-fix the menu
   *  read auth.signedIn() (truthy as long as the token was in-memory)
   *  and showed "Sign out" even when every call 401'd. */
  private sessionSnap: (() => SessionSnapshot) | null = null;
  /** Wired post-construction by extension.ts so menu toggles take effect
   *  without waiting for the next activation/timer. */
  setReassert(fn: () => void): void { this.reassertFn = fn; }
  /** S9: the Codex-only re-apply trigger (guarded inside extension.ts). */
  setReassertCodex(fn: () => void): void { this.reassertCodexFn = fn; }
  /** S9: wire the Codex adapter so the debug toggle patches it too. */
  setCodexAdapter(a: TargetAdapter | null): void { this.codexAdapter = a; }
  /** Wire the session snapshot accessor; safe to call multiple times. */
  setSessionSnap(fn: () => SessionSnapshot): void { this.sessionSnap = fn; }

  /** S9: apply/restore Codex with the SAME params CC just used on the debug
   *  path. Preflight-gated and fully guarded — an absent/incompatible Codex
   *  or any throw is a silent no-op that never affects CC or the menu.
   *  Returns `true` iff the Codex patch actually landed on disk; callers
   *  use this so a Codex-only environment (no CC install) can still
   *  legitimately persist K_ON=true. */
  private applyCodexDebug(p: PatchParams): boolean {
    if (!this.codexAdapter) return false;
    try {
      const pf = this.codexAdapter.preflight();
      if (!pf.compatible) {
        dlog("ext", "debug.codex.skip", { reason: pf.reason });
        return false;
      }
      const r = this.codexAdapter.applyPatch(p);
      dlog("ext", "debug.codex.apply", { ok: r.ok, reason: r.reason });
      return !!r.ok;
    } catch (e) {
      dlog("ext", "debug.codex.error",
        { msg: errMsg(e) });
      return false;
    }
  }
  private restoreCodexDebug(): void {
    try { this.codexAdapter?.restore(); } catch { /* prime directive */ }
  }

  constructor(
    private readonly adapter: TargetAdapter,
    private readonly ctx: vscode.ExtensionContext,
    private readonly onState: (on: boolean) => void,
  ) {}

  /** Wire auth in once it exists (post-preflight). */
  setAuth(a: AuthHook): void { this.auth = a; }
  /** Wire the real-ledger forwarder. Called by extension.ts after
   *  MetricsClient + portfolio context exist. Idempotent. */
  setMetricsSender(fn: DebugMetricSender): void { this.metricsSender = fn; }
  setPortfolioAd(text: string, clickUrl: string): void {
    this.portfolioAd = { text, clickUrl };
  }

  // Read kickbacks.* first, fall back to the legacy vibe-ads.* keys so an
  // upgrade carries forward the user's custom message + ON state. We never
  // delete the legacy key — a downgrade keeps working.
  text(): string {
    return this.ctx.globalState.get<string>(K_TEXT)
      || this.ctx.globalState.get<string>(K_TEXT_LEGACY)
      || this.portfolioAd?.text
      || DEFAULT_TEXT;
  }
  on(): boolean {
    const cur = this.ctx.globalState.get<boolean>(K_ON);
    if (typeof cur === "boolean") return cur;
    return this.ctx.globalState.get<boolean>(K_ON_LEGACY) ?? false;
  }
  neverToggled(): boolean {
    return this.ctx.globalState.get<boolean>(K_ON) === undefined
      && this.ctx.globalState.get<boolean>(K_ON_LEGACY) === undefined;
  }

  /** Tiered auto-enable decision for the sign-in path. True ⇒ injection should
   *  be (re-)enabled on a successful sign-in:
   *    Tier 1 — the user has never made an explicit on/off choice
   *             (neverToggled): first-run default-on.
   *    Tier 2 — injection was ON at the last explicit sign-out (K_PRESIGNOUT):
   *             signing out is a pause, not a sticky disable, so signing back
   *             in restores the prior state.
   *  A deliberate "Disable Kickbacks" while signed in falls through BOTH tiers
   *  (the user wrote K_ON=false themselves, and a subsequent sign-out captures
   *  that OFF into K_PRESIGNOUT), so an intentional disable is preserved across
   *  a later sign-out/in. */
  shouldAutoEnableOnSignIn(): boolean {
    if (this.neverToggled()) return true;
    return this.ctx.globalState.get<boolean>(K_PRESIGNOUT) === true;
  }

  /** One-shot: consume the remembered pre-sign-out intent once the sign-in
   *  path has acted on it, so a stale flag can't override a later choice. */
  async clearSignOutMemory(): Promise<void> {
    await this.ctx.globalState.update(K_PRESIGNOUT, undefined);
  }
  bannerOverride(): BannerOverride { return modesBannerOverride(); }
  async cycleBannerOverride(): Promise<void> {
    const next: Record<BannerOverride, BannerOverride> =
      { server: "on", on: "off", off: "server" };
    setBannerOverride(next[this.bannerOverride()]);
    if (this.on()) await this.apply();   // live re-apply if injection is on
  }

  /** QuickPick shown when the status bar item is clicked.
   *
   *  Menu shape:
   *    0. GET PAID OUT $$$ (opens the user's earnings portal — always first)
   *    1. Sign in / Sign out (auth flip; omitted if auth never initialised)
   *    2. Enable / Disable Kickbacks (the renamed toggle)
   *    3. Edit Vibe-Ads config… (opens ~/.vibe-ads/config.json)
   *    4. Re-apply patch now (CC + Codex consolidated)
   *    5. Restart extensions now
   *    6. Restore Claude Code
   *    7. Open debug log
   *    8. ─── separator ───
   *    9. "Built Xm ago" (info row, click is a no-op)
   *
   *  Removed: "Set custom message" (rolled into config.json). Other power-
   *  user commands (Copy diagnostics, Webview injection, CLI status-line,
   *  Banner ad cycle, Show status) remain accessible via the command
   *  palette. */
  async openMenu(): Promise<void> {
    try {
      const on = this.on();
      const snap = this.sessionSnap?.();
      // Prefer the SessionState's view over auth.signedIn() when both
      // exist. Distinguishes "signed in and healthy" from "signed in but
      // backend keeps 401'ing" — the second case used to show the
      // misleading "Sign out" label and forced users to dig through
      // debug.log to realise the token had been revoked.
      const si = snap
        ? snap.signedIn && snap.authHealthy !== "401"
        : (this.auth?.signedIn() ?? false);
      const authBroken = !!snap && snap.signedIn && snap.authHealthy === "401";
      // Single row, flips between Sign in (signed out) and Sign out
      // (signed in). The "token broken" path shows "Sign in again" with
      // a warning description so the user can recover in one click.
      const authItem = this.auth
        ? authBroken
          ? { id: "signin",
              label: "$(warning) Sign in again to Kickbacks",
              description: "your session expired — backend rejecting calls" }
          : si
            ? { id: "signout", label: "$(sign-out) Sign out of Kickbacks" }
            : { id: "signin", label: "$(sign-in) Sign in to Kickbacks" }
        : null;
      const items: ({ id: string; label: string; description?: string;
                     kind?: vscode.QuickPickItemKind })[] = [
        // Always the very top row — the payout portal is the product's whole
        // promise, so it outranks even the auth flip.
        { id: "getpaid", label: "$(credit-card) GET PAID OUT $$$",
          description: "your earnings portal — kickbacks.ai/me" },
        ...(authItem ? [authItem] : []),
        { id: "toggle",
          label: on ? "$(circle-slash) Disable Kickbacks"
                    : "$(megaphone) Enable Kickbacks",
          description: on ? "currently ON" : "currently OFF" },
        { id: "config", label: "$(json) Edit Vibe-Ads config…",
          description: "~/.vibe-ads/config.json" },
        { id: "reapply", label: "$(sync) Re-apply patch now",
          description: "Claude Code + Codex" },
        { id: "checkupdates", label: "$(cloud-download) Check for updates",
          description: "force a self-update poll" },
        { id: "reload", label: "$(refresh) Restart extensions now" },
        { id: "restore", label: "$(history) Restore Claude Code" },
        { id: "openlog", label: "$(output) Open debug log" },
        { id: "__sep", label: "", kind: vscode.QuickPickItemKind.Separator },
        { id: "builtinfo", label: `$(info) ${builtAgo()}`,
          description: buildLabel() },
      ];
      const pick = await vscode.window.showQuickPick(items as never, {
        placeHolder: "Kickbacks",
      }) as { id: string } | undefined;
      if (!pick) return;
      if (pick.id === "getpaid")
        await vscode.env.openExternal(
          vscode.Uri.parse("https://kickbacks.ai/me"));
      else if (pick.id === "toggle") await this.setOn(!on);
      else if (pick.id === "config") await this.editConfig();
      else if (pick.id === "restore") await this.doRestore();
      else if (pick.id === "signin")
        await vscode.commands.executeCommand("kickbacks.signIn");
      else if (pick.id === "signout")
        await vscode.commands.executeCommand("kickbacks.signOut");
      else if (pick.id === "reload")
        await vscode.commands.executeCommand(
          "workbench.action.restartExtensionHost");
      else if (pick.id === "reapply") {
        // Consolidated re-apply: CC first, then Codex via the production
        // server-ad path AND the debug-injection path. Both are guarded
        // no-ops if their adapter isn't installed.
        this.reassertFn?.();
        this.reassertCodexFn?.();
        if (this.on()) await this.apply();
        vscode.window.showInformationMessage(
          this.on()
            ? "Kickbacks: re-applied (Claude Code + Codex)."
            : "Kickbacks: re-apply triggered (no-op — injection OFF).");
      }
      else if (pick.id === "checkupdates")
        await vscode.commands.executeCommand("kickbacks.checkUpdates");
      else if (pick.id === "openlog")
        await vscode.commands.executeCommand(
          "vscode.open", vscode.Uri.file(LOG_PATH));
      // "builtinfo" is intentionally a no-op; it's a labelled-only info row.
    } catch { /* prime directive */ }
  }

  private async editMessage(): Promise<void> {
    const v = await vscode.window.showInputBox({
      prompt: "Custom spinner ad text (≈30–40 chars renders best)",
      value: this.text(),
    });
    if (v === undefined) return;
    await this.setText(v);
  }

  /** Materialise ~/.vibe-ads/config.json with defaults (if missing) and open
   *  it in the editor. Saving the file triggers the watcher in extension.ts
   *  which restarts the extension host so the new values take effect.
   *  Public so the `kickbacks.editConfig` command can call it directly. */
  async editConfig(): Promise<void> {
    try {
      const p = ensureConfigFile();
      const doc = await vscode.workspace.openTextDocument(p);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      vscode.window.showErrorMessage(
        `Kickbacks: could not open config — ${errMsg(e, 200)}`);
    }
  }

  /** Persist a custom message; live re-apply if injection is currently on. */
  async setText(t: string): Promise<void> {
    await this.ctx.globalState.update(K_TEXT, t);
    if (this.on()) await this.apply();
  }

  async setOn(on: boolean): Promise<void> {
    // wave-2A-F07: if turning ON, apply BEFORE persisting K_ON. Pre-fix,
    // K_ON was persisted first, so a failed apply() left K_ON=true on
    // disk -> every subsequent activation re-ran apply() (which still
    // failed) -> re-toasted the same error forever. By applying first
    // and only persisting on success, a failed apply leaves K_ON in its
    // prior value (typically false) and the toast happens once, not
    // per-activation.
    if (on) {
      // An explicit user enable lifts the crash-canary suspension (wave 2,
      // audit #14) — this is the "manually re-enable" the canary toast
      // promises, and the only thing that un-suspends a session.
      clearServingSuspension();
      const ok = await this._applyAndReport();
      if (!ok) return; // do NOT persist K_ON=true; user can retry manually
      await this.ctx.globalState.update(K_ON, true);
    } else {
      await this.ctx.globalState.update(K_ON, false);
      // A deliberate disable overrides any remembered sign-out intent: the
      // serving gate (and the next sign-in's auto-enable) must read this as
      // "the user opted out", even when a K_PRESIGNOUT=true from an earlier
      // sign-out is still lying around (wave 2, audit #4).
      await this.ctx.globalState.update(K_PRESIGNOUT, undefined);
      this.adapter.restore();
      this.restoreCodexDebug();
    }
    this.onState(on);
  }

  private async _applyAndReport(): Promise<boolean> {
    try {
      return await this.apply();
    } catch (e) {
      // apply() shows its own error toast; we only need the success signal
      // to know whether to persist K_ON.
      void e;
      return false;
    }
  }

  /** Re-assert the patch on a fresh activation/reload if injection was left
   *  ON in a previous session.
   *
   *  ROOT CAUSE of the user's "I have to disable then re-enable to get it to
   *  inject" bug: `setOn(true)` persists `K_ON` in globalState AND patches the
   *  file, but `deactivate()` unconditionally calls `adapter.restore()` (best-
   *  effort "never leave a user patched"). So on the NEXT window reload the
   *  on-disk `index.js` is pristine again, the webview reloads clean, and
   *  nothing re-applies it: `activate()` never read `K_ON`, and `apply()` is
   *  private + only reachable via an explicit user toggle. The persisted ON
   *  state was therefore inert until a manual off→on. Idempotent re-apply is
   *  a hard project constraint, so activation must re-assert it itself.
   *
   *  Guarded (prime directive): never throws; reports honestly via dlog. */
  async reapplyIfOn(): Promise<{ on: boolean; applied: boolean; reason?: string }> {
    let on = false;
    try {
      on = this.on();
      if (!on) {
        dlog("ext", "reapply", { on: false, applied: false, reason: "off" });
        return { on: false, applied: false, reason: "off" };
      }
      // Serving gate (wave 2): a persisted/confirmed kill, the offline
      // freeze, or a crash-canary suspension blocks this AUTOMATIC re-apply
      // (boot canary, sign-in trigger). Manual setOn(true) is not gated.
      if (!canPatch()) {
        dlog("ext", "reapply",
          { on: true, applied: false, reason: "serving-gate" });
        return { on: true, applied: false, reason: "serving-gate" };
      }
      await this.apply();
      // apply() reports patch failures via showErrorMessage but does not throw;
      // surface the same signal here for the e2e by re-checking didn't throw.
      dlog("ext", "reapply", { on: true, applied: true });
      this.onState(true);
      return { on: true, applied: true };
    } catch (e) {
      const reason = errMsg(e, 200);
      dlog("ext", "reapply", { on, applied: false, reason });
      return { on, applied: false, reason };
    }
  }

  /** Boot-time disable → reenable cycle. The webview can hold a cached
   *  pre-patch module after a reinstall / self-update even though the
   *  on-disk file IS patched (block.desync); changing the file's identity
   *  via restore + applyPatch sometimes nudges VS Code to re-evaluate.
   *  Mirrors the manual "Disable Kickbacks → Enable Kickbacks" the user
   *  used to run by hand. Sync-fast (microseconds between the two
   *  renames) so the pristine window can't race CC's boot imports —
   *  unlike the earlier setTimeout(4s) forceReapplyCycle (commit 505f777)
   *  which had a 250ms async gap. Guarded; never throws. Skipped when
   *  K_ON is false (nothing to recycle) or when no prior apply() has
   *  recorded its params yet (first activation hasn't patched). */
  cyclePatch(): { ok: boolean; reason?: string } {
    try {
      if (!this.on()) return { ok: false, reason: "off" };
      // Serving gate (wave 2): the boot-time cycle and the desync watchdog
      // must never restore+re-patch a killed / frozen / suspended install.
      if (!canPatch()) return { ok: false, reason: "serving-gate" };
      if (!this.lastApplyParams)
        return { ok: false, reason: "no-params" };
      // Sync restore (rename backup → main) then sync applyPatch
      // (rename temp → main). No await between; the pristine state
      // exists only for the time between two filesystem renames.
      this.adapter.restore();
      const r = this.adapter.applyPatch(this.lastApplyParams);
      // S9: same cycle for Codex (silent no-op if absent / incompatible).
      try {
        if (this.codexAdapter) {
          const cpf = this.codexAdapter.preflight();
          if (cpf.compatible) {
            this.codexAdapter.restore();
            this.codexAdapter.applyPatch(this.lastApplyParams);
          }
        }
      } catch { /* prime directive */ }
      dlog("ext", "debug.cyclePatch", { ok: r.ok, reason: r.reason });
      return r;
    } catch (e) {
      const reason = errMsg(e);
      dlog("ext", "debug.cyclePatch.error", { reason });
      return { ok: false, reason };
    }
  }

  /** Periodic self-heal for the debug-injection path. `reapplyIfOn()` only
   *  runs once at activation; if that fired before Claude Code's file was
   *  patchable, or CC later overwrote index.js, the injection silently
   *  vanished and the user had to toggle off→on by hand. This tick re-applies
   *  whenever injection is ON but the patch is no longer present — and is a
   *  cheap no-op (one file read, no loopback churn) while healthy. Guarded;
   *  never throws. */
  async reassertTick(): Promise<void> {
    try {
      if (!this.on()) return;
      // Serving gate (wave 2, audit #6): pre-fix this unconditional 60s tick
      // re-patched a killed install right after checkKill restored it — the
      // restore→re-patch oscillation. Killed/offline/suspended ⇒ no writes.
      if (!canPatch()) return;
      // Healthy only when CC AND (no Codex install | Codex also patched) —
      // so a Codex-only drift (CC fine) still self-heals via apply().
      const ccOk = this.adapter.isPatched?.() === true;
      let cxOk = true;
      try { cxOk = !this.codexAdapter || this.codexAdapter.isPatched?.() === true; }
      catch { cxOk = true; }
      if (ccOk && cxOk) return;                          // healthy → no churn
      await this.apply();
      dlog("ext", "reassert.debug", { applied: true });
    } catch (e) {
      dlog("ext", "reassert.debug", { applied: false,
        reason: errMsg(e) });
    }
  }

  private async doRestore(): Promise<void> {
    const r = this.adapter.restore();
    this.restoreCodexDebug();
    await this.ctx.globalState.update(K_ON, false);
    // A menu "Restore Claude Code" is a deliberate disable, same as
    // setOn(false): clear the sign-out memory too, or a stale
    // K_PRESIGNOUT=true keeps the serving gate's enabled() input true and
    // the 60s reassert re-patches the just-restored install within a minute.
    await this.ctx.globalState.update(K_PRESIGNOUT, undefined);
    this.onState(false);
    vscode.window.showInformationMessage(
      r.restored ? "Kickbacks: Claude Code restored."
                 : `Kickbacks: ${r.reason || "nothing to restore"}`);
  }

  /** Sign out + leave Claude Code pristine. A signed-out session must not keep
   *  serving ads, so this also forces injection OFF and restores CC (same
   *  end-state as the kill switch). Never throws. */
  async doSignOut(): Promise<void> {
    try {
      // Capture the pre-sign-out injection intent BEFORE we force K_ON=false
      // below, so the next sign-in can restore it (see K_PRESIGNOUT /
      // shouldAutoEnableOnSignIn). This is what makes sign-out a pause rather
      // than a permanent disable.
      await this.ctx.globalState.update(K_PRESIGNOUT, this.on());
      if (this.auth) await this.auth.signOut();
      this.adapter.restore();
      this.restoreCodexDebug();
      await this.ctx.globalState.update(K_ON, false);
      this.onState(false);
      vscode.window.showInformationMessage(
        "Kickbacks: signed out. Claude Code restored.");
    } catch { /* prime directive */ }
  }

  private async apply(): Promise<boolean> {
    // ONE Loopback per controller lifetime (audit #7). Pre-fix every apply()
    // stopped + re-minted a fresh server; under the shared-server boot (see
    // bootLoopback) that re-mint would tear down the single server the
    // production webview traffic runs on. The handlers close over instance
    // fields (metricsSender / portfolioAd), so reuse keeps every route live
    // across applies, and the stable token+port keep baked URLs valid.
    if (!this.lb) this.lb = new Loopback({
      // Forward impression / view / view-threshold events to the real
      // ledger so debug-mode traffic is indistinguishable from a served
      // ad. The sender closure (wired by extension.ts) handles
      // adId/campaignId resolution against the current portfolio.
      onEvent: (k, payload) => { this.metricsSender(k, payload); },
      // Metrics-only: the injected ad anchor's real href (DEFAULT_CLICK) is
      // what the VS Code host opens on click. openExternal here too would
      // double-open. Forwarding click to the ledger via the same sender
      // means the entry shows up alongside the impression chain.
      // Click-threshold floor mirrors the production path: a click in the
      // first DEBUG_CLICK_THRESHOLD_MS of cumulative visible time is
      // logged but not billed. Browser navigation still happens (the
      // host already opened the URL by the time we get this callback).
      onClick: (_ct, surface, visibleMs, eventUuid) => {
        dlog("ext", "debug.click",
          { url: DEFAULT_CLICK, surface, visibleMs, eventUuid });
        if (typeof visibleMs === "number"
            && visibleMs < DEBUG_CLICK_THRESHOLD_MS) {
          dlog("ext", "debug.click.early",
            { visibleMs, thresholdMs: DEBUG_CLICK_THRESHOLD_MS, eventUuid });
          return;
        }
        this.metricsSender("click", {
          ...(surface ? { surface } : {}),
          ...(eventUuid ? { eventUuid } : {}),
        });
      },
      getActivity: () => ({}),
      // Gate /ad (wave 2, audit #3): a confirmed kill or a deliberate
      // disable stops handing out ads — live webviews see the same empty
      // payload as the no-inventory state and drop their overlays within
      // one 10s poll. /activity and /log relay stay untouched.
      getCurrentAd: () => canServeAds() && this.portfolioAd
        ? { adText: this.portfolioAd.text, clickUrl: this.portfolioAd.clickUrl,
            // Icon-less by default; the e2e icon override (data: URI only)
            // lets the closed-loop harness screenshot-verify the custom-icon
            // surface. Empty in production -> "K" fallback, unchanged.
            iconUrl: debugIconDataUri(), adId: "", campaignId: "" }
        : null,
    });
    // Reuse the persistent token + preferred port stored in globalState, and
    // register SECONDARY (audit #7): when the production loopback is (or
    // later comes) up, this returns the SAME shared server/port instead of
    // EADDRINUSE-ing onto stablePort+1, and the debug stub's handlers never
    // displace the production wiring. See bootLoopback() for details.
    const { port, token, base: lbBase } =
      await bootLoopback(this.lb, this.ctx, { secondary: true });
    const params: PatchParams = {
      tier: 3, adText: this.text(), iconRef: "", iconUrl: debugIconDataUri(),
      clickToken: "debug", clickUrl: this.portfolioAd?.clickUrl || DEFAULT_CLICK, corr: "debug." + token.slice(0, 6),
      loopbackPort: port,
      loopbackToken: token, loopbackBase: lbBase, debug: debugEnabled(),
      bannerOn: resolveBannerOn(false, this.bannerOverride()),
    };
    this.lastApplyParams = params;
    const res = this.adapter.applyPatch(params);
    dlog("ext", "debug.apply", { ok: res.ok, reason: res.reason, base: lbBase });
    // S9: patch Codex with the SAME debug params/loopback (guarded; never
    // blocks CC). This is what makes the ad show in Codex on the toggle path.
    const codexOk = this.applyCodexDebug(params);
    // wave-2A-F07 + Codex-only fix: succeed if EITHER target patched. The
    // CC-only success signal previously stranded Codex-only installs
    // (no CC extension on disk): apply() returned false, setOn refused
    // to persist K_ON=true, the menu permanently read "Enable
    // Kickbacks" even though the Codex shimmer file WAS patched, and
    // every subsequent toggle no-op'd because the menu state ⇄ disk
    // state diverged. Treat CC's "target not found" as a NON-ERROR
    // when Codex patched (the user clearly has Codex without CC), but
    // still surface a hard error when CC IS present and applyPatch
    // failed for a real reason.
    const ccPresent = res.reason !== "target not found";
    if (!res.ok && ccPresent)
      vscode.window.showErrorMessage(`Kickbacks: patch failed — ${res.reason}`);
    return !!res.ok || codexOk;
  }

  private diagnostics(): string {
    let sentinel = "n/a";
    try {
      const s = parseSentinel(readFileSync(reloadSentinelPath(), "utf8"));
      if (s) sentinel = `${s.version}@${s.ts || "?"}`;
    } catch { /* absent */ }
    const st = this.auth?.storageInfo();
    const authLine = this.auth
      ? (this.auth.signedIn() ? "in" : "out")
      : "n/a";
    return [
      "Kickbacks diagnostics",
      buildLabel(),
      `auth: ${authLine}`,
      `injection(K_ON): ${this.on() ? "ON" : "OFF"}`,
      `store: ${st ? st.scheme : "n/a"}`,
      `debug: ${debugEnabled() ? "on" : "off"}`,
      `webview: ${webviewMode()}  cli: ${cliMode()}  banner: ${this.bannerOverride()}`,
      `reload-sentinel: ${sentinel}`,
      `text: "${this.text()}"`,
    ].join("\n");
  }

  async dispose(): Promise<void> {
    if (this.lb) { await this.lb.stop(); this.lb = null; }
  }
}
