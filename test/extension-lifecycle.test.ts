// Lifecycle regressions for extension.ts orchestration (audit 2026-06-09).
//
// #35 — the config-file watcher must NOT restart the extension host on file
//        CREATION (ensureConfigFile materializing the template on the first
//        "Edit Vibe-Ads config…" click) nor on a no-op save/touch; only a
//        genuine CONTENT edit may restart.
// #36 — deactivate() must perform the irreversible user-file restores BEFORE
//        stopping the loopbacks, and each stop must be time-bounded so a hung
//        http.Server.close can never exhaust VS Code's deactivation budget
//        and strand CC/Codex/settings.json patched after uninstall.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

// Hermetic home (wave-3 review): activate()'s incompatible-CC path now runs a
// REAL key-scoped CLI restore against ~/.claude/settings.json (audit #22), so
// these activation tests must never see the developer's live install. Also
// shields the boot-canary read from suites that write the real
// ~/.vibe-ads/boot.canary in parallel workers.
const restoreEnv = (k: string, v: string | undefined): void => {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
};
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
let tmpHome = "";
beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "kb-lifecycle-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});
afterAll(() => {
  restoreEnv("HOME", REAL_HOME);
  restoreEnv("USERPROFILE", REAL_USERPROFILE);
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
});

// Mute dlog (same pattern as extension.test.ts) so test-driven activate()
// calls don't append to the developer's real ~/.vibe-ads/debug.log.
vi.mock("../src/log", () => ({ debugEnabled: () => false, dlog: () => {},
  dlogRaw: () => {}, codexEnabled: () => false, codexDisabled: () => false,
  codexCliEnabled: () => false,
  testHooksEnabled: () => false, debugIconDataUri: () => "",
  LOG_PATH: "/tmp/test-log" }));

// Redirect the watched config file to a per-run temp path so the watcher
// tests can create/touch/edit it without touching the real ~/.vibe-ads.
vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  const { join: j } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const p = j(tmpdir(), `kb-lifecycle-${process.pid}`, "config.json");
  return { ...actual, configPath: () => p };
});

// Controllable in-memory Loopback: stop() resolves instantly until a test
// flips `hangStops`, then hangs forever — simulating http.Server.close()
// waiting on an in-flight webview request (the #36 hazard). `order` records
// the cross-component sequencing deactivate() must respect.
const lb = vi.hoisted(() => ({ hangStops: false, order: [] as string[] }));
vi.mock("../src/loopback", () => {
  class Loopback {
    constructor(_handlers: unknown) {}
    start(_opts?: unknown): Promise<{ port: number; token: string }> {
      return Promise.resolve({ port: 43217, token: "deadbeefdeadbeef" });
    }
    stop(): Promise<void> {
      lb.order.push("loopback.stop");
      return lb.hangStops
        ? new Promise<void>(() => { /* hung close — never resolves */ })
        : Promise.resolve();
    }
  }
  return {
    Loopback,
    resolveLoopbackBase: async (port: number, token: string) =>
      `http://127.0.0.1:${port}/vibe-ads/${token}`,
  };
});

import { activate, deactivate, __wireForTest } from "../src/extension";
import { makeContext, commands } from "./mocks/vscode";
import { configPath } from "../src/config";

const RESTART = "workbench.action.restartExtensionHost";
const restartCount = (): number =>
  commands._executed.filter((e) => e.id === RESTART).length;

type WatchCb = (curr: { mtimeMs: number }) => void;

// Incompatible preflight → activate() early-returns right after the watchers
// are armed, keeping these tests off the network/auth/portfolio paths.
const incompatAdapter = () => ({
  name: "claude-code",
  preflight: () => ({ ok: true, compatible: false, version: "9.9.9", reason: "x" }),
  version: () => "9.9.9",
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: false })),
});

