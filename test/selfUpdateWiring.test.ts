// audit-2026-06-09 #38 regression: setupSelfUpdate must wire UpdateClient
// with the timeout-wrapped fetch (timeoutFetch(120000)), not bare global
// fetch — a black-holed manifest/VSIX connection otherwise hangs checkOnce
// forever (and, with the #31 single-flight guard, silently wedges every
// later 90s poll behind the stuck one). Pin: every request the updater
// makes carries an AbortSignal.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { setupSelfUpdate } from "../src/activation/selfUpdate";
import { makeContext, _shown } from "./mocks/vscode";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("setupSelfUpdate fetch wiring (audit #38)", () => {
  it("manifest polls carry an abort signal (timeoutFetch, not bare fetch)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init);
      // Not-newer version -> checkOnce stops after the manifest fetch.
      return { ok: true, json: async () => ({ version: "0.0.0",
        sha256: "x", url: "http://b/x.vsix" }) } as Response;
    }));
    const timers: NodeJS.Timeout[] = [];
    const watchFileFn =
      (() => {}) as unknown as typeof import("node:fs").watchFile;
    try {
      const { updater } = setupSelfUpdate(
        makeContext() as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await updater.checkOnce()).toBe(false);
      expect(inits).toHaveLength(1);
      // Pre-fix: bare global fetch was called with NO init at all.
      expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });
});

// trey-nag-loop 2026-06-11: a user who dismissed the reload toast got the
// SAME artifact re-downloaded, re-installed and re-toasted every ~31 min
// (attempted-ring cooldown expiry), 20+ times over 10 h. A successful
// install is now recorded in globalState and suppressed without any
// cooldown; the record is cleared at activation only when the running
// build proves the install never converged.
describe("self-update success record (nag-loop relax)", () => {
  const bytes = Buffer.alloc(12 * 1024, 0x42);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const watchFileFn =
    (() => {}) as unknown as typeof import("node:fs").watchFile;

  function stubManifestFetch() {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) =>
      String(url).endsWith("/v1/ext/manifest")
        ? ({ ok: true, json: async () => ({ version: "9.9.9", sha256: sha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response)));
  }

  it("does NOT reinstall or re-toast the same artifact after the 30-min cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    stubManifestFetch();
    const ctx = makeContext();
    const timers: NodeJS.Timeout[] = [];
    try {
      const { updater } = setupSelfUpdate(
        ctx as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await updater.checkOnce()).toBe(true);   // installs once
      const toastsAfterInstall = _shown.length;

      // 31 min later: attempted-ring cooldown has expired. Pre-fix this
      // re-downloaded + re-installed + re-toasted the identical artifact.
      vi.setSystemTime(1_000_000_000 + 31 * 60 * 1000);
      expect(await updater.checkOnce()).toBe(false);
      expect(_shown.length).toBe(toastsAfterInstall); // no new toast
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });

  it("clears a not-converged record at activation so the install retries once per reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000);
    stubManifestFetch();
    const ctx = makeContext();
    const timers: NodeJS.Timeout[] = [];
    try {
      const a = setupSelfUpdate(ctx as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await a.updater.checkOnce()).toBe(true);  // install 9.9.9, record it

      // Window reloads but is STILL running 0.1.0 -> the install never
      // converged. Activation must clear the record (past the attempted
      // cooldown, so the retry isn't fenced by the ring either).
      vi.setSystemTime(2_000_000_000 + 31 * 60 * 1000);
      const b = setupSelfUpdate(ctx as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await b.updater.checkOnce()).toBe(true);  // one fresh attempt
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });
});
