import { describe, it, expect, beforeEach, vi } from "vitest";

// Mute dlog so the helper doesn't append to the developer's real
// ~/.vibe-ads/debug.log during tests (same reason extension.test.ts mocks it).
vi.mock("../src/log", () => ({ dlog: () => {} }));

import { notifyIncompatible } from "../src/activation/incompatNotice";
import { makeContext, _warned } from "./mocks/vscode";

const adapter = (patched: boolean) => ({ isPatched: () => patched }) as never;
const pf = (reason: string | undefined, version = "2.1.161") =>
  ({ ok: true, compatible: false, version, reason }) as never;
const GENUINE = "verb array not found (incompatible build)";

describe("notifyIncompatible", () => {
  beforeEach(() => { _warned.length = 0; });

  it("warns exactly once per version on a genuine verb-array miss", () => {
    const ctx = makeContext() as never;
    notifyIncompatible(ctx, adapter(false), pf(GENUINE));
    notifyIncompatible(ctx, adapter(false), pf(GENUINE)); // reload — deduped
    expect(_warned.length).toBe(1);
    expect(_warned[0]).toMatch(/2\.1\.161/);
    expect(_warned[0]).toContain("spinner hook");
    expect(_warned[0]).not.toContain("doesn't support");
  });

  it("does NOT warn when the live file is already patched (transient flash)", () => {
    notifyIncompatible(makeContext() as never, adapter(true), pf(GENUINE));
    expect(_warned.length).toBe(0);
  });

  it("does NOT warn for 'target not found' (Claude Code absent)", () => {
    notifyIncompatible(makeContext() as never, adapter(false), pf("target not found"));
    expect(_warned.length).toBe(0);
  });

  it("does NOT warn when preflight gave no reason (e.g. thrown-error path)", () => {
    notifyIncompatible(makeContext() as never, adapter(false), pf(undefined));
    expect(_warned.length).toBe(0);
  });

  it("still warns when the adapter omits the optional isPatched()", () => {
    // isPatched is optional on TargetAdapter; an adapter without it must not
    // suppress a genuine-miss warning.
    notifyIncompatible(makeContext() as never, ({} as never), pf(GENUINE));
    expect(_warned.length).toBe(1);
  });

  it("re-warns once for a different (newly broken) version", () => {
    const ctx = makeContext() as never;
    notifyIncompatible(ctx, adapter(false), pf(GENUINE, "2.1.161"));
    notifyIncompatible(ctx, adapter(false), pf(GENUINE, "2.1.180"));
    expect(_warned.length).toBe(2);
  });
});