describe("config-file watcher (audit #35)", { timeout: 15_000 }, () => {
  it("creation + no-op touch never restart the host; a genuine edit does", async () => {
    const cfgPath = configPath();
    rmSync(cfgPath, { force: true });           // start absent, like a fresh install
    const watchers = new Map<string, WatchCb>();
    __wireForTest({
      adapter: incompatAdapter() as never,
      statusBar: { set: vi.fn(), dispose() {} },
      watchFileFn: ((p: unknown, _o: unknown, cb: WatchCb) => {
        watchers.set(String(p), cb);
      }) as never,
    });
    await activate(makeContext() as never);
    const cb = watchers.get(cfgPath);
    expect(cb, "config watcher must be armed").toBeTruthy();
    const before = restartCount();

    // 1. CREATION (mtime 0 → T): pre-fix this restarted the ENTIRE extension
    //    host within 2s of the user's first "Edit Vibe-Ads config…" click,
    //    before they typed a single character.
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, '{\n  "debugMode": false\n}\n', "utf8");
    cb!({ mtimeMs: 1_000 });
    expect(restartCount(), "creation must not restart").toBe(before);

    // 2. No-op save / touch: mtime changes, content identical.
    cb!({ mtimeMs: 2_000 });
    expect(restartCount(), "no-op touch must not restart").toBe(before);

    // 3. Genuine content edit: the watcher's purpose — apply config edits.
    writeFileSync(cfgPath, '{\n  "debugMode": true\n}\n', "utf8");
    cb!({ mtimeMs: 3_000 });
    expect(restartCount(), "a real edit must restart").toBe(before + 1);

    await deactivate();
    rmSync(cfgPath, { force: true });
  });

  it("pre-existing config: touches don't restart, edits still do", async () => {
    const cfgPath = configPath();
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, '{\n  "updatePollIntervalMs": 90000\n}\n', "utf8");
    const watchers = new Map<string, WatchCb>();
    __wireForTest({
      adapter: incompatAdapter() as never,
      statusBar: { set: vi.fn(), dispose() {} },
      watchFileFn: ((p: unknown, _o: unknown, cb: WatchCb) => {
        watchers.set(String(p), cb);
      }) as never,
    });
    await activate(makeContext() as never);
    const cb = watchers.get(cfgPath)!;
    const before = restartCount();
    cb({ mtimeMs: 1_000 });                     // touch — same content
    expect(restartCount(), "touch must not restart").toBe(before);
    writeFileSync(cfgPath, '{\n  "updatePollIntervalMs": 60000\n}\n', "utf8");
    cb({ mtimeMs: 2_000 });                     // real edit
    expect(restartCount(), "edit must restart").toBe(before + 1);
    await deactivate();
    rmSync(cfgPath, { force: true });
  });
});

describe("deactivate ordering + stop budget (audit #36)", { timeout: 20_000 }, () => {
  it("restores user files BEFORE loopback stops and completes even when a close hangs", async () => {
    const adapter = {
      name: "claude-code",
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      isPatched: () => true,
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => {
        lb.order.push("cc.restore");
        return { ok: true, restored: true };
      }),
    };
    __wireForTest({ adapter: adapter as never,
      statusBar: { set: vi.fn(), dispose() {} }, killed: true });
    const ctx = makeContext();
    // Guarantee the clean-boot canary branch so the debug auto-enable path
    // mints a (mocked) loopback — dispose() at deactivate then has a server
    // to stop. A recent canary from a parallel test worker would skip it.
    // NOTE bootCanary captures its canary path at MODULE LOAD (before this
    // suite's temp-home swap), so the canary the earlier activations wrote
    // lives under the REAL home — clear both locations.
    const realHome = REAL_USERPROFILE || REAL_HOME || homedir();
    rmSync(join(realHome, ".vibe-ads", "boot.canary"), { force: true });
    rmSync(join(homedir(), ".vibe-ads", "boot.canary"), { force: true });
    await activate(ctx as never);
    // Simulate the user disabling via the menu BEFORE shutdown so the
    // uninstall-hygiene restore branch runs (same as extension.test.ts).
    await ctx.globalState.update("kickbacks.debug.on", false);
    adapter.restore.mockClear();
    lb.order.length = 0;
    lb.hangStops = true;          // every server close now hangs forever
    const t0 = Date.now();
    // Pre-fix: deactivate awaited the hung stop FIRST and never resolved —
    // no restore ever ran (this test then fails by timeout).
    await deactivate();
    const elapsed = Date.now() - t0;
    lb.hangStops = false;
    expect(adapter.restore, "CC must be restored despite the hung close")
      .toHaveBeenCalledWith({ keepCsp: true });
    const restoreIdx = lb.order.indexOf("cc.restore");
    const stopIdx = lb.order.indexOf("loopback.stop");
    expect(restoreIdx, "CC restore must run").toBeGreaterThanOrEqual(0);
    expect(stopIdx, "loopback stop must still be attempted")
      .toBeGreaterThanOrEqual(0);
    expect(restoreIdx, "files restored BEFORE loopback stop")
      .toBeLessThan(stopIdx);
    expect(elapsed, "deactivate bounded by the stop budget").toBeLessThan(8_000);
  });
});
