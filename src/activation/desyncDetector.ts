import * as vscode from "vscode";
import { dlog } from "../log";
import { desyncDecision } from "../reassert";

export interface DesyncState {
  lastApplyAt: number;
  lastBlockStartAt: number;
}

/** Wired by extension.ts. All optional so the detector degrades to a passive
 *  logger if a dep is missing (and keeps the old call shape working in tests).
 *  - ccActivityAgeMs: independent "is the user using Claude Code right now"
 *    signal (CC transcript mtime age). null/unknown => treated as idle.
 *  - healthy: shouldReassert() snapshot — never act when signed-out / no ad /
 *    kill-switched.
 *  - hardReassert: the cheap file-identity nudge (cyclePatch for the debug
 *    path, restore+applyPatch for the production path). Guarded; never throws. */
export interface DesyncDeps {
  ccActivityAgeMs: () => number | null;
  healthy: () => boolean;
  hardReassert: () => void;
  /** True while the CC panel is in an active tool_use turn (sub-agent
   *  running). Disruptive escalation (reload, toast) is deferred until
   *  the turn completes. null = unknown. */
  ccTurnActive?: () => boolean | null;
}

export function setupDesyncDetector(
  state: DesyncState,
  timers: NodeJS.Timeout[],
  deps?: DesyncDeps,
): void {
  const startedAt = Date.now();
  let cyclePatchTried = false;
  let reloadTried = false;
  let toastShownAt = 0;
  let lastLoggedAt = 0;

  timers.push(setInterval(() => {
    try {
      const now = Date.now();
      const d = desyncDecision({
        now,
        startedAt,
        lastApplyAt: state.lastApplyAt,
        lastBlockStartAt: state.lastBlockStartAt,
        ccActivityAgeMs: deps ? deps.ccActivityAgeMs() : null,
        // No deps (legacy/test): stay passive — never escalate without a
        // health snapshot to gate on.
        healthy: deps ? deps.healthy() : false,
        cyclePatchTried,
        reloadTried,
        toastShownAt,
        ccTurnActive: deps?.ccTurnActive?.() ?? null,
      });

      // Overlay recovered (block.start observed since apply): re-arm the ladder.
      if (d.reason === "in-sync") {
        cyclePatchTried = false;
        reloadTried = false;
        return;
      }
      if (d.action === "none") return;

      // Throttled desync log (observability) — at most once / 5 min.
      if (now - lastLoggedAt >= 5 * 60_000) {
        lastLoggedAt = now;
        dlog("ext", "block.desync", {
          action: d.action,
          ageSinceApplyMs: now - state.lastApplyAt,
          lastBlockStartAt: state.lastBlockStartAt,
          note: "patched on disk but overlay telemetry silent while CC is "
            + "active — webview cached the pre-patch module.",
        });
      }

      if (d.action === "cycle") {
        // Tier 1: cheapest disruption — re-mint the patch so the file's
        // identity changes and VS Code re-evaluates the module. No reload.
        cyclePatchTried = true;
        dlog("ext", "block.desync.cycle", {});
        try { deps?.hardReassert(); } catch { /* prime directive */ }
        return;
      }

      if (d.action === "reload") {
        // Tier 2: reload the focused webview's content (no window churn).
        reloadTried = true;
        dlog("ext", "block.desync.autoReload", {
          note: "reloadWebviewContent targets the focused webview; "
            + "if the CC panel isn't focused this may be a no-op",
        });
        void vscode.commands.executeCommand(
          "workbench.action.webview.reloadWebviewContent")
          .then(
            () => dlog("ext", "block.desync.autoReload.dispatched", {}),
            () => dlog("ext", "block.desync.autoReload.fail", {}),
          );
        return;
      }

      if (d.action === "toast") {
        // Tier 3 (last resort, user-consented): a full window reload.
        toastShownAt = now;
        void (async () => {
          try {
            const choice = await vscode.window.showWarningMessage?.(
              "Kickbacks: ads aren't loading in the Claude Code panel. "
              + "Automatic heals didn't clear the cache. "
              + "A full window reload will fix it.",
              "Reload Window", "Dismiss");
            if (choice === "Reload Window") {
              await vscode.commands.executeCommand(
                "workbench.action.reloadWindow");
            }
          } catch { /* toast is best-effort */ }
        })();
        return;
      }
    } catch { /* prime directive */ }
  }, 30_000));
}
