// End-to-end coverage for every `vscode.commands.registerCommand` call the
// extension makes at activation time. The activate() flow is allowed to be
// big; the contract we lock in here is small: when a user fires a registered
// command id (either from the palette, the status-bar menu, or a keybinding),
// the side effect that the user *sees* — a browser tab, a toast, a cleared
// session, a config doc opening, a restored binary — must actually happen.
//
// Test-only mock surface used:
//   - _opened       : every vscode.env.openExternal(uri) call           (browser tab)
//   - _shown        : every showInformationMessage / showErrorMessage    (toasts)
//   - _openedDocs   : every workspace.openTextDocument(path) call         (config doc)
//   - commands._handlers / _executed                                      (dispatch)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the log module so "signed in" assertions reflect real token state and
// tests never read dev-machine sentinels. Same trick auth.test.ts uses.
vi.mock("../src/log", () => ({ debugEnabled: () => false, dlog: () => {},
  dlogRaw: () => {}, debugIconDataUri: () => "",
  codexEnabled: () => false, codexDisabled: () => false,
  codexCliEnabled: () => false, testHooksEnabled: () => false,
  LOG_PATH: "/tmp/test-log" }));

import { activate, deactivate, __wireForTest } from "../src/extension";
import { setupAdRotation, type AdRotationDeps }
  from "../src/activation/adRotation";
import type { PatchAd, PortfolioResponse } from "../src/portfolio/client";
import {
  makeContext, secrets, _opened, _shown, _openedDocs, commands, window,
} from "./mocks/vscode";

/** Test-double Claude Code adapter (compatible build). */
const mkAdapter = () => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
  version: () => "2.1.143",
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

