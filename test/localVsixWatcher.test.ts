// Local-VSIX update path: when ~/.vibe-ads/config.json sets localVsixPath,
// the extension mtime-watches the file and installs it on change via the
// SAME installer the manifest path uses. Hermetic: a temp HOME with a
// config.json containing localVsixPath, a watchFileFn spy that captures the
// listener, then synthetic stat events drive the install pipe.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Under cold-start worker-pool load (npx vitest run after the .vitest cache
// was wiped) the `writeFileSync(config.json) → vi.resetModules() → await
// import("../src/extension")` chain hit a rare Windows-FS visibility race:
// the freshly-written config.json wasn't readable yet when the imported
// module's top-level `const CFG = readConfig()` fired, so CFG.localVsixPath
// was empty, no watchFile was registered, and `listeners.get(vsixPath)`
// returned undefined → TypeError on the listener invocation in test 2.
// This helper read-backs until the file is visible (cheap; capped at ~1 s)
// before we hand control to the import chain. Reproduced 1× across ~5
// runs, never in isolation; the read-back closes the window cleanly.
function ensureReadable(path: string, timeoutMs = 1000): void {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { readFileSync(path); return; }
    catch { /* not yet — try again next loop tick */ }
  }
  // Final attempt that THROWS if still unreadable, so the test fails
  // loudly with a precise message instead of TypeErroring downstream.
  readFileSync(path);
}
// NOTE: this file intentionally does NOT static-import the vscode mock —
// every test calls vi.resetModules() before importing the extension, which
// re-instantiates the aliased mock. Reading assertions through a stale
// static import would target the wrong instance. Each test re-imports
// "./mocks/vscode" inside the resetModules window via `vsc = await import(...)`.

type StatListener = (curr: { mtimeMs: number }) => void;

function stubFetch() {
  const calls: string[] = [];
  const f = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", f);
  return { f, calls };
}

const mkAdapter = () => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
  version: () => "2.1.143",
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("local VSIX watcher", () => {

  it("installs the file and restarts the ext host when its mtime advances"
    + " (the local dev rig path — no manifest server required)", async () => {
    // Stage HOME so readConfig() picks up localVsixPath at module load.
    const home = mkdtempSync(join(tmpdir(), "kb-lvw-"));
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".vibe-ads"), { recursive: true });
    const vsixPath = join(home, "kickbacks.vsix");
    writeFileSync(vsixPath, Buffer.from("FAKE-VSIX-BYTES-v1"));
    const configFile = join(home, ".vibe-ads", "config.json");
    writeFileSync(configFile,
      JSON.stringify({ localVsixPath: vsixPath }), "utf8");
    ensureReadable(configFile);          // close the cold-start FS race

    // Capture the listener handed to watchFile(localVsixPath, …).
    const listeners = new Map<string, StatListener>();
    const watchFileFn = ((p: unknown, _o: unknown, l: StatListener) => {
      listeners.set(String(p), l);
    }) as unknown as typeof import("node:fs").watchFile;

    // Re-import the extension after staging HOME so CFG is read fresh.
    // CRITICAL: vi.resetModules() also re-instantiates the aliased `vscode`
    // mock for the freshly imported extension. The vscode `commands` array
    // captured at this file's static `import` line is now a STALE instance —
    // the new extension writes into a different Map. So we re-import the
    // mock through the same resetModules window and read assertions from
    // *that* instance. (test/setup.ts's vi.mock for ../src/log survives.)
    vi.resetModules();
    const { activate, deactivate, __wireForTest } =
      await import("../src/extension");
    const vsc = await import("./mocks/vscode");

    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar, watchFileFn });
    stubFetch();
    const ctx = vsc.makeContext();
    await ctx.secrets.store("kickbacks.access", "AT");

    try {
      await activate(ctx as never);

      // The listener for the staged vsix path must be installed.
      expect(listeners.has(vsixPath)).toBe(true);
      // Pre-fire baseline: no install attempted yet.
      expect(vsc.commands._executed.some(
        (c) => c.id === "workbench.extensions.installExtension")).toBe(false);

      // Bump the file bytes + invoke the listener with a fresh mtime.
      writeFileSync(vsixPath, Buffer.from("FAKE-VSIX-BYTES-v2"));
      const fire = listeners.get(vsixPath)!;
      fire({ mtimeMs: Date.now() + 5000 });
      // The listener uses void installVsix(...); installVsix itself is async
      // (writes a temp file, awaits the install command, awaits the restart).
      // Yield ticks so its awaits land before we assert.
      await new Promise((r) => setTimeout(r, 50));

      const installCall = vsc.commands._executed.find(
        (c) => c.id === "workbench.extensions.installExtension");
      expect(installCall).toBeDefined();
      const arg = installCall!.args[0] as { toString(): string; fsPath?: string };
      const fsPath = arg.fsPath || arg.toString();
      expect(fsPath).toMatch(/\.vsix$/);

      // After install we no longer auto-restart the ext host — we
      // prompt for a full window reload via showInformationMessage
      // (empirically the ext-host restart wasn't enough to invalidate
      // the cached webview module of the patched CC page; only a
      // window reload reliably picks up the new build). Assert the
      // toast fired, not a silent restart. The mock collects all
      // showInformationMessage calls into `_shown` (see mocks/vscode.ts).
      // The toast is fired via a void IIFE so we wait one more tick
      // for its await chain to land before checking.
      await new Promise((r) => setTimeout(r, 50));
      expect((vsc._shown as { kind: string; text: string }[])
        .some((t) => /Kickbacks updated/i.test(t.text))).toBe(true);
      expect(vsc.commands._executed.some(
        (c) => c.id === "workbench.action.restartExtensionHost")).toBe(false);
    } finally {
      await deactivate();
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUser !== undefined) process.env.USERPROFILE = prevUser;
      else delete process.env.USERPROFILE;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("a stale mtime is ignored (no install storm on activation)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-lvw2-"));
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".vibe-ads"), { recursive: true });
    const vsixPath = join(home, "kickbacks.vsix");
    writeFileSync(vsixPath, Buffer.from("v1"));
    const configFile2 = join(home, ".vibe-ads", "config.json");
    writeFileSync(configFile2,
      JSON.stringify({ localVsixPath: vsixPath }), "utf8");
    ensureReadable(configFile2);

    const listeners = new Map<string, StatListener>();
    const watchFileFn = ((p: unknown, _o: unknown, l: StatListener) => {
      listeners.set(String(p), l);
    }) as unknown as typeof import("node:fs").watchFile;

    vi.resetModules();
    const { activate, deactivate, __wireForTest } =
      await import("../src/extension");
    const vsc = await import("./mocks/vscode");

    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar, watchFileFn });
    stubFetch();
    const ctx = vsc.makeContext();
    try {
      await activate(ctx as never);
      // Surface the cold-start FS race here too: if config.json wasn't
      // visible at module-load, CFG.localVsixPath was empty and watchFile
      // was never registered → listeners.get(vsixPath) returns undefined
      // and invoking it crashes with a confusing TypeError. Assert
      // presence FIRST so the failure message points at the actual cause.
      expect(listeners.has(vsixPath)).toBe(true);
      const fire = listeners.get(vsixPath)!;
      // mtime === 0 → must NOT trigger an install (the !curr.mtimeMs guard).
      fire({ mtimeMs: 0 });
      await new Promise((r) => setTimeout(r, 50));
      expect(vsc.commands._executed.some(
        (c) => c.id === "workbench.extensions.installExtension")).toBe(false);
    } finally {
      await deactivate();
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUser !== undefined) process.env.USERPROFILE = prevUser;
      else delete process.env.USERPROFILE;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
