import * as vscode from "vscode";
import type { EarningCap } from "../earnings/client";

// Same red as the StatusBar "not earning" states (statusbar.ts RED). Kept in
// sync by value, not import, so this item stays fully independent of the main
// status-bar item (the whole point of the second-pill design).
const RED = "#f85149";

/** Format seconds-until-reset into a compact label: "<1m", "Nm", "NhMm"
 *  (the trailing minutes are dropped when zero). No existing helper for this
 *  exists in the extension, so it lives here, private to the cap pill. */
export function formatReset(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "<1m";
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** A SECOND, dedicated status-bar item that appears ONLY while the user has hit
 *  an earning cap — a red pill beside the green earnings item naming the cap
 *  and when it resets. Deliberately independent of StatusBar: it never touches
 *  the earnings item's reload-lock or ad-takeover logic, and the earnings
 *  figure stays visible alongside it.
 *
 *  Both scopes render red; the icon distinguishes them ($(clock) hourly vs
 *  $(warning) daily). Click opens the Kickbacks menu (where the cap + payout
 *  are also explained). */
export class CapWarning {
  // Priority 999 sits just to the RIGHT of the earnings item (priority 1000)
  // in the right-aligned cluster.
  private item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 999);
  constructor() {
    this.item.command = "kickbacks.debugMenu";
    this.item.color = RED;
  }

  /** Paint the cap pill for the given cap state. Idempotent — safe to call on
   *  every earnings poll; the reset countdown refreshes at poll resolution. */
  show(cap: EarningCap): void {
    const reset = formatReset(cap.resetSeconds);
    // capUsd is digits-only from the backend (e.g. "10.00"); prepend "$" here,
    // matching how StatusBar renders the earnings figure.
    const usd = `$${cap.capUsd}`;
    if (cap.scope === "hourly") {
      this.item.text = `$(clock) Hourly cap · ${reset}`;
      this.item.tooltip =
        `Hourly earning cap reached (${usd}/hr). `
        + `Earning resumes at the top of the hour (~${reset}). `
        + `You can earn more after that — this isn't an error.`;
    } else {
      this.item.text = `$(warning) Daily cap · ${reset}`;
      this.item.tooltip =
        `Daily earning cap reached (${usd}). `
        + `Earning resumes at 00:00 UTC (~${reset}). `
        + `You've earned the max for today — this isn't an error.`;
    }
    this.item.color = RED;
    this.item.show();
  }

  /** Hide the pill (under both ceilings, or any not-earning safety state). */
  hide(): void { this.item.hide(); }

  dispose(): void { this.item.dispose(); }
}
