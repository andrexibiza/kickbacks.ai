import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for the public-mirror bug report (kickbacks.ai PR #3 / issue #2):
// Claude Code installed under local VS Code Insiders (~/.vscode-insiders)
// was invisible to target discovery — activation logged target:false and
// early-returned before wiring sign-in. Both scanners (locate.ts and
// adapters/registry.ts) must include the .vscode-insiders root.
//
// homedir() is mocked at a per-test temp root (same pattern as
// locateLog.test.ts). registry.ts computes ROOTS at module load, so both
// modules are imported dynamically after the fake home exists.
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => h.home };
});

function freshHome(): string {
  h.home = mkdtempSync(join(tmpdir(), "vibe-ads-insiders-"));
  return h.home;
}
function installClaudeCode(root: string, ver = "2.1.170"): string {
  const webview = join(h.home, root, "extensions",
    `anthropic.claude-code-${ver}`, "webview");
  mkdirSync(webview, { recursive: true });
  const idx = join(webview, "index.js");
  writeFileSync(idx, "// fixture", "utf8");
  return idx;
}
function installCodex(root: string, ver = "0.5.10"): string {
  const assets = join(h.home, root, "extensions",
    `openai.chatgpt-${ver}`, "webview", "assets");
  mkdirSync(assets, { recursive: true });
  const chunk = join(assets, "thinking-shimmer-abc123.js");
  writeFileSync(chunk, "// fixture", "utf8");
  return chunk;
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.KICKBACKS_CC_TARGET;
  delete process.env.VIBE_ADS_CC_TARGET;
  delete process.env.KICKBACKS_CODEX_TARGET;
  delete process.env.VIBE_ADS_CODEX_TARGET;
  freshHome();
});

describe("VS Code Insiders target discovery", () => {
  it("locateClaudeCode finds an install under ~/.vscode-insiders", async () => {
    const idx = installClaudeCode(".vscode-insiders");
    const { locateClaudeCode } = await import("../src/locate");
    expect(locateClaudeCode()).toBe(idx);
  });

  it("registry discovers claude-code and codex under ~/.vscode-insiders",
      async () => {
    installClaudeCode(".vscode-insiders");
    installCodex(".vscode-insiders");
    const { discover } = await import("../src/adapters/registry");
    const ids = discover().map((e) => e.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
  });

  it("stable ~/.vscode still wins when both hosts have an install", async () => {
    const stable = installClaudeCode(".vscode");
    installClaudeCode(".vscode-insiders");
    const { locateClaudeCode } = await import("../src/locate");
    expect(locateClaudeCode()).toBe(stable);
  });
});
