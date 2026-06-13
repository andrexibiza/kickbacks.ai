import * as vscode from "vscode";
import { dlog } from "../log";

const RELOAD_CMD = "workbench.action.reloadWindow";

/** Aggressive post-install nudge. The patch lands during the first
 *  activation, but the already-running Claude Code webview loaded the
 *  pre-patch build — so a fresh install earns nothing until the window
 *  reloads. Modal on purpose (a passive toast was getting missed); pairs
 *  with the sticky red `needs-reload` status-bar state, which stays up
 *  until the reload actually happens. Never throws. */
export async function showInstallReloadNudge(): Promise<void> {
  try {
    const choice = await vscode.window.showInformationMessage?.(
      "Kickbacks won't earn money until you reload.",
      { modal: true,
        detail: "Kickbacks is installed, but this window is still running "
          + "the old Claude Code build. Reload to start collecting money — "
          + "the status bar stays red until you do." },
      "Reload Now");
    dlog("ext", "installNudge.choice", { choice: choice || "dismissed" });
    if (choice === "Reload Now")
      await vscode.commands.executeCommand(RELOAD_CMD);
  } catch { /* prime directive — a nudge must never break activation */ }
}

/** Shown on every successful interactive sign-in. The live demo→real ad
 *  swap usually works without a reload, but the webview can hold a stale
 *  module (block.desync) and silently not credit the user — a reload is
 *  the one path that always works, so steer the user there. Never throws. */
export async function showSignInReloadNudge(): Promise<void> {
  try {
    const choice = await vscode.window.showInformationMessage?.(
      "You're signed in — reload to start collecting money.",
      { modal: true,
        detail: "A window reload makes sure every ad surface picks up your "
          + "account, so impressions credit you from the very next spin." },
      "Reload Now");
    dlog("ext", "signinNudge.choice", { choice: choice || "dismissed" });
    if (choice === "Reload Now")
      await vscode.commands.executeCommand(RELOAD_CMD);
  } catch { /* prime directive */ }
}
