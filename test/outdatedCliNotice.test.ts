import { describe, it, expect, beforeEach, vi } from "vitest";

// Mute dlog so the helper doesn't append to the developer's real
// ~/.vibe-ads/debug.log during tests (same reason incompatNotice.test.ts mocks it).
vi.mock("../src/log", () => ({ dlog: () => {} }));

import { notifyOutdatedCli } from "../src/activation/outdatedCliNotice";
import { SPINNER_VERBS_FLOOR, type SemVer } from "../src/adapters/claude-cli/cliVersion";
import { makeContext, _warned } from "./mocks/vscode";

const OLD: SemVer = [2, 0, 14];

describe("notifyOutdatedCli", () => {
  beforeEach(() => { _warned.length = 0; });

  it("warns exactly once per detected version (reload never re-nags)", () => {
    const ctx = makeContext() as never;
    notifyOutdatedCli(ctx, OLD);
    notifyOutdatedCli(ctx, OLD); // reload — deduped via globalState
    expect(_warned.length).toBe(1);
  });

  it("names the detected version, the floor, and the fix", () => {
    notifyOutdatedCli(makeContext() as never, OLD);
    const floor = SPINNER_VERBS_FLOOR.join(".");
    expect(_warned[0]).toContain("2.0.14");
    expect(_warned[0]).toContain(floor);
    expect(_warned[0]).toContain("claude update");
  });

  it("re-warns once for a DIFFERENT old version", () => {
    const ctx = makeContext() as never;
    notifyOutdatedCli(ctx, OLD);
    notifyOutdatedCli(ctx, [2, 1, 100]);
    expect(_warned.length).toBe(2);
    expect(_warned[1]).toContain("2.1.100");
  });

  it("dedupe is per-context-state, keyed by version (fresh install re-notifies)", () => {
    notifyOutdatedCli(makeContext() as never, OLD);
    notifyOutdatedCli(makeContext() as never, OLD); // new globalState
    expect(_warned.length).toBe(2);
  });

  it("never throws when globalState is broken (best-effort contract)", () => {
    const ctx = {
      globalState: {
        get: () => { throw new Error("storage dead"); },
        update: () => { throw new Error("storage dead"); },
      },
    } as never;
    expect(() => notifyOutdatedCli(ctx, OLD)).not.toThrow();
    expect(_warned.length).toBe(0); // threw before the toast — but silently
  });
});
