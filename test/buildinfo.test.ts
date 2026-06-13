import { describe, it, expect } from "vitest";
import { humanAge, buildLabel, BUILD_TS } from "../src/buildinfo";

const T0 = Date.parse("2026-05-17T00:00:00Z");

describe("buildinfo.humanAge — truthful compact relative age", () => {
  it("seconds under 90s", () => {
    expect(humanAge("2026-05-17T00:00:00Z", T0 + 5_000)).toBe("5s ago");
    expect(humanAge("2026-05-17T00:00:00Z", T0 + 89_000)).toBe("89s ago");
  });
  it("minutes 90s..90m", () => {
    expect(humanAge("2026-05-17T00:00:00Z", T0 + 90_000)).toBe("1m ago");
    expect(humanAge("2026-05-17T00:00:00Z", T0 + 89 * 60_000)).toBe("89m ago");
  });
  it("hours 90m..48h (the headline 'how many hours ago')", () => {
    expect(humanAge("2026-05-17T00:00:00Z", T0 + 3 * 3_600_000)).toBe("3h ago");
    expect(humanAge("2026-05-17T00:00:00Z", T0 + 47 * 3_600_000)).toBe("47h ago");
  });
  it("days past 48h", () => {
    expect(humanAge("2026-05-17T00:00:00Z", T0 + 50 * 3_600_000)).toBe("2d ago");
  });
  it("clamps a future stamp to 0s (clock skew never shows negatives)", () => {
    expect(humanAge("2026-05-17T01:00:00Z", T0)).toBe("0s ago");
  });
  it("empty / garbage => 'unknown' (never a fabricated number)", () => {
    expect(humanAge("", T0)).toBe("unknown");
    expect(humanAge("not-a-date", T0)).toBe("unknown");
  });
});

describe("buildinfo.buildLabel", () => {
  it("unbundled (no esbuild define) reports 'build dev', not a stale time", () => {
    expect(BUILD_TS).toBe("");          // vitest never applies the define
    expect(buildLabel(T0)).toBe("build dev");
  });
});
