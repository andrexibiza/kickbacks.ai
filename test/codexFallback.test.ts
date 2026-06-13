/** Codex discovery policy ("codex fallback") — the truth table that decides
 *  whether the Codex adapter is constructed at activation.
 *
 *  The contract being locked:
 *    • Explicit opt-out beats everything (support remediation).
 *    • Explicit opt-in beats the claude state (today's S9 smoke path).
 *    • Default on a claude-COMPATIBLE machine is OFF — the population the
 *      S9 "crashed Claude Code once" guard protects keeps today's behavior.
 *    • Default on a claude-incompatible/absent machine is ON — the fallback
 *      that makes a Codex-only install serve instead of being dead weight.
 */
import { describe, it, expect, vi } from "vitest";
import { codexDiscoveryEnabled } from "../src/activation/codexFallback";

describe("codexDiscoveryEnabled truth table", () => {
  it("opt-out beats opt-in AND the fallback", () => {
    expect(codexDiscoveryEnabled(
      { optIn: true, optOut: true, claudeCompatible: true })).toBe(false);
    expect(codexDiscoveryEnabled(
      { optIn: true, optOut: true, claudeCompatible: false })).toBe(false);
    expect(codexDiscoveryEnabled(
      { optIn: false, optOut: true, claudeCompatible: false })).toBe(false);
  });

  it("opt-in wins regardless of the claude state (S9 smoke path unchanged)", () => {
    expect(codexDiscoveryEnabled(
      { optIn: true, optOut: false, claudeCompatible: true })).toBe(true);
    expect(codexDiscoveryEnabled(
      { optIn: true, optOut: false, claudeCompatible: false })).toBe(true);
  });

  it("default on a claude-compatible machine stays OFF (prime-directive guard)", () => {
    expect(codexDiscoveryEnabled(
      { optIn: false, optOut: false, claudeCompatible: true })).toBe(false);
  });

  it("default on a claude-incompatible machine is ON (the codex fallback)", () => {
    expect(codexDiscoveryEnabled(
      { optIn: false, optOut: false, claudeCompatible: false })).toBe(true);
  });
});

describe("log.ts codexDisabled (env legs)", () => {
  // vi.importActual bypasses setup.ts's process-wide log mock — these legs
  // exercise the REAL sentinel/env reader. Only the env legs are asserted
  // (the sentinel leg would depend on the developer's real ~/.vibe-ads).
  it("KICKBACKS_CODEX=0 / VIBE_ADS_CODEX=0 opt out; =1 does not", async () => {
    const { codexDisabled } =
      await vi.importActual<typeof import("../src/log")>("../src/log");
    vi.stubEnv("KICKBACKS_CODEX", "0");
    expect(codexDisabled()).toBe(true);
    vi.stubEnv("KICKBACKS_CODEX", "1");
    vi.stubEnv("VIBE_ADS_CODEX", "0");
    expect(codexDisabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});
