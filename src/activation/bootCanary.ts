import * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, unlinkSync, statSync,
         readFileSync } from "node:fs";
import type { DebugController } from "../debug";
import type { TargetAdapter } from "../adapters/types";
import { canPatch, suspendServing } from "../servingGate";
import { dlog } from "../log";
import { errMsg } from "../util/errMsg";

const CANARY_PATH = join(homedir(), ".vibe-ads", "boot.canary");
const SETTLE_MS = 5_000;
const CANARY_STALE_MS = 90 * 1000;
const FIRST_RUN_KEY = "kickbacks.firstRun.completed";

/** `firstRun` is true exactly once — the activation that flips
 *  FIRST_RUN_KEY (i.e. the install). The crash-recovery path reports
 *  false (no patch was applied, so a reload nudge would be a lie) and
 *  leaves the key unset, so the next clean activation still counts.
 *
 *  `anyTargetCompatible` (optional) widens the clean-boot auto-enable gate
 *  to EITHER webview target: a Codex-only machine (no/incompatible Claude
 *  Code) must still persist K_ON on first run, or it never serves —
 *  DebugController.apply() already treats a Codex-only patch as success.
 *  Omitted ⇒ falls back to the Claude-only preflight (legacy call shape). */
export async function setupBootCanary(
  adapter: TargetAdapter,
  debugCtl: DebugController,
  ctx: vscode.ExtensionContext,
  anyTargetCompatible?: boolean,
): Promise<{ firstRun: boolean }> {
  let firstRun = false;
  let canaryFromCrash = false;
  // The settle timer below may only unlink the canary whose content it owns
  // (crash path: the file it observed; clean path: the token it wrote). The
  // canary lives in the shared ~/.vibe-ads, so a second VS Code window (or a
  // parallel test worker) may re-write it at any time — an unguarded unlink
  // would strip THAT activation's crash protection.
  let settleToken = "";
  try {
    if (existsSync(CANARY_PATH)) {
      settleToken = readFileSync(CANARY_PATH, "utf8");
      const age = Date.now() - statSync(CANARY_PATH).mtimeMs;
      if (age < CANARY_STALE_MS) canaryFromCrash = true;
    }
  } catch { /* ignore */ }

  if (canaryFromCrash) {
    // Suspend the WHOLE session's automatic patch writers (wave 2, audit
    // #14) — pre-fix only the calls below were skipped and the production
    // activation path re-patched seconds after the toast. The suspension
    // lifts only on an explicit user re-enable (DebugController.setOn(true)),
    // matching the toast's "manually re-enable" wording.
    suspendServing();
    dlog("ext", "boot.canary.skip", {
      reason: "prior activation didn't settle (likely VS Code crash mid-patch)" });
    try {
      await vscode.window.showWarningMessage?.(
        "Kickbacks: prior activation didn't complete cleanly — skipping " +
        "automatic patch this run. Click the status bar to manually " +
        "re-enable once you're sure VS Code is stable.");
    } catch { /* no-op (test mock may lack showWarningMessage) */ }
  } else {
    try {
      mkdirSync(join(homedir(), ".vibe-ads"), { recursive: true });
      settleToken = String(Date.now());
      writeFileSync(CANARY_PATH, settleToken);
    } catch { /* canary is best-effort */ }

    try {
      const targetOk = anyTargetCompatible ?? adapter.preflight().compatible;
      // Auto-enable on a clean boot only when the consent gate allows it
      // (never-toggled first run, or injection was ON before the last
      // sign-out). PRESERVE a deliberate "Disable Kickbacks" — the old
      // condition re-enabled on every boot, stomping an explicit opt-out
      // (audit EXT-01 / 2A-02). canPatch() additionally blocks the
      // auto-enable's setOn(true) apply on a persisted-kill boot (wave 2,
      // audit #19) — setOn itself is the MANUAL path and stays ungated.
      if (targetOk && canPatch() && !debugCtl.on()
          && debugCtl.shouldAutoEnableOnSignIn()) {
        await debugCtl.setOn(true);
        dlog("ext", "boot.autoenable", { applied: true });
      }
      if (ctx.globalState.get<boolean>(FIRST_RUN_KEY) !== true) {
        firstRun = true;
        await ctx.globalState.update(FIRST_RUN_KEY, true);
      }
    } catch (e) {
      dlog("ext", "boot.autoenable.error",
        { msg: errMsg(e) });
    }

    await debugCtl.reapplyIfOn();

    try {
      const cycleKill = join(homedir(), ".vibe-ads", "no-boot-cycle.enabled");
      if (existsSync(cycleKill)) {
        dlog("ext", "boot.cycle.skip", { reason: "sentinel" });
      } else {
        dlog("ext", "boot.cycle.start", {});
        const r = debugCtl.cyclePatch();
        dlog("ext", "boot.cycle.done", { ok: r.ok, reason: r.reason });
      }
    } catch (e) {
      dlog("ext", "boot.cycle.error",
        { msg: errMsg(e) });
    }
  }

  // Clear the canary once VS Code has been alive for SETTLE_MS — but only
  // if it is still OUR canary (see settleToken above).
  setTimeout(() => {
    try {
      if (readFileSync(CANARY_PATH, "utf8") === settleToken) {
        unlinkSync(CANARY_PATH);
      }
    } catch { /* ignore */ }
  }, SETTLE_MS).unref?.();
  return { firstRun };
}
