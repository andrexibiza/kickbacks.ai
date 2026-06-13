import { describe, it, expect } from "vitest";
import { interpret, interpretCodex, formatDiagnostics } from "../src/activation/diagnose";
import type { CodexDiagnostics } from "../src/activation/diagnose";
import type { AdapterDiagnostics, TargetAdapter } from "../src/adapters/types";

function diag(over: Partial<AdapterDiagnostics> = {}): AdapterDiagnostics {
  return {
    name: "claude-code", target: "/x/anthropic.claude-code-2.1.161/webview/index.js",
    targetExists: true, version: "2.1.161", compatible: false, isPatched: false,
    backup: { exists: false, path: null, hasArray: false, hasBlock: false },
    live: { hasArray: false, bareVerbPresent: false },
    ...over,
  };
}

describe("interpret (diagnose verdict)", () => {
  it("compatible + live block → OK/live", () => {
    expect(interpret(diag({ compatible: true, isPatched: true }))).toMatch(/OK.*live/i);
  });

  it("target missing → Claude Code not found", () => {
    expect(interpret(diag({ targetExists: false }))).toMatch(/not found/i);
  });

  it("verb word present but not in an array → bundle format change → fix regex", () => {
    const v = interpret(diag({ live: { hasArray: false, bareVerbPresent: true } }));
    expect(v).toMatch(/bundle format/i);
    expect(v).toMatch(/regex|anchor/i);
  });

  it("no verb word + no backup array → stripped/corrupted → reinstall Claude Code", () => {
    const v = interpret(diag({ live: { hasArray: false, bareVerbPresent: false } }));
    expect(v).toMatch(/reinstall.*claude code/i);
  });

  it("stale backup but live OK → self-heal → update Kickbacks", () => {
    const v = interpret(diag({
      backup: { exists: true, path: "/x.bak", hasArray: false, hasBlock: false },
      live: { hasArray: true, bareVerbPresent: true },
    }));
    expect(v).toMatch(/self-heal|update Kickbacks/i);
  });
});

describe("formatDiagnostics", () => {
  it("renders the CC section, preflight, and a verdict", () => {
    const cc = {
      name: "claude-code",
      diagnose: () => diag({ compatible: false, reason: "verb array not found (incompatible build)",
        live: { hasArray: false, bareVerbPresent: false } }),
    } as unknown as TargetAdapter;
    const report = formatDiagnostics(cc, null);
    expect(report).toContain("Kickbacks Diagnostics");
    expect(report).toContain("PREFLIGHT compatible: false");
    expect(report).toContain("preflight reason: verb array not found");
    expect(report).toMatch(/VERDICT:/);
    expect(report).toMatch(/reinstall.*claude code/i);
  });

  it("degrades gracefully when the adapter has no diagnose()", () => {
    const cc = { name: "claude-code" } as unknown as TargetAdapter;
    expect(formatDiagnostics(cc, null)).toContain("no diagnose() available");
  });
});

// BUG-001: dual-install reports used to be silent about Codex (the adapter is
// null whenever the serving policy keeps discovery off). The section now
// always renders and explains the opt-in policy in plain English.
describe("formatDiagnostics — Codex section", () => {
  const cc = { name: "claude-code" } as unknown as TargetAdapter;
  const codexAdapter = {
    name: "codex",
    preflight: () => ({ compatible: true, version: "0.5.1" }),
  } as unknown as TargetAdapter;
  const policy = (over: Partial<CodexDiagnostics["policy"]> = {}) => ({
    discoveryEnabled: false, optIn: false, optOut: false,
    claudeCompatible: true, ...over,
  });

  it("reports a missing Codex install", () => {
    const r = formatDiagnostics(cc, { adapter: null, policy: policy() });
    expect(r).toContain("--- Codex ---");
    expect(r).toMatch(/not found on this machine/i);
  });

  it("dual-install default: installed but serving OFF → opt-in explanation", () => {
    const r = formatDiagnostics(cc, { adapter: codexAdapter, policy: policy() });
    expect(r).toContain("serving policy: OFF");
    expect(r).toMatch(/opt-in/i);
    expect(r).toMatch(/KICKBACKS_CODEX=1|codex\.enabled/);
    expect(r).toMatch(/expected, not a bug/i);
  });

  it("explicit opt-out wins the verdict", () => {
    const v = interpretCodex(policy({ optOut: true, discoveryEnabled: false }), true);
    expect(v).toMatch(/explicitly disabled/i);
  });

  it("serving ON + compatible → OK", () => {
    const r = formatDiagnostics(cc, {
      adapter: codexAdapter,
      policy: policy({ discoveryEnabled: true, optIn: true }),
    });
    expect(r).toContain("serving policy: ON");
    expect(r).toMatch(/VERDICT: OK — Codex is a live ad target/);
  });

  it("serving ON + incompatible → send report", () => {
    const v = interpretCodex(
      policy({ discoveryEnabled: true, claudeCompatible: false }), false);
    expect(v).toMatch(/incompatible.*send this report/i);
  });

  it("a throwing preflight degrades to incompatible instead of crashing", () => {
    const bad = {
      name: "codex",
      preflight: () => { throw new Error("boom"); },
    } as unknown as TargetAdapter;
    const r = formatDiagnostics(cc, {
      adapter: bad, policy: policy({ discoveryEnabled: true, optIn: true }),
    });
    expect(r).toContain("reason=preflight threw");
  });
});
