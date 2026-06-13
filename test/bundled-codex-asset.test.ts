import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexBlockAsset } from "../src/adapters/codex/adapter";

// S3 Wave-1 CRIT precedent: the injected block is a SHIPPED RAW ASSET, not
// bundled into extension.js. esbuild must cpSync it to dist/adapters/codex/,
// and the adapter's resolver must find it there in the bundled layout.
describe("S9 bundled Codex asset", () => {
  it("real esbuild build places dist/adapters/codex/block.asset.js", () => {
    execFileSync("node", ["esbuild.mjs"],
      { cwd: join(__dirname, ".."), stdio: "pipe" });
    const p = join(__dirname, "..", "dist", "adapters", "codex", "block.asset.js");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    // The asset is the bare passthrough IIFE — the VIBE-ADS markers are added
    // by the adapter AROUND the wrapper at injection (markers-outside, so a
    // strip removes the whole statement and never leaves an e=()||e; residue).
    expect(src.trim().startsWith("(function")).toBe(true);
    expect(src).toContain("__vibeAdsCodexBoot");   // bootstrap guard present
    expect(src).toContain("data-vibe-ads");        // overlay element marker
  });

  it("resolveCodexBlockAsset finds the bundled (dist) layout", () => {
    const dist = join(__dirname, "..", "dist");
    expect(resolveCodexBlockAsset(dist))
      .toBe(join(dist, "adapters", "codex", "block.asset.js"));
  });
});
