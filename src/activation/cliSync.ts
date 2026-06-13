import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as vscode from "vscode";
import type { TargetAdapter } from "../adapters/types";
import type { AuthClient } from "../auth/client";
import type { MetricsClient } from "../metrics/client";
import type { DebugController } from "../debug";
import type { PatchAd } from "../portfolio/client";
import { ClaudeCliStatuslineAdapter } from "../adapters/claude-cli/adapter";
import { detectClaudeCliSpinnerSupport } from "../adapters/claude-cli/cliVersion";
import { notifyOutdatedCli } from "./outdatedCliNotice";
import { CodexCliWrapperAdapter } from "../adapters/codex-cli/adapter";
import { writeCliAdCache, cliSessionActive, shouldCountCliImpression,
  shouldCountSpinnerImpression, FRESH_MS }
  from "../adapters/claude-cli/cliAd";
import { dlog, codexCliEnabled } from "../log";
import { errMsg } from "../util/errMsg";
import { cliMode, webviewMode } from "../modes";
import { servingVerdict } from "../servingGate";
import type { ActivationContext } from "./context";
import { restoreCodexSafe } from "./commands";

export interface CliSyncDeps {
  actx: ActivationContext;
  /** Extension context — used for globalState-deduped user notices. */
  ctx: vscode.ExtensionContext;
  adapter: TargetAdapter;
  auth: AuthClient;
  metrics: MetricsClient;
  debugCtl: DebugController;
  ccVersion: string;
  /** Mutable ref for the outer `ad` variable. */
  adRef: { current: PatchAd | null };
  /** Mutable ref for the killed state. */
  killedRef: { current: boolean };
  /** Mutable ref for the test-override killed flag. */
  overrideKilled?: boolean;
  /** Codex reapply function from webview injection (may be null). */
  reapplyCodex: (() => void) | null;
}

/** Resolve the npm-installed Codex CLI shim path, or null if not present. */
export function locateCodexCliShim(): string | null {
  try {
    if (process.platform === "win32") {
      const appData = process.env.APPDATA;
      if (!appData) return null;
      const p = join(appData, "npm", "codex.cmd");
      return existsSync(p) ? p : null;
    }
    const cands = [
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex",
      join(homedir(), ".npm-global", "bin", "codex"),
      join(homedir(), ".local", "bin", "codex"),
    ];
    for (const c of cands) if (existsSync(c)) return c;
    return null;
  } catch { return null; }
}

/** Handle returned by setupCliSync: an imperative trigger to re-sync the CLI
 *  surface NOW (instead of waiting for the 60s timer). Used by the ad-apply
 *  choke point so a fresh ad — sign-in demo→real swap or a rotation — reaches
 *  `~/.claude/settings.json` immediately. Guarded + idempotent, so callers can
 *  fire it freely. */
export interface CliSyncHandle {
  syncNow: () => void;
}

/** Set up the CLI status-line surface and its sync timer. Wires the
 *  debug-menu reassert callbacks. Pushes timers into actx.timers. */
