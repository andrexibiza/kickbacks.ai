/** First-run consent prompt (wave-2I-F03).
 *
 * Surfaces a one-time vscode.window.showInformationMessage AFTER sign-in,
 * once per (extension instance × tos_version) tuple. Stores "shown for
 * version X" in globalState so we don't nag the same user on every reload.
 *
 * If the user clicks Agree, we POST /v1/me/consent (server stamps the
 * version). If they click Privacy, we open the privacy doc and leave the
 * prompt unflagged so it surfaces again next session (gentle, not pushy).
 * If they dismiss, we set "shown" so we don't nag this session.
 */
import type * as vscode from "vscode";
import type { ConsentClient, ConsentState } from "./client";

const SHOWN_KEY = "vibe-ads.consent.promptShownForVersion";
const PRIVACY_URL = "https://kickbacks.ai/privacy"; // hosted PRIVACY.md target

export interface ConsentPromptOptions {
  client: ConsentClient;
  ctx: vscode.ExtensionContext;
  vsc: typeof vscode;
  // dlog factory injected so unit tests can spy
  dlog?: (msg: string) => void;
}

export async function maybePromptForConsent(opts: ConsentPromptOptions): Promise<void> {
  const { client, ctx, vsc, dlog } = opts;
  // The caller fires this without awaiting (`void maybePromptForConsent(...)`)
  // — a rejection anywhere below would surface as an unhandledRejection, so
  // the whole body is guarded. Consent prompting is best-effort by contract.
  try {
    const state = await client.read();
    if (state === null) return; // signed out or backend unreachable; try later
    // Already consented to the live version → nothing to do.
    if (state.telemetryOptIn
        && state.tosAcceptedVersion === state.currentTosVersion) {
      return;
    }
    const shownFor = ctx.globalState.get<string>(SHOWN_KEY);
    if (shownFor === state.currentTosVersion) {
      // Already nagged for this version this session/process; defer to next.
      return;
    }
    dlog?.(`consent.prompt show version=${state.currentTosVersion}`);
    const pick = await vsc.window.showInformationMessage(
      "Kickbacks shows subtle ads in the Claude Code spinner and splits "
      + "50/50 of every settled dollar back to you. Telemetry is opt-in. "
      + "Continue?",
      { modal: false },
      "Agree",
      "Privacy Policy",
    );
    if (pick === "Agree") {
      const result = await client.accept();
      dlog?.(`consent.prompt accept result=${result ? "ok" : "fail"}`);
      if (result) {
        // Mark shown only after successful POST to avoid stranding the user
        // in a partial-accept state.
        void ctx.globalState.update(SHOWN_KEY, result.tosVersion);
      }
      return;
    }
    if (pick === "Privacy Policy") {
      void vsc.env.openExternal(vsc.Uri.parse(PRIVACY_URL));
      // Don't mark shown — surface again next session.
      return;
    }
    // Dismissed -> set "shown" for this version so we don't pester.
    void ctx.globalState.update(SHOWN_KEY, state.currentTosVersion);
  } catch (e) {
    dlog?.(`consent.prompt error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
