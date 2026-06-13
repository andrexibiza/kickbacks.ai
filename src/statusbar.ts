import * as vscode from "vscode";
import { buildLabel } from "./buildinfo";

export type SbState =
  | { kind: "signed-out" }
  | { kind: "active"; version: string; usd?: string; usdToday?: string }
  | { kind: "incompatible"; version: string }
  | { kind: "killed" }
  | { kind: "offline" }
  // `debug` renders exactly like `active` (the word "debug" is intentionally
  // never surfaced in the status-bar text — operator-facing detail only).
  | { kind: "debug"; on: boolean; version?: string; usd?: string; usdToday?: string }
  | { kind: "ad"; adText: string }
  // STICKY: the patch landed this session but the running Claude Code webview
  // predates it — no ads (so no earnings) until a window reload. Once set,
  // ROUTINE paints (ad / active / debug-ON earnings) are ignored so they
  // can't bury the red "reload" call-to-action; safety/truth states (killed,
  // offline, signed-out, incompatible, debug-OFF) always win and clear the
  // lock — the bar must never hide a kill, an outage, or an auth loss behind
  // the CTA (audit #29). The lock also clears with the reload itself (fresh
  // activation).
  | { kind: "needs-reload" };

// Darker than the previous #3fb950 (GitHub success-emphasis green) so it
// reads as confident-earning rather than a bright neon stripe.
const GREEN = "#2ea043";
// Used for states where the extension isn't earning (signed-out, injection
// toggled off, kill-switch engaged, backend offline). Sits at the same
// confidence level as GREEN — bright enough to flag the state at a glance
// in the status bar without being a "broken" red.
const RED = "#f85149";

export class StatusBar {
  // Right-aligned (priority high so it sits toward the leading edge of the
  // right cluster).
  private item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 1000);
  text = "";
  constructor() { this.item.command = "kickbacks.debugMenu"; this.item.show(); }

  // Always render the two-figure form. A missing figure (fetch failed, or
  // signed-in before the first /v1/earnings poll) degrades to "$0.00" — the
  // signed-in/active bar never shows a bare label. Note: a fetch failure is
  // therefore indistinguishable from genuine zero earnings (deliberate, per
  // product call — prefer always showing a dollar figure).
  private earned(usd?: string, today?: string): string {
    return ` ($${today ?? "0.00"} today · $${usd ?? "0.00"})`;
  }

  /** True once `needs-reload` has been shown; masks ROUTINE repaints only
   *  (see the SbState docstring). */
  private reloadLock = false;

  /** Routine earning paints — the only kinds the reload lock may mask.
   *  Everything else (killed, offline, signed-out, incompatible, debug-OFF)
   *  is a safety/truth state the bar must never hide behind the CTA. */
  private static isRoutine(s: SbState): boolean {
    return s.kind === "ad" || s.kind === "active"
      || (s.kind === "debug" && s.on !== false);
  }

  /** Returns false when the paint was suppressed by the reload lock —
   *  statusBarAd checks this so an ad whose paint never landed is never
   *  billed (no impression/view_tick for an undisplayed ad, audit #29). */
  set(s: SbState): boolean {
    if (this.reloadLock && s.kind !== "needs-reload") {
      if (StatusBar.isRoutine(s)) return false;
      // Safety/truth state: always paint, and release the lock so the
      // recovery paints that follow (e.g. back-online "active") aren't
      // dropped against a stale safety label.
      this.reloadLock = false;
    }
    let color: string | undefined;
    let background: vscode.ThemeColor | undefined;
    let command = "kickbacks.debugMenu";
    let tooltip = "Kickbacks";
    switch (s.kind) {
      case "signed-out":
        // No icon — the "K" codicon doesn't exist in VS Code's default set,
        // and a generic glyph would misrepresent the brand. Text only.
        // RED to flag the not-earning state at a glance.
        this.text = "Kickbacks: Sign in";
        color = RED;
        tooltip = "Click to sign in to Kickbacks";
        break;
      case "active":
        this.text = `Kickbacks${this.earned(s.usd, s.usdToday)}`;
        color = GREEN;
        tooltip = `Kickbacks active${s.version ? ` · Claude Code ${s.version}` : ""}`
          + ` · $${s.usdToday ?? "0.00"} today · $${s.usd ?? "0.00"} earned`
          + " (display-only credit, payout TBD)";
        break;
      case "debug":
        // Signed-in/debug: green when ON, red when OFF (user has the menu
        // master switch flipped off — earnings paused).
        if (s.on === false) {
          this.text = "Kickbacks: Off";
          color = RED;
          tooltip = "Kickbacks is currently OFF — click to re-enable";
        } else {
          this.text = `Kickbacks${this.earned(s.usd, s.usdToday)}`;
          color = GREEN;
          tooltip = `Kickbacks active${s.version ? ` · Claude Code ${s.version}` : ""}`
            + ` · $${s.usdToday ?? "0.00"} today · $${s.usd ?? "0.00"} earned`
            + " (display-only credit, payout TBD)";
        }
        break;
      case "incompatible":
        this.text = `Kickbacks incompatible (${s.version})`;
        break;
      case "killed":
        this.text = "Kickbacks killed";
        color = RED;
        break;
      case "offline":
        this.text = "Kickbacks offline";
        color = RED;
        break;
      case "ad":
        // Brand the status-bar ad with a pipe separator: "Kickbacks.ai  |  <ad>".
        this.text = `Kickbacks.ai  |  ${s.adText}`;
        color = GREEN;
        tooltip = "Kickbacks ad";
        break;
      case "needs-reload":
        this.reloadLock = true;
        this.text = "$(warning) Kickbacks: RELOAD to earn money";
        // errorBackground is the only red background VS Code lets a status-bar
        // item paint; the theme pairs it with white foreground. Explicit white
        // on top so a custom theme can't dim the call-to-action.
        background = new vscode.ThemeColor("statusBarItem.errorBackground");
        color = "#ffffff";
        // One click = the reload itself (not the menu) — the whole point of
        // this state is removing every step between the user and the reload.
        command = "workbench.action.reloadWindow";
        tooltip = "Kickbacks won't earn money until you reload — click to reload now";
        break;
    }
    // The click opens the menu (GET PAID OUT / sign in / sign out live there)
    // — except needs-reload, where the click IS the reload.
    this.item.command = command;
    this.item.backgroundColor = background;
    this.item.color = color;
    // Live build age in the tooltip — the truthful "how long ago published"
    // the VS Code Installation panel can't show (it's not author-extensible).
    this.item.tooltip = `${tooltip} · ${buildLabel()}`;
    this.item.text = this.text;
    return true;
  }
  dispose(): void { this.item.dispose(); }
}
