import * as vscode from "vscode";
import type { AdapterDiagnostics, TargetAdapter } from "../adapters/types";
import { buildVersion, buildLabel, BUILD_TS } from "../buildinfo";
import { debugEnabled, LOG_PATH } from "../log";

/** Plain-English verdict + remedy for a Claude Code diagnosis. This is the line
 *  that ends the guessing: it maps the raw flags to "what's wrong and what to
 *  do", so a screenshot of the report is self-explanatory. */
export function interpret(d: AdapterDiagnostics): string {
  if (d.compatible) {
    return d.isPatched
      ? "VERDICT: OK — Claude Code is patchable and the ad block is live."
      : "VERDICT: OK — Claude Code is patchable (block not applied yet this session).";
  }
  if (!d.targetExists)
    return "VERDICT: Claude Code not found at the target path. Is the Claude Code "
      + "extension installed? (No action for Kickbacks.)";
  if (d.live.bareVerbPresent && !d.live.hasArray)
    return "VERDICT: the verb words exist but NOT in a matchable array — Claude "
      + "Code likely changed its bundle format. FIX: update the adapter's array "
      + "regex/anchors (this is a real CC change, send this report to the dev).";
  if (!d.live.bareVerbPresent && !d.backup.hasArray)
    return "VERDICT: the verb array is missing from the live file and no good "
      + "backup exists — the file was stripped/corrupted (an old patch). FIX: "
      + "reinstall or update Claude Code to restore its original file, then reload.";
  if (d.backup.exists && !d.backup.hasArray && d.live.hasArray)
    return "VERDICT: stale backup but the live file is fine — should self-heal on "
      + "the next apply. FIX: update Kickbacks to the latest build and reload.";
  return "VERDICT: incompatible — verb array not located. Send this report to the dev.";
}

/** Codex inputs for the report. `adapter` is located for DIAGNOSIS regardless
 *  of the serving policy (null = no Codex install on this machine); `policy`
 *  is the boot-time codexFallback verdict + its inputs. Keeping both lets the
 *  report explain the BUG-001 dual-install case — "Codex installed, serving
 *  deliberately OFF" — instead of silently omitting the section. */
export interface CodexDiagnostics {
  adapter: TargetAdapter | null;
  policy: { discoveryEnabled: boolean; optIn: boolean; optOut: boolean;
            claudeCompatible: boolean };
}

/** Plain-English verdict for the Codex section. The dual-install case is the
 *  one users actually hit (BUG-001): Codex installed alongside a working
 *  Claude Code → serving is opt-in by design, not broken. */
export function interpretCodex(
  p: CodexDiagnostics["policy"], compatible: boolean,
): string {
  if (p.optOut)
    return "VERDICT: Codex ad-serving is explicitly disabled "
      + "(~/.vibe-ads/codex.disabled or KICKBACKS_CODEX=0).";
  if (!p.discoveryEnabled)
    return "VERDICT: Codex detected but Codex ad-serving is OFF — it is "
      + "opt-in on machines with a working Claude Code (expected, not a bug). "
      + "To serve ads in Codex too: set KICKBACKS_CODEX=1 or create "
      + "~/.vibe-ads/codex.enabled, then reload.";
  return compatible
    ? "VERDICT: OK — Codex is a live ad target this session."
    : "VERDICT: Codex targeted but incompatible — send this report to the dev.";
}

/** Render the full copyable diagnostic report. Pure (no I/O) for easy testing. */
export function formatDiagnostics(
  cc: TargetAdapter | null, codex: CodexDiagnostics | null,
): string {
  const L: string[] = [];
  L.push("=== Kickbacks Diagnostics ===");
  L.push(`extension version: ${buildVersion()}`);
  L.push(`build: ${buildLabel()}  (BUILD_TS=${BUILD_TS || "dev"})`);
  L.push(`debug enabled: ${debugEnabled()}`);
  L.push(`debug log: ${LOG_PATH}`);
  L.push("");
  L.push("--- Claude Code ---");
  const d = cc?.diagnose?.();
  if (!d) {
    L.push("(no diagnose() available)");
  } else {
    L.push(`target: ${d.target}`);
    L.push(`target exists: ${d.targetExists}`);
    L.push(`CC version: ${d.version}`);
    L.push(`PREFLIGHT compatible: ${d.compatible}`);
    if (d.reason) L.push(`preflight reason: ${d.reason}`);
    L.push(`patch live (isPatched): ${d.isPatched}`);
    L.push(`backup: exists=${d.backup.exists} hasArray=${d.backup.hasArray} `
      + `hasBlock=${d.backup.hasBlock}`);
    if (d.backup.path) L.push(`  backup path: ${d.backup.path}`);
    L.push(`live: hasArray=${d.live.hasArray} bareVerbPresent=${d.live.bareVerbPresent}`);
    L.push("");
    L.push(interpret(d));
  }
  if (codex) {
    L.push("");
    L.push("--- Codex ---");
    if (!codex.adapter) {
      L.push("Codex (openai.chatgpt) not found on this machine.");
    } else {
      const pf = (() => {
        try { return codex.adapter.preflight(); }
        catch { return { compatible: false, reason: "preflight threw",
                         version: null as string | null }; }
      })();
      L.push(`compatible: ${pf.compatible}`
        + `${pf.reason ? ` reason=${pf.reason}` : ""} version=${pf.version}`);
      const p = codex.policy;
      L.push(`serving policy: ${p.discoveryEnabled ? "ON" : "OFF"} `
        + `(optIn=${p.optIn} optOut=${p.optOut} `
        + `claudeCompatible=${p.claudeCompatible})`);
      L.push(interpretCodex(p, pf.compatible));
    }
  }
  return L.join("\n");
}

/** Register the `Kickbacks: Diagnose` command (+ legacy alias). Opens the report
 *  in an untitled editor AND copies it to the clipboard so the user can paste it
 *  straight back. Registered early in activation so it works even when the build
 *  is incompatible — which is exactly when it's needed. */
export function registerDiagnoseCommand(
  cc: TargetAdapter | null, codex: CodexDiagnostics | null,
): vscode.Disposable[] {
  const run = async (): Promise<void> => {
    const report = formatDiagnostics(cc, codex);
    try { await vscode.env.clipboard.writeText(report); } catch { /* best-effort */ }
    try {
      const doc = await vscode.workspace.openTextDocument(
        { content: report, language: "text" });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch { /* best-effort */ }
    try {
      await vscode.window.showInformationMessage?.(
        "Kickbacks diagnostics copied to clipboard.");
    } catch { /* best-effort */ }
  };
  return [
    vscode.commands.registerCommand("kickbacks.diagnose", run),
    vscode.commands.registerCommand("vibe-ads.diagnose", run),
  ];
}
