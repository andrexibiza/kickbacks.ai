import { describe, it, expect, vi } from "vitest";

// Mute dlog so test-driven activate() calls don't append to the developer's
// real ~/.vibe-ads/debug.log. Same pattern auth.test.ts and commands.test.ts
// use. Without this, every test run leaves "build dev" / "9.9.9" preflight
// noise interleaved with the user's real extension events, which was
// misdiagnosed once as an extension restart loop.
vi.mock("../src/log", () => ({ debugEnabled: () => false, dlog: () => {},
  dlogRaw: () => {}, codexEnabled: () => false, codexDisabled: () => false,
  codexCliEnabled: () => false, testHooksEnabled: () => false,
  debugIconDataUri: () => "",
  LOG_PATH: "/tmp/test-log" }));

// Hermetic ~/.claude/settings.json: activate() wires the claude-cli
// statusline adapter at the developer's REAL settings file — on the normal
// path via cliSync, and (audit #22) on the incompatible early-return path.
// Mock the adapter so test-driven activations never touch that file;
// `cliRestore` records restore() calls for the #22 regression below.
const cliRestore = vi.hoisted(() =>
  vi.fn(() => ({ ok: true, restored: true })));
vi.mock("../src/adapters/claude-cli/adapter", () => ({
  resolveStatuslineAsset: () => "",
  ClaudeCliStatuslineAdapter: class {
    name = "claude-cli-statusline";
    spinnerVerbsSupported = true;
    version() { return "cli"; }
    preflight() { return { ok: true, compatible: true, version: "cli" }; }
    applyPatch() { return { ok: true }; }
    restore = cliRestore;
  },
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, deactivate, __wireForTest } from "../src/extension";
import { makeContext, _warned, commands } from "./mocks/vscode";
import { ImpressionDedupe } from "../src/metrics/dedupe";

/** Redirect HOME/USERPROFILE to a fresh temp dir for one test: hermetic
 *  ~/.vibe-ads/boot.canary (a lingering real-home canary < 90s old reads as
 *  a crash and suspends auto-enable) and a guaranteed-empty extension scan
 *  for the codex strand-restore's locateCodexTarget(). */
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "kb-ext-home-"));
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;   // os.homedir() reads this on Windows
  return () => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUser !== undefined) process.env.USERPROFILE = prevUser;
    else delete process.env.USERPROFILE;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ok */ }
  };
}

it("loopback impression path dedupes per adId (one bill per ad)", () => {
  const d = new ImpressionDedupe();
  const sent: string[] = [];
  const onEvent = (k: string, adId: string) => {
    if (d.shouldSend(k, adId)) sent.push(k + ":" + adId);
  };
  onEvent("impression_rendered", "adX");
  onEvent("impression_rendered", "adX");
  expect(sent).toEqual(["impression_rendered:adX"]);
});

