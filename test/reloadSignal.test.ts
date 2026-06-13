import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { reloadSentinelPath, parseSentinel, decideReload } from "../src/reloadSignal";

describe("reloadSignal", () => {
  it("sentinel path is ~/.vibe-ads/reload", () => {
    expect(reloadSentinelPath()).toBe(join(homedir(), ".vibe-ads", "reload"));
  });

  it("parses a valid payload", () => {
    expect(parseSentinel('{"version":"0.3.7","ts":"2026-05-17T00:00:00Z"}'))
      .toEqual({ version: "0.3.7", ts: "2026-05-17T00:00:00Z" });
  });

  it("returns null for corrupt / half-written / missing-version input", () => {
    expect(parseSentinel("{not json")).toBeNull();
    expect(parseSentinel("")).toBeNull();
    expect(parseSentinel('{"ts":"x"}')).toBeNull();
  });

  it("decideReload: newer mtime + differing version + debug -> reload-now", () => {
    expect(decideReload({ mtimeMs: 200, armedAt: 100, sentinelVersion: "0.3.7",
      runningVersion: "0.3.6", debug: true })).toBe("reload-now");
  });

  it("decideReload: newer mtime + differing version + non-debug -> nudge", () => {
    expect(decideReload({ mtimeMs: 200, armedAt: 100, sentinelVersion: "0.3.7",
      runningVersion: "0.3.6", debug: false })).toBe("nudge");
  });

  it("decideReload: stale mtime -> none", () => {
    expect(decideReload({ mtimeMs: 50, armedAt: 100, sentinelVersion: "0.3.7",
      runningVersion: "0.3.6", debug: false })).toBe("none");
  });

  it("decideReload: same version -> none (no-op deploy / re-activation)", () => {
    expect(decideReload({ mtimeMs: 200, armedAt: 100, sentinelVersion: "0.3.6",
      runningVersion: "0.3.6", debug: true })).toBe("none");
  });
});