export function setupCliSync(deps: CliSyncDeps): CliSyncHandle {
  const {
    actx, ctx, adapter, auth, metrics, debugCtl,
    ccVersion, adRef, killedRef, reapplyCodex,
  } = deps;
  const overrideKilled = deps.overrideKilled;

  // CLI status-line surface.
  const cliSettingsPath = join(homedir(), ".claude", "settings.json");
  actx.cliStatus = new ClaudeCliStatuslineAdapter(cliSettingsPath);

  // Only count the spinner-verb impression once `claude --version` has
  // POSITIVELY confirmed support. The adapter's `spinnerVerbsSupported`
  // render flag is fail-open (defaults true so the verb is written on the
  // common new-CLI case before detection resolves), but billing must wait
  // for confirmation — otherwise the first synchronous sync on an old CLI
  // counts a verb that never renders. See shouldCountSpinnerImpression.
  let spinnerCountable = false;

  // Codex CLI banner wrapper (off by default; sentinel-gated).
  if (codexCliEnabled() && !actx.codexCliStatus) {
    const codexShim = locateCodexCliShim();
    if (codexShim) {
      actx.codexCliStatus = new CodexCliWrapperAdapter(codexShim, homedir());
      dlog("ext", "codex-cli.wired", { shim: codexShim });
    } else {
      dlog("ext", "codex-cli.skip", { reason: "shim-not-found" });
    }
  }

  const syncCli = (): void => {
    try {
      // Serving gate (wave 2, audit #3): pre-fix this 60s tick compared only
      // the TEST override, so a live kill never stopped the re-apply that
      // checkKill's cliStatus.restore() had just undone. Three-way now:
      //   freeze   (offline-unsure / canary-suspended) → neither write nor
      //            restore — keep the on-disk state, no churn;
      //   write    (healthy + enabled) → the normal apply path below;
      //   restore  (confirmed kill / user-disabled) → fall through to the
      //            restore branch, same as ad-lost/signed-out.
      const verdict = servingVerdict();
      if (verdict === "freeze") return;
      const ad = adRef.current;
      if (verdict === "write" && ad && auth.accessToken()
          && overrideKilled !== true && cliMode() === "on") {
        const pfCli = actx.cliStatus!.preflight();
        if (pfCli.compatible) {
          actx.cliStatus!.applyPatch({ tier: 0, adText: ad.adText,
            iconRef: ad.iconRef, iconUrl: ad.iconUrl, clickToken: "", clickUrl: ad.clickUrl,
            corr: "cli." + Math.random().toString(36).slice(2, 8),
            loopbackPort: 0, loopbackToken: "", loopbackBase: "" });
          writeCliAdCache(homedir(), { adText: ad.adText,
            iconRef: ad.iconRef, iconUrl: ad.iconUrl, clickUrl: ad.clickUrl });
          // Codex CLI wrapper.
          if (actx.codexCliStatus) {
            try {
              const pfCx = actx.codexCliStatus.preflight();
              if (pfCx.compatible) {
                const r = actx.codexCliStatus.applyPatch({ tier: 0,
                  adText: ad.adText, iconRef: ad.iconRef, iconUrl: ad.iconUrl,
                  clickToken: "", clickUrl: ad.clickUrl,
                  corr: "codex-cli." + ad.adId,
                  loopbackPort: 0, loopbackToken: "", loopbackBase: "" });
                dlog("ext", "codex-cli.applyPatch",
                  { ok: r.ok, reason: r.reason });
              } else {
                dlog("ext", "codex-cli.skip", { reason: pfCx.reason });
              }
            } catch (e) {
              dlog("ext", "codex-cli.error",
                { msg: errMsg(e) });
            }
          }
          if (shouldCountCliImpression({ signedIn: !!auth.accessToken(),
              haveAd: true,
              sessionActive: cliSessionActive(Date.now(), FRESH_MS),
              adId: ad.adId, lastCountedAdId: actx.lastCliAdId })) {
            actx.lastCliAdId = ad.adId;
            const cliCorr = "cli." + ad.adId;
            void metrics.send("impression_rendered", { adId: ad.adId,
              campaignId: ad.campaignId, ccVersion,
              corr: cliCorr, surface: "statusline" });
            void metrics.send("impression_viewable", { adId: ad.adId,
              campaignId: ad.campaignId, ccVersion,
              corr: cliCorr, surface: "statusline",
              sessionToken: ad.sessionToken });
          }
          // Spinner-verb surface: a distinct brand-impression surface from
          // the statusline, deduped on its own counter. Gated on confirmed
          // spinnerVerbs support — else nothing renders and we'd be billing
          // for an invisible impression.
          if (shouldCountSpinnerImpression({ supportConfirmed: spinnerCountable,
              signedIn: !!auth.accessToken(),
              haveAd: true,
              sessionActive: cliSessionActive(Date.now(), FRESH_MS),
              adId: ad.adId, lastCountedAdId: actx.lastCliSpinnerAdId })) {
            actx.lastCliSpinnerAdId = ad.adId;
            const spinnerCorr = "spinner." + ad.adId;
            void metrics.send("impression_rendered", { adId: ad.adId,
              campaignId: ad.campaignId, ccVersion,
              corr: spinnerCorr, surface: "spinner" });
            void metrics.send("impression_viewable", { adId: ad.adId,
              campaignId: ad.campaignId, ccVersion,
              corr: spinnerCorr, surface: "spinner",
              sessionToken: ad.sessionToken });
          }
        }
      } else {
        actx.cliStatus!.restore();
        try { actx.codexCliStatus?.restore(); } catch { /* ignore */ }
      }
    } catch { /* prime directive: never break activation */ }
  };
  // Detect whether the terminal CLI honours `spinnerVerbs` (CC >= 2.1.143),
  // then reconcile. Async + non-blocking: the first sync below already wrote
  // the verb (fail-open render). Once detection resolves we re-sync so a
  // confirmed-new CLI starts counting the spinner impression, and a
  // positively-old CLI evicts the optimistically-written key (render flag
  // flips false) and never counts it.
  void detectClaudeCliSpinnerSupport().then(({ ok, version, outdated }) => {
    if (actx.cliStatus) actx.cliStatus.spinnerVerbsSupported = ok;
    spinnerCountable = ok === true;
    dlog("ext", "cli.spinnerVerbs", { supported: ok });
    // Only nag on a POSITIVELY old CLI — never the fail-open (undetectable)
    // path, which would warn installs we can't even probe. Deduped per version.
    // Skip when the install is killed: a remotely-disabled extension renders no
    // ads anyway, so an "update your CLI" toast would be pure noise. (killedRef
    // is a live getter — detection resolves async, so this reads the kill state
    // as of resolution.)
    if (outdated && version && !killedRef.current) notifyOutdatedCli(ctx, version);
    syncCli();
  }).catch(() => { /* fail-open render default stays; never count */ });

  syncCli();
  actx.timers.push(setInterval(syncCli, 60_000));

  debugCtl?.setReassert(() => {
    try {
      syncCli();
      if (webviewMode() === "off") {
        adapter.restore();
        restoreCodexSafe(actx.codexAdapter);
      }
    } catch { /* prime directive */ }
  });
  debugCtl?.setReassertCodex(() => {
    try { reapplyCodex?.(); } catch { /* prime directive */ }
  });

  return { syncNow: () => { try { syncCli(); } catch { /* prime directive */ } } };
}
