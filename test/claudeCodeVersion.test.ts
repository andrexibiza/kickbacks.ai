import { describe, expect, it } from "vitest";
import { compareClaudeCodeInstall } from "../src/util/claudeCodeVersion";

describe("compareClaudeCodeInstall", () => {
  it("orders Claude Code installs by semver, not lexicographic text", () => {
    const paths = [
      "C:/x/anthropic.claude-code-2.1.99-win32-x64/webview/index.js",
      "C:/x/anthropic.claude-code-2.1.162-win32-x64/webview/index.js",
      "C:/x/anthropic.claude-code-2.1.9-win32-x64/webview/index.js",
    ].sort(compareClaudeCodeInstall);

    expect(paths.map((p) => /claude-code-([0-9.]+)/.exec(p)?.[1]))
      .toEqual(["2.1.9", "2.1.99", "2.1.162"]);
  });

  it("keeps versioned installs after unexpected names", () => {
    const paths = [
      "anthropic.claude-code-preview/webview/index.js",
      "anthropic.claude-code-2.1.162-win32-x64/webview/index.js",
    ].sort(compareClaudeCodeInstall);

    expect(paths[1]).toContain("2.1.162");
  });
});
