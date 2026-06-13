import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This file tests the REAL log module. The global setupFile mocks it
// process-wide (to keep every other test from polluting the dev machine's
// ~/.vibe-ads/debug.log); we opt out here so the assertions exercise the
// actual dlog/debugEnabled/codexEnabled implementations.
vi.unmock("../src/log");

// DIR/LOG/SENTINEL in log.ts are module-load-time constants computed from
// homedir(). We must reset modules AND set HOME/USERPROFILE BEFORE each
// dynamic import so the constants are captured against the temp dir.

const REAL_HOME = process.env.HOME;
const REAL_UP = process.env.USERPROFILE;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibe-log-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.VIBE_ADS_DEBUG;
  vi.resetModules();
});

afterEach(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
  else delete process.env.HOME;
  if (REAL_UP !== undefined) process.env.USERPROFILE = REAL_UP;
  else delete process.env.USERPROFILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("log.ts", () => {
  it("off by default: no file, no throw", async () => {
    const { dlog } = await import("../src/log");
    dlog("ext", "evt", { a: 1 });
    expect(existsSync(join(dir, ".vibe-ads", "debug.log"))).toBe(false);
  });

  it("sentinel on: writes a line carrying level + corr", async () => {
    const vd = join(dir, ".vibe-ads");
    mkdirSync(vd, { recursive: true });
    writeFileSync(join(vd, "debug.enabled"), "");
    const { dlog } = await import("../src/log");
    dlog("ext", "evt", { a: 1 }, { level: "debug", corr: "ad7.zz" });
    const txt = readFileSync(join(vd, "debug.log"), "utf8");
    expect(txt).toContain(" debug ");
    expect(txt).toContain("ad7.zz");
    expect(txt).toContain("evt");
  });

  it("default level is info when opts omitted", async () => {
    const vd = join(dir, ".vibe-ads");
    mkdirSync(vd, { recursive: true });
    writeFileSync(join(vd, "debug.enabled"), "");
    const { dlog } = await import("../src/log");
    dlog("ext", "evt2");
    expect(readFileSync(join(vd, "debug.log"), "utf8")).toContain(" info ");
  });

  it("codexEnabled: OFF by default (prime-directive kill-switch)", async () => {
    delete process.env.VIBE_ADS_CODEX;
    const { codexEnabled } = await import("../src/log");
    expect(codexEnabled()).toBe(false);
  });

  it("codexEnabled: env opt-in VIBE_ADS_CODEX=1", async () => {
    process.env.VIBE_ADS_CODEX = "1";
    const { codexEnabled } = await import("../src/log");
    expect(codexEnabled()).toBe(true);
    delete process.env.VIBE_ADS_CODEX;
  });

  it("codexEnabled: ~/.vibe-ads/codex.enabled sentinel opt-in", async () => {
    const vd = join(dir, ".vibe-ads");
    mkdirSync(vd, { recursive: true });
    writeFileSync(join(vd, "codex.enabled"), "");
    const { codexEnabled } = await import("../src/log");
    expect(codexEnabled()).toBe(true);
  });

  it("rolling trim: caps log at MAX_LOG_LINES (oldest dropped)", async () => {
    const vd = join(dir, ".vibe-ads");
    mkdirSync(vd, { recursive: true });
    writeFileSync(join(vd, "debug.enabled"), "");
    const log = join(vd, "debug.log");
    // Seed > MAX_LOG_LINES with marker lines (each big enough that the
    // total file exceeds TRIM_MIN_BYTES = 64KB). 1500 × 100B = 150KB.
    const filler = "x".repeat(80);
    const seed = Array.from({ length: 1500 },
      (_, i) => `2026-05-21T00:00:00.000Z [ext] info - seed-${i} ${filler}`)
      .join("\n") + "\n";
    writeFileSync(log, seed);
    const { dlog, _forceTrimLogForTest, MAX_LOG_LINES } = await import("../src/log");
    // One real append, then a manual trim trigger so the throttle doesn't
    // hide the assertion. Production hits the trim every ~50 writes.
    dlog("ext", "tail-marker", { ok: 1 });
    _forceTrimLogForTest();
    const out = readFileSync(log, "utf8");
    const lineCount = out.split("\n").length - 1; // strip trailing-empty
    expect(lineCount).toBeLessThanOrEqual(MAX_LOG_LINES);
    // Oldest seed lines are gone; the freshest are still there.
    expect(out).not.toContain("seed-0 ");
    expect(out).not.toContain("seed-499 ");
    expect(out).toContain("seed-1499 ");
    expect(out).toContain("tail-marker");
  });

  it("lifecycle event writes even with the firehose OFF (debug disabled)", async () => {
    // No sentinel, no env: the verbose firehose is off, but lifecycle
    // events (auth / self-update / activation health) must still land so an
    // incident is diagnosable from a stock install.
    const { dlog } = await import("../src/log");
    dlog("ext", "session.state", { signedIn: false });
    dlog("ext", "selfupdate.installed", { path: "x" });
    dlog("ext", "auth.refresh", { ok: false }); // future auth.* family
    const log = join(dir, ".vibe-ads", "debug.log");
    expect(existsSync(log)).toBe(true);
    const txt = readFileSync(log, "utf8");
    expect(txt).toContain("session.state");
    expect(txt).toContain("selfupdate.installed");
    expect(txt).toContain("auth.refresh");
  });

  it("firehose event stays gated when debug is OFF", async () => {
    const { dlog } = await import("../src/log");
    dlog("ext", "metric.send", { event: "view_tick" });
    dlog("ext", "loopback.event", { route: "impression_rendered" });
    expect(existsSync(join(dir, ".vibe-ads", "debug.log"))).toBe(false);
  });

  it("isLifecycleEvent: allowlist + family prefixes true; firehose false", async () => {
    const { isLifecycleEvent } = await import("../src/log");
    // Allowlist singletons + the real emitter names (guards against an
    // event being renamed out from under the always-on tier).
    for (const e of ["activate", "activate.fatal", "preflight",
                     "session.state", "cli.spinnerVerbs",
                     "selfupdate.installed", "selfupdate.failed",
                     "boot.cycle.error", "auth.refresh"]) {
      expect(isLifecycleEvent(e)).toBe(true);
    }
    // Firehose / render plumbing must NOT be always-on.
    for (const e of ["metric.send", "loopback.event", "portfolio.rotated",
                     "csp.patch", "evt"]) {
      expect(isLifecycleEvent(e)).toBe(false);
    }
  });

  it("rolling trim: small file is left alone (no read, no rewrite)", async () => {
    const vd = join(dir, ".vibe-ads");
    mkdirSync(vd, { recursive: true });
    writeFileSync(join(vd, "debug.enabled"), "");
    const log = join(vd, "debug.log");
    // 5 lines = far below TRIM_MIN_BYTES; trim must be a no-op even when
    // the throttle is bypassed (size gate skips the read).
    const seed = ["a", "b", "c", "d", "e"].map(
      (s, i) => `2026-05-21T00:00:00.000Z [ext] info - seed-${i} ${s}`).join("\n") + "\n";
    writeFileSync(log, seed);
    const before = readFileSync(log, "utf8");
    const { _forceTrimLogForTest } = await import("../src/log");
    _forceTrimLogForTest();
    expect(readFileSync(log, "utf8")).toBe(before);
  });

});