describe("extension orchestration", { timeout: 15_000 }, () => {
  it("incompatible target -> no patch, status incompatible, never throws", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: false, version: "9.9.9", reason: "x" }),
      version: () => "9.9.9",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: false })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, statusBar: sb });
    await expect(activate(makeContext() as never)).resolves.toBeUndefined();
    expect(adapter.applyPatch).not.toHaveBeenCalled();
    expect(sb.set).toHaveBeenCalledWith(expect.objectContaining({ kind: "incompatible" }));
    // A non-structural reason ("x") must NOT pop the incompat warning — that's
    // reserved for a genuine "verb array not found" miss. (Match the message,
    // not a count: unrelated warnings — e.g. the boot canary — share the mock.)
    expect(_warned.some((t) => t.includes("spinner hook"))).toBe(false);
    await deactivate();
  });

  it("audit #22: incompatible/missing Claude Code still cleans the CLI"
    + " settings surface and leaves it restorable at deactivate", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: false, version: "9.9.9", reason: "x" }),
      version: () => "9.9.9",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: false })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, statusBar: sb });
    cliRestore.mockClear();
    await activate(makeContext() as never);
    // Pre-fix the early return ran before ANY claude-cli adapter existed, so
    // a stale statusLine/spinnerVerbs patch from a prior session (crash /
    // CC uninstalled-but-terminal-CLI-kept) was stranded forever. Now it is
    // cleaned once on this path…
    expect(cliRestore,
      "incompatible path must run the key-scoped CLI restore")
      .toHaveBeenCalled();
    // …and actx.cliStatus stays wired, so deactivate()'s (previously
    // null-guarded-away) CLI restore still runs.
    cliRestore.mockClear();
    await deactivate();
    expect(cliRestore,
      "deactivate must still be able to restore the CLI surface")
      .toHaveBeenCalled();
  });

  it("genuine verb-array miss -> warns the user (wiring), status incompatible", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: false, version: "2.1.161",
        reason: "verb array not found (incompatible build)" }),
      version: () => "2.1.161",
      isPatched: () => false,
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: false })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, statusBar: sb });
    await activate(makeContext() as never);
    expect(adapter.applyPatch).not.toHaveBeenCalled();
    expect(_warned.some((t) =>
      t.includes("couldn't find Claude Code 2.1.161's spinner hook")))
      .toBe(true);
    await deactivate();
  });

  it("reload watcher is wired even when debug is OFF", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: false, version: "9.9.9", reason: "x" }),
      version: () => "9.9.9",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: false })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    const watched: string[] = [];
    __wireForTest({ adapter, statusBar: sb,
      watchFileFn: ((p: unknown) => { watched.push(String(p)); }) as never });
    await activate(makeContext() as never);
    expect(watched.some((p) => p.endsWith("reload"))).toBe(true);
    await deactivate();
  });

  it("kill -> restore() called and status killed", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, statusBar: sb, killed: true });
    await activate(makeContext() as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.restore).toHaveBeenCalled();
    expect(sb.set).toHaveBeenCalledWith(expect.objectContaining({ kind: "killed" }));
    await deactivate();
  });

  it("S9: kill restores the Codex target too (alongside CC)", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const codexAdapter = {
      name: "codex",
      preflight: () => ({ ok: true, compatible: true, version: "26.513.21555" }),
      version: () => "26.513.21555",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, codexAdapter, statusBar: sb, killed: true });
    await activate(makeContext() as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(codexAdapter.restore).toHaveBeenCalled();
    await deactivate();
  });

  it("wave-2P-F02: deactivate skips restore when K_ON=true (no pristine flash on reload)", async () => {
    // Regression for the "no ad after window reload" symptom. Pre-fix,
    // deactivate() always restored CC's index.js to pristine. The next
    // ext-host activation re-applied the patch, but CC's webview could read
    // pristine in between and the user saw default spinner verbs until a
    // second reload or a 60s reassert tick. Post-fix: when K_ON=true (user
    // opted in via the debug menu) deactivate leaves the patch in place.
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, statusBar: sb });
    const ctx = makeContext();
    // Seed K_ON=true so debugCtl.on() returns true at deactivate time.
    // Canonical current key is "kickbacks.debug.on"; the "vibe-ads.debug.on"
    // legacy key is read-through-only (see debug.ts on()). Legacy key parity
    // is covered by debug.test.ts.
    await ctx.globalState.update("kickbacks.debug.on", true);
    await activate(ctx as never);
    adapter.restore.mockClear();
    await deactivate();
    expect(adapter.restore, "deactivate must NOT restore when K_ON=true")
      .not.toHaveBeenCalled();
  });

  it("wave-2P-F02: deactivate still restores when K_ON=false (uninstall hygiene)", async () => {
    // The K_ON-gated skip applies when the user is opted in. The
    // earlier auto-enable change means activate() flips K_ON to true
    // by default, so this test forces K_ON=false AFTER activate
    // (simulating a user who explicitly disabled via the menu) to
    // exercise the legacy "never leave a user VISIBLY patched on
    // disable/uninstall" branch — deactivate must restore in that
    // case.
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, statusBar: sb });
    const ctx = makeContext();
    await activate(ctx as never);
    // Simulate the user disabling via the menu BEFORE shutdown.
    await ctx.globalState.update("kickbacks.debug.on", false);
    adapter.restore.mockClear();
    await deactivate();
    expect(adapter.restore, "deactivate must restore when K_ON is false")
      .toHaveBeenCalled();
  });

  it("codex-only: activation proceeds, K_ON persists, codex/<ver> on the wire,"
    + " never labeled incompatible", async () => {
    // The bug a public-mirror PR reported (kickbacks.ai#1): Claude Code
    // absent (preflight "target not found") + a compatible Codex install
    // used to hit the claude-only preflight early-return — red
    // "incompatible" bar, no sign-in command, no serving, K_ON never
    // persisted. Activation must now proceed on the codex leg alone.
    const restoreHome = tempHome();
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: false, version: null,
        reason: "target not found" }),
      version: () => null,
      applyPatch: vi.fn(() => ({ ok: false, reason: "target not found" })),
      restore: vi.fn(() => ({ ok: true, restored: false })),
    };
    const codexAdapter = {
      name: "codex",
      preflight: () => ({ ok: true, compatible: true, version: "26.513.21555" }),
      version: () => "26.513.21555",
      isPatched: vi.fn(() => true),
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    // Benign backend stub: {} reads as no-ad / not-killed / no-consent, and
    // the captured URLs pin the ccVersion wire label below.
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(typeof input === "string" ? input : String(input));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    commands._handlers.clear();
    __wireForTest({ adapter, codexAdapter, statusBar: sb });
    const ctx = makeContext();
    try {
      await expect(activate(ctx as never)).resolves.toBeUndefined();
      // Proceeds: the sign-in surface exists and the bar is never relabeled.
      expect(commands._handlers.has("kickbacks.signIn")).toBe(true);
      expect(sb.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "incompatible" }));
      // bootCanary's widened auto-enable persisted K_ON through the
      // codex-folded DebugController.apply()…
      expect(ctx.globalState.get("kickbacks.debug.on")).toBe(true);
      // …which patched Codex.
      expect(codexAdapter.applyPatch).toHaveBeenCalled();
      // The host-version label travels the wire as codex/<ver> (killswitch
      // poll + demo-portfolio fetch), never as a bare CC-shaped version.
      expect(calls.some((u) => u.includes("codex%2F26.513.21555"))).toBe(true);
    } finally {
      await deactivate();
      vi.unstubAllGlobals();
      restoreHome();
    }
  });

  it("both targets incompatible -> early-return: incompatible label, no"
    + " sign-in, CLI strand restore still runs", async () => {
    const restoreHome = tempHome();
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: false, version: "9.9.9", reason: "x" }),
      version: () => "9.9.9",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: false })),
    };
    const codexAdapter = {
      name: "codex",
      preflight: () => ({ ok: true, compatible: false, version: null,
        reason: "thinking-shimmer anchors not found" }),
      version: () => null,
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: false })),
    };
    const sb = { set: vi.fn(), dispose() {} };
    commands._handlers.clear();
    cliRestore.mockClear();
    __wireForTest({ adapter, codexAdapter, statusBar: sb });
    try {
      await expect(activate(makeContext() as never)).resolves.toBeUndefined();
      expect(sb.set).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "incompatible" }));
      expect(commands._handlers.has("kickbacks.signIn")).toBe(false);
      expect(codexAdapter.applyPatch).not.toHaveBeenCalled();
      // Audit #22's CLI strand restore is preserved on the narrower gate.
      expect(cliRestore).toHaveBeenCalled();
    } finally {
      await deactivate();
      restoreHome();
    }
  });

  it("S9: a throwing Codex adapter never blocks CC or activation", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const boom = () => { throw new Error("codex exploded"); };
    const codexAdapter = {
      name: "codex",
      preflight: boom as never,
      version: boom as never,
      applyPatch: boom as never,
      restore: boom as never,
    };
    const sb = { set: vi.fn(), dispose() {} };
    __wireForTest({ adapter, codexAdapter, statusBar: sb, killed: true });
    await expect(activate(makeContext() as never)).resolves.toBeUndefined();
    expect(adapter.restore).toHaveBeenCalled();          // CC unaffected by Codex throw
    await expect(deactivate()).resolves.toBeUndefined(); // teardown survives too
  });
});
