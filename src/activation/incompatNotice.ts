import * as vscode from "vscode";
import { dlog } from "../log";
import type { PreflightResult, TargetAdapter } from "../adapters/types";

/** One-time-per-version warning when Claude Code is genuinely unpatchable.
 *
 *  Tightly gated so the known transient/cosmetic "incompatible" flash never
 *  nags the user:
 *   - only the structural "verb array not found" miss — a real adapter probe
 *     miss. "target not found" (CC absent) and transient apply/port failures
 *     never fire here.
 *   - never when the live file already carries our block: isPatched() ⇒ the ad
 *     is serving and the label was a stale flash.
 *   - deduped per CC version in globalState, so a reload never re-nags and only
 *     a NEW breaking version notifies again.
 *
 *  Best-effort: never throws, never blocks activation.
 */
export function notifyIncompatible(
  ctx: vscode.ExtensionContext,
  adapter: TargetAdapter,
  pf: PreflightResult,
): void {
  try {
    if (!pf.reason?.includes("verb array not found")) return;
    if (adapter.isPatched?.()) return;
    const version = pf.version ?? "unknown";
    const key = `kickbacks.incompatNotified:${version}`;
    if (ctx.globalState.get<boolean>(key)) return;
    void ctx.globalState.update(key, true);
    dlog("ext", "incompat.notify", { version });
    void vscode.window.showWarningMessage?.(
      `Kickbacks couldn't find Claude Code ${version}'s spinner hook — ads are paused. `
      + `Your editor is unaffected; run Kickbacks: Diagnose for details.`);
  } catch { /* notification is best-effort */ }
}
