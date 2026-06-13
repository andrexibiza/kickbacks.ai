/** Integration pin for the 2026-06-11 launch-day zero-earnings fix.
 *
 * The unit layers are each tested elsewhere (locateLog.test.ts pins the
 * untagged fallback, cliTick.test.ts pins the dwell loop against a mocked
 * tail) — but the incident lived in the SEAM: locateClaudeCliLog refused
 * untagged transcripts, so the real LogTail fed cliTick `null` forever and
 * a TUI user on an untagged CC build saw ads all day with zero view_ticks.
 * The Docker e2e matrix can't cover this either: its CC builds tag their
 * transcripts, so it only ever exercises the entrypoint:"cli" path.
 *
 * This test wires the REAL chain — locateClaudeCliLog → LogTail →
 * setupCliTick — over a temp HOME holding an UNTAGGED active transcript and
 * asserts billable ticks flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => h.home };
});

import { locateClaudeCliLog } from "../src/locate";
import { LogTail } from "../src/activity/logTail";
import { setupCliTick } from "../src/activation/cliTick";

function writeTranscript(lines: object[], name = "s.jsonl"): string {
  const d = join(h.home, ".claude", "projects", "p1");
  mkdirSync(d, { recursive: true });
  const f = join(d, name);
  writeFileSync(f, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return f;
}

// An UNTAGGED mid-turn transcript: no `entrypoint` anywhere, newest assistant
// line still tool-running (stop_reason "tool_use" ⇒ done=false).
const UNTAGGED_ACTIVE_TURN = [
  { type: "user", message: { role: "user", content: "do the thing" } },
  { type: "assistant", message: { role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "Edit" }] } },
];

function makeDeps(metrics: { send: ReturnType<typeof vi.fn> }) {
  return {
    cliTail: new LogTail(locateClaudeCliLog),
    metrics: metrics as never,
    adRef: { current: { adId: "ad1", campaignId: "c1",
      adText: "Try Acme Widgets", iconRef: "", iconUrl: "",
      clickUrl: "https://acme.com", bannerEnabled: false,
      sessionToken: "tok1" } },
    killedRef: { current: false },
    signedIn: () => true,
    surfaceApplied: () => true,
    ccVersion: "2.1.143",
    timers: [] as NodeJS.Timeout[],
    cliModeFn: () => "on" as const,
    canPatchFn: () => true,
  };
}

describe("untagged-transcript billing integration (launch-day cohort fix)", () => {
  beforeEach(() => {
    h.home = mkdtempSync(join(tmpdir(), "vibe-ads-untagged-"));
    delete process.env.KICKBACKS_CLI_LOG;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("an active UNTAGGED transcript drives statusline view_ticks end to end", () => {
    writeTranscript(UNTAGGED_ACTIVE_TURN);
    const metrics = { send: vi.fn() };
    const d = makeDeps(metrics);
    setupCliTick(d as never);
    vi.advanceTimersByTime(11_000);
    d.timers.forEach((t) => clearInterval(t));
    const ticks = metrics.send.mock.calls.filter((c) => c[0] === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0][1]).toMatchObject({
      adId: "ad1", surface: "statusline", sessionToken: "tok1" });
  });

  it("an active SDK-tagged transcript does NOT bill (no statusline rendered)", () => {
    writeTranscript([{ ...UNTAGGED_ACTIVE_TURN[0], entrypoint: "sdk-ts" },
                     UNTAGGED_ACTIVE_TURN[1]]);
    const metrics = { send: vi.fn() };
    const d = makeDeps(metrics);
    setupCliTick(d as never);
    vi.advanceTimersByTime(11_000);
    d.timers.forEach((t) => clearInterval(t));
    expect(metrics.send).not.toHaveBeenCalled();
  });

  it("a cli-tagged transcript still bills (no regression on the tagged path)", () => {
    writeTranscript([{ ...UNTAGGED_ACTIVE_TURN[0], entrypoint: "cli" },
                     UNTAGGED_ACTIVE_TURN[1]]);
    const metrics = { send: vi.fn() };
    const d = makeDeps(metrics);
    setupCliTick(d as never);
    vi.advanceTimersByTime(11_000);
    d.timers.forEach((t) => clearInterval(t));
    const ticks = metrics.send.mock.calls.filter((c) => c[0] === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });
});
