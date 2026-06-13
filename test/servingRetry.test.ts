// Serving bring-up retry (audit #5) + the Wave-2 auditor carry-over.
//
// Pre-fix, a backend flap at activation (documented cold-start 502/503),
// momentarily-empty inventory, or a fail-safed kill probe made
// setupWebviewInjection return {lbInfo:null, cycleReassert:null,
// refreshPortfolioNow:null} and NOTHING ever retried — serving was dead
// until a window reload. The carry-over: a persisted-kill boot skipped
// serving, and when checkKill later cleared the posture, showActive painted
// green while nothing could serve. extension.ts now retries the bring-up
// (portfolio fetch + webview injection) on a bounded-exponential-backoff
// loop that skips — but stays alive — while the serving gate is not "write".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

// Hermetic ~/.claude/settings.json — activate() wires the claude-cli
// statusline adapter (cliSync + the audit-#22 early-return path) at the
// developer's REAL settings file; mock it so retries never touch disk.
vi.mock("../src/adapters/claude-cli/adapter", () => ({
  resolveStatuslineAsset: () => "",
  ClaudeCliStatuslineAdapter: class {
    name = "claude-cli-statusline";
    spinnerVerbsSupported = true;
    version() { return "cli"; }
    preflight() { return { ok: true, compatible: true, version: "cli" }; }
    applyPatch() { return { ok: true }; }
    restore() { return { ok: true, restored: false }; }
  },
}));
// No real `claude --version` spawn per activation.
vi.mock("../src/adapters/claude-cli/cliVersion", () => ({
  detectClaudeCliSpinnerSupport:
    async () => ({ ok: true, version: "2.1.150", outdated: false }),
}));

import { activate, deactivate, __wireForTest } from "../src/extension";
import { makeContext, secrets, commands } from "./mocks/vscode";
import { setKillPosture } from "../src/servingGate";

// The production webview apply is the one that carries the portfolio ad's
// text — the boot-canary debug cycle patches with the DEFAULT_TEXT
// placeholder (setPortfolioAd is wired after bootCanary), so filtering on
// this string isolates exactly the bring-up under test.
const AD_TEXT = "RETRY-AD …";

const mkAdapter = () => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
  version: () => "2.1.143",
  isPatched: () => false,
  applyPatch: vi.fn((_p: unknown) => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

// Guarantee the clean-boot canary branch (a recent canary from a parallel
// test worker would otherwise suspend serving and gate the retry loop).
const clearBootCanary = (): void => {
  try { rmSync(join(homedir(), ".vibe-ads", "boot.canary"), { force: true }); }
  catch { /* best-effort */ }
};

// Controllable backend: `state.hasAd` decides whether ANY portfolio fetch
// (authed or demo) returns inventory; the killswitch answers killed:false.
function stubFetch(state: { hasAd: boolean }) {
  const f = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/v1/killswitch")) {
      return { ok: true, status: 200,
        json: async () => ({ killed: false }) } as Response;
    }
    if (url.includes("/v1/portfolio")) {
      return { ok: true, status: 200, json: async () => ({
        ttl_seconds: 30, view_threshold_seconds: 15,
        ads: state.hasAd ? [{ ad_id: "ad-retry", campaign_id: "camp-retry",
          title_text: AD_TEXT, icon_ref: "i",
          click_url: "https://example.com" }] : [],
      }) } as Response;
    }
    return { ok: true, status: 204, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", f);
  return f;
}

const prodApplies = (adapter: ReturnType<typeof mkAdapter>): number =>
  adapter.applyPatch.mock.calls.filter(
    (c) => (c[0] as { adText?: string } | undefined)?.adText === AD_TEXT,
  ).length;

beforeEach(() => {
  secrets.clear();
  commands._handlers.clear();
  commands._executed.length = 0;
  __wireForTest({});
  clearBootCanary();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("serving bring-up retry (audit #5)", { timeout: 30_000 }, () => {

  it("empty inventory at activation: the retry loop brings serving up once"
    + " ads appear (pre-fix: dead until window reload)", async () => {
    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    const state = { hasAd: false };
    stubFetch(state);
    __wireForTest({ adapter, statusBar, servingRetryBaseMs: 25 });
    const ctx = makeContext();
    try {
      await activate(ctx as never);
      expect(prodApplies(adapter),
        "no production apply while inventory is empty").toBe(0);
      // Inventory appears (backend recovered / first block funded).
      state.hasAd = true;
      await vi.waitFor(() => {
        expect(prodApplies(adapter),
          "the retry loop must bring serving up").toBeGreaterThan(0);
      }, { timeout: 15_000, interval: 20 });
      // The loop stopped permanently on success: no further bring-up
      // re-applies within several more would-be retry ticks.
      const n = prodApplies(adapter);
      await new Promise((r) => setTimeout(r, 400));
      expect(prodApplies(adapter), "the loop must stop on success").toBe(n);
    } finally { await deactivate(); }
  });

  it("Wave-2 carry-over: a kill at boot skips serving; the gated retry loop"
    + " stays alive and brings serving up IN-SESSION once the posture"
    + " clears (pre-fix: green status bar, nothing serving)", async () => {
    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    const state = { hasAd: true };
    stubFetch(state);
    __wireForTest({ adapter, statusBar, killed: true, servingRetryBaseMs: 25 });
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.access", "AT-RETRY");
    try {
      await activate(ctx as never);
      // Several gated retry ticks elapse — killed-confirmed must SKIP the
      // attempt (no production apply) without ending the loop.
      await new Promise((r) => setTimeout(r, 150));
      expect(prodApplies(adapter),
        "killed boot must not bring up serving").toBe(0);
      // Recovery: a live 200 killed:false from checkKill clears the posture
      // and the killed flag — simulate exactly that transition (the 30s
      // checkKill interval is too slow for a unit test).
      __wireForTest({ adapter, statusBar, killed: false,
        servingRetryBaseMs: 25 });
      setKillPosture("clear");
      await vi.waitFor(() => {
        expect(prodApplies(adapter),
          "recovery must bring serving up without a reload")
          .toBeGreaterThan(0);
      }, { timeout: 15_000, interval: 20 });
    } finally { await deactivate(); }
  });
});