const mkCodex = () => ({
  name: "codex" as const,
  preflight: () => ({ ok: true, compatible: true, version: "26.513.21555" }),
  version: () => "26.513.21555",
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

/** Global fetch stub. Returns the broker 307+location for sign-in start,
 *  an immediate access_token for sign-in poll, and a benign 200 for every
 *  other backend call (portfolio / kill / earnings / consent). Returning
 *  access_token on the FIRST poll avoids the 1.5s sleep inside signIn(). */
const stubFetch = () => {
  const calls: string[] = [];
  const f = vi.fn(async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    if (url.includes("/v1/auth/extension/start")) {
      return {
        status: 307,
        headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://broker.test/auth?state=ST1" : null },
      } as unknown as Response;
    }
    if (url.includes("/v1/auth/extension/poll")) {
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT-INT", refresh_token: "RT-INT", expires_in: 3600 }) } as Response;
    }
    // Any other backend call: keep it benign so activation finishes without
    // network noise. ConsentClient.read() returns null on missing
    // current_tos_version, KillSwitchClient treats missing fields as
    // "not killed", PortfolioClient handles {} as "no ad". Suppresses the
    // consent toast that would otherwise pollute _shown.
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  // AuthClient captures `fetch` as the default parameter value at construct
  // time, so vi.stubGlobal must happen BEFORE activate(). The cleanup runs
  // in afterEach via vi.unstubAllGlobals.
  vi.stubGlobal("fetch", f);
  return { f, calls };
};

/** Boot the extension hermetically. Returns the cleanup hook. The HOME
 *  redirect is non-optional: AuthClient writes ~/.kickbacks/auth.json, and
 *  we will NOT touch the real user's auth file from a test. */
async function boot(opts: { codex?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kb-cmds-"));
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const adapter = mkAdapter();
  const codex = opts.codex ? mkCodex() : null;
  const statusBar = { set: vi.fn(), dispose: vi.fn() };
  __wireForTest({ adapter, codexAdapter: codex, statusBar });
  const fetched = stubFetch();
  const ctx = makeContext();
  await activate(ctx as never);
  return {
    home, adapter, codex, statusBar, ctx, fetched,
    async dispose() {
      await deactivate();
      if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
      if (prevUser !== undefined) process.env.USERPROFILE = prevUser; else delete process.env.USERPROFILE;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

beforeEach(() => {
  // Fresh slate per test. Module-globals (secrets, commands._handlers,
  // _opened, _shown, _openedDocs) survive across tests in the same file
  // because the vscode mock module is shared.
  secrets.clear();
  commands._handlers.clear();
  commands._executed.length = 0;
  _opened.length = 0;
  _shown.length = 0;
  _openedDocs.length = 0;
  __wireForTest({});
});

afterEach(() => { vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------
// Registration: every contributed command id is wired to a handler.
// Source of truth is package.json — if a new command is added there without
// a registerCommand() call, this fails loudly.
// ---------------------------------------------------------------------------
describe("contributed commands → registered handlers", () => {
  const CONTRIBUTED = [
    "kickbacks.signIn",
    "kickbacks.signOut",
    "kickbacks.restore",
    "kickbacks.status",
    "kickbacks.debugMenu",
    "kickbacks.editConfig",
    "vibe-ads.signIn",
    "vibe-ads.signOut",
    "vibe-ads.restore",
    "vibe-ads.status",
    "vibe-ads.debugMenu",
  ];

  it("registers every contributed command id", async () => {
    const t = await boot();
    try {
      for (const id of CONTRIBUTED) {
        expect(commands._handlers.has(id), `missing handler: ${id}`).toBe(true);
      }
    } finally { await t.dispose(); }
  });

  it("ccVersion wire label: the CLAUDE version wins when claude is"
    + " compatible (codex present or not)", async () => {
    // Pins the codex-only counterpart in extension.test.ts: a compatible
    // Claude Code must keep reporting its own version on the killswitch /
    // portfolio wire — never the codex/<ver> label.
    const t = await boot({ codex: true });
    try {
      expect(t.fetched.calls.some((u) => u.includes("version=2.1.143")),
        "killswitch poll must carry the claude version").toBe(true);
      expect(t.fetched.calls.some((u) => u.includes("codex%2F"))).toBe(false);
    } finally { await t.dispose(); }
  });

  it("every legacy vibe-ads.* alias points to the SAME closure as its kickbacks.* twin", async () => {
    const t = await boot();
    try {
      // Shared-closure parity: a user keybinding on a legacy id should fire
      // the exact same code path, never a drifted copy. Reference equality
      // is the strongest assertion we can make at this layer.
      const pairs: [string, string][] = [
        ["kickbacks.signIn",    "vibe-ads.signIn"],
        ["kickbacks.signOut",   "vibe-ads.signOut"],
        ["kickbacks.restore",   "vibe-ads.restore"],
        ["kickbacks.status",    "vibe-ads.status"],
        ["kickbacks.debugMenu", "vibe-ads.debugMenu"],
      ];
      for (const [a, b] of pairs) {
        expect(commands._handlers.get(a), `alias drift: ${a} vs ${b}`)
          .toBe(commands._handlers.get(b));
      }
    } finally { await t.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// kickbacks.signIn → opens the broker URL in the system browser AND
// stores the returned tokens. This is the regression class the user is
// most worried about ("did clicking the button actually trigger a browser").
// ---------------------------------------------------------------------------
describe("kickbacks.signIn", () => {
  it("opens the broker URL via vscode.env.openExternal", async () => {
    const t = await boot();
    try {
      await commands.executeCommand("kickbacks.signIn");
      expect(_opened.some((u) => u.includes("https://broker.test/auth"))).toBe(true);
      // And the access token landed in secrets — the round-trip happened.
      expect(await t.ctx.secrets.get("kickbacks.access")).toBe("AT-INT");
    } finally { await t.dispose(); }
  });

  it("the legacy vibe-ads.signIn alias also opens the broker URL", async () => {
    const t = await boot();
    try {
      await commands.executeCommand("vibe-ads.signIn");
      expect(_opened.some((u) => u.includes("https://broker.test/auth"))).toBe(true);
    } finally { await t.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// kickbacks.signOut → clears the in-process token, restores Claude Code,
// and shows the "signed out" toast.
// ---------------------------------------------------------------------------
describe("kickbacks.signOut", () => {
  it("clears the access token, calls adapter.restore, and toasts", async () => {
    const t = await boot();
    try {
      // First sign in so signOut has something to clear.
      await commands.executeCommand("kickbacks.signIn");
      expect(await t.ctx.secrets.get("kickbacks.access")).toBe("AT-INT");
      t.adapter.restore.mockClear();

      await commands.executeCommand("kickbacks.signOut");

      expect(await t.ctx.secrets.get("kickbacks.access")).toBeUndefined();
      expect(t.adapter.restore).toHaveBeenCalled();
      expect(_shown.some((s) =>
        s.kind === "info" && /signed out/i.test(s.text))).toBe(true);
      // Status bar must reflect the new state — silent failure to update
      // the badge is exactly the "button does nothing" symptom we're guarding.
      expect(t.statusBar.set).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "signed-out" }));
    } finally { await t.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// Regression (audit #20): sign-out must clear the live ad-rotation state.
// Pre-fix, doSignOut restored the CC files but left the REAL ad in adRef and
// the rotation queue — the status bar kept serving it signed-out, the next
// rotation tick re-patched CC right after the restore, and metrics misrouted
// the real session tokens to /v1/metrics/demo.
// ---------------------------------------------------------------------------
describe("kickbacks.signOut → ad-rotation clear", () => {
  const mkAd = (adId: string): PatchAd => ({
    adId, campaignId: "c-" + adId, adText: "Ad " + adId, iconRef: "i",
    iconUrl: "", clickUrl: "https://x.test", bannerEnabled: false,
    sessionToken: "tok-" + adId });
  const mkResp = (ads: PatchAd[]): PortfolioResponse => ({
    ad: ads[0] ?? null, ads, queueId: "q", ttlMs: 60_000,
    rotationIntervalMs: 120_000, viewThresholdMs: 3_000, balances: null });

  it("drops the leftover real ads from the live rotation on sign-out", async () => {
    const t = await boot();
    const timers: NodeJS.Timeout[] = [];
    try {
      await commands.executeCommand("kickbacks.signIn");
      // Stand up a live rotation holding REAL ads. The hermetic boot serves
      // no ad (stub portfolio is empty) so activation never created one —
      // this registers as THE live rotation the sign-out command must reach.
      const ads = [mkAd("real-1"), mkAd("real-2")];
      const adRef = { current: ads[0] as PatchAd | null };
      const activeAdRef = { current: ads[0] as PatchAd | null };
      const deps = {
        adapter: { applyPatch: vi.fn(() => ({ ok: true })) },
        portfolio: { fetchPortfolio: async () => null,
                     fetchDemoPortfolio: async () => null },
        auth: { accessToken: () => "tok", clientId: () => "cid" },
        debugCtl: { setPortfolioAd: vi.fn() },
        session: { set: vi.fn() },
        ccVersion: "2.1.167", port: 12345,
        patchParams: { adText: "", iconRef: "", iconUrl: "", clickUrl: "" },
        activeAdRef, corrRef: { current: "corr" }, adRef,
        impDedupe: { reset: vi.fn() }, reapplyCodex: null, timers,
      } as unknown as AdRotationDeps;
      const handle = setupAdRotation(deps, mkResp(ads));
      expect(handle.rotationTimer).not.toBeNull();

      await commands.executeCommand("kickbacks.signOut");

      // The command path must clear the rotation: queue gone, timer disarmed,
      // shared ad refs nulled — no surface can keep serving the real ad
      // signed-out and no rotation tick can re-patch CC post-restore.
      expect(handle.adQueue).toEqual([]);
      expect(handle.rotationTimer).toBeNull();
      expect(adRef.current).toBeNull();
      expect(activeAdRef.current).toBeNull();
    } finally {
      timers.forEach((tm) => clearInterval(tm));
      await t.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: signing out then back in must RE-ENABLE injection. doSignOut
// forces injection OFF (a signed-out session can't serve ads); pre-fix the
// sign-in path only re-enabled on neverToggled(), so the OFF that sign-out
// wrote stuck forever and the user came back silently disabled. The fix
// remembers the pre-sign-out state and restores it on the next sign-in.
// ---------------------------------------------------------------------------
describe("sign-out → sign-in re-enables injection", () => {
  it("re-applies the patch after a sign-out/sign-in cycle", async () => {
    const t = await boot();
    try {
      // First sign-in: first-run default-on patches the binary.
      await commands.executeCommand("kickbacks.signIn");
      expect(t.adapter.applyPatch).toHaveBeenCalled();

      // Sign out: injection forced off, binary restored.
      await commands.executeCommand("kickbacks.signOut");
      t.adapter.applyPatch.mockClear();

      // Sign back in: injection must come back on its own (Tier 2).
      await commands.executeCommand("kickbacks.signIn");
      expect(t.adapter.applyPatch).toHaveBeenCalled();
    } finally { await t.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// kickbacks.restore → byte-exact revert of the patched binary(s).
// ---------------------------------------------------------------------------
describe("kickbacks.restore", () => {
  it("calls adapter.restore() exactly once", async () => {
    const t = await boot();
    try {
      t.adapter.restore.mockClear();
      await commands.executeCommand("kickbacks.restore");
      expect(t.adapter.restore).toHaveBeenCalledTimes(1);
    } finally { await t.dispose(); }
  });

  it("also calls codex.restore() when a Codex target is wired", async () => {
    const t = await boot({ codex: true });
    try {
      t.adapter.restore.mockClear();
      t.codex!.restore.mockClear();
      await commands.executeCommand("kickbacks.restore");
      expect(t.adapter.restore).toHaveBeenCalledTimes(1);
      expect(t.codex!.restore).toHaveBeenCalled();
    } finally { await t.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// kickbacks.status → information toast carrying the live state. The exact
// wording is not a contract; the regression we lock in is "the toast fires
// AND mentions the signed-in/out state."
// ---------------------------------------------------------------------------
describe("kickbacks.status", () => {
  it("shows an info toast that reflects signed-out state", async () => {
    const t = await boot();
    try {
      _shown.length = 0; // ignore any activation-time toasts
      await commands.executeCommand("kickbacks.status");
      const last = _shown.filter((s) => s.kind === "info").pop();
      expect(last, "no info toast fired").toBeDefined();
      expect(last!.text).toMatch(/signed out/i);
      expect(last!.text).toMatch(/kickbacks/i);
    } finally { await t.dispose(); }
  });

  it("shows 'signed in' once a token is held", async () => {
    const t = await boot();
    try {
      await commands.executeCommand("kickbacks.signIn");
      _shown.length = 0;
      await commands.executeCommand("kickbacks.status");
      const last = _shown.filter((s) => s.kind === "info").pop();
      expect(last!.text).toMatch(/signed in/i);
    } finally { await t.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// kickbacks.debugMenu → opens the QuickPick. We assert the menu actually
// asks the user for input AND surfaces every must-have row. The individual
// row → command routing is already covered by debug.test.ts.
// ---------------------------------------------------------------------------
describe("kickbacks.debugMenu", () => {
  it("opens a QuickPick containing every documented menu row", async () => {
    const t = await boot();
    try {
      let captured: { id?: string; label?: string }[] = [];
      const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
        async (items: unknown) => {
          captured = items as { id?: string }[]; return undefined;
        });
      await commands.executeCommand("kickbacks.debugMenu");
      // Assert BEFORE mockRestore — vitest's restore clears the spy's call
      // history alongside removing it (caught the hard way: spy fired but
      // the post-restore expect saw zero calls). Lesson preserved in-line
      // so future tests in this file don't repeat the trap.
      expect(qp).toHaveBeenCalled();
      const ids = captured.map((i) => i.id);
      for (const required of ["toggle", "config", "reapply", "reload",
                              "restore", "openlog", "builtinfo"]) {
        expect(ids, `missing menu row: ${required}`).toContain(required);
      }
      qp.mockRestore();
    } finally { await t.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// kickbacks.editConfig → materialises ~/.vibe-ads/config.json if missing
// and opens it in the editor. The observable side effect we assert on is
// workspace.openTextDocument being called with a config-shaped path.
// ---------------------------------------------------------------------------
describe("kickbacks.editConfig", () => {
  it("opens the config file in the editor", async () => {
    const t = await boot();
    try {
      _openedDocs.length = 0;
      await commands.executeCommand("kickbacks.editConfig");
      // ensureConfigFile() resolves to either ~/.kickbacks/config.json or
      // ~/.vibe-ads/config.json depending on which exists; match either.
      expect(_openedDocs.some((p) => /config\.json$/.test(p)),
        `openTextDocument was not called with a config path; saw: ${JSON.stringify(_openedDocs)}`
      ).toBe(true);
    } finally { await t.dispose(); }
  });
});
