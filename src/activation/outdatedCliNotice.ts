import * as vscode from "vscode";
import { dlog } from "../log";
import { SPINNER_VERBS_FLOOR, type SemVer } from "../adapters/claude-cli/cliVersion";

/** One-time-per-version warning when the terminal `claude` CLI is POSITIVELY
 *  detected older than the spinnerVerbs floor (2.1.143). On those builds the
 *  spinner-verb ad surface is silently ignored, so the user sees stock verbs
 *  and never learns their CLI is the reason — and their share never accrues
 *  from that surface. We surface it instead of failing silent.
 *
 *  Gated like notifyIncompatible:
 *   - caller only invokes this on a positively-detected old version, never on
 *     the fail-open (undetectable / absent CLI) path — see SpinnerSupport.
 *   - deduped per detected version in globalState, so a reload never re-nags
 *     and only a different old version notifies again.
 *
 *  Best-effort: never throws, never blocks activation.
 */
export function notifyOutdatedCli(
  ctx: vscode.ExtensionContext,
  v: SemVer,
): void {
  try {
    const cur = `${v[0]}.${v[1]}.${v[2]}`;
    const floor =
      `${SPINNER_VERBS_FLOOR[0]}.${SPINNER_VERBS_FLOOR[1]}.${SPINNER_VERBS_FLOOR[2]}`;
    const key = `kickbacks.outdatedCliNotified:${cur}`;
    if (ctx.globalState.get<boolean>(key)) return;
    void ctx.globalState.update(key, true);
    dlog("ext", "cli.outdated.notify", { version: v, floor: SPINNER_VERBS_FLOOR });
    void vscode.window.showWarningMessage?.(
      `Kickbacks: your Claude Code CLI (${cur}) is older than ${floor}, so `
      + `spinner ads can't render. Run \`claude update\` (or reinstall the `
      + `latest Claude Code), then reload the window.`);
  } catch { /* notification is best-effort */ }
}
