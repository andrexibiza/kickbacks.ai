// Consent prompt wired into the full activate() lifecycle: a signed-in user
// whose tos_accepted_version differs from current_tos_version should see the
// one-time prompt and, on Agree, POST to /v1/me/consent. Existing
// consent.test.ts unit-tests the prompt in isolation; this file pins the
// integration — that activate() actually invokes maybePromptForConsent and
// the post-Agree POST is observed on the wire.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, deactivate, __wireForTest } from "../src/extension";
import { ConsentClient } from "../src/consent/client";
import { makeContext, secrets, _opened, _shown, _openedDocs, commands, window }
  from "./mocks/vscode";

const mkAdapter = () => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
  version: () => "2.1.143",
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

function stubFetch(opts: { hasAccepted?: boolean;
                            acceptResponseOk?: boolean } = {}) {
  const calls: { url: string; method: string;
                 headers: Record<string, string> }[] = [];
  const f = vi.fn(async (input: unknown, init?: { method?: string;
      headers?: Record<string, string> }) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method || "GET").toUpperCase();
    calls.push({ url, method, headers: init?.headers || {} });
    if (url.includes("/v1/me/consent")) {
      if (method === "POST") {
        if (opts.acceptResponseOk === false) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return { ok: true, status: 200, json: async () =>
          ({ tos_version: "v2", accepted_at: "2026-01-01T00:00:00Z" }) } as Response;
      }
      // GET — the user has accepted an older version OR not at all.
      return { ok: true, status: 200, json: async () => ({
        telemetry_opt_in: !!opts.hasAccepted,
        tos_accepted_version: opts.hasAccepted ? "v2" : "v1",
        current_tos_version: "v2",
      }) } as Response;
    }
    // benign 200 for everything else (portfolio / killswitch / earnings).
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", f);
  return { f, calls };
}

beforeEach(() => {
  secrets.clear();
  commands._handlers.clear();
  commands._executed.length = 0;
  _opened.length = 0;
  _shown.length = 0;
  _openedDocs.length = 0;
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("consent flow — activate() wires maybePromptForConsent end-to-end", () => {

  it("user with stale tos_accepted_version sees the prompt and, on Agree,"
    + " POSTs /v1/me/consent", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-consent-"));
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar });
    const fetched = stubFetch({ hasAccepted: false });
    // Force the prompt to resolve to "Agree" without showing anything to a
    // real human. Restore the default in afterEach via vi.restoreAllMocks
    // is not needed — the mock module is process-shared and beforeEach
    // resets the _shown ring buffer.
    const origShow = window.showInformationMessage;
    window.showInformationMessage = (async (msg: unknown, ..._rest: unknown[]) => {
      _shown.push({ kind: "info", text: String(msg) });
      return "Agree";
    }) as never;
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.access", "AT-CONSENT");

    try {
      await activate(ctx as never);
      // maybePromptForConsent is fire-and-forget; drain a few ticks so the
      // GET → showInformationMessage → POST chain lands.
      await new Promise((r) => setTimeout(r, 50));

      const gets = fetched.calls.filter(
        (c) => c.url.endsWith("/v1/me/consent") && c.method === "GET");
      const posts = fetched.calls.filter(
        (c) => c.url.endsWith("/v1/me/consent") && c.method === "POST");
      expect(gets.length).toBeGreaterThan(0);
      expect(posts.length).toBe(1);
      expect(posts[0].headers.authorization).toBe("Bearer AT-CONSENT");
      // Prompt actually shown.
      expect(_shown.some(
        (s) => s.kind === "info" && /spinner/i.test(s.text))).toBe(true);
      // Post-Agree, the SHOWN_KEY is persisted so we don't nag this session.
      const stored = ctx.globalState.get<string>(
        "vibe-ads.consent.promptShownForVersion");
      expect(stored).toBe("v2");
    } finally {
      window.showInformationMessage = origShow;
      await deactivate();
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUser !== undefined) process.env.USERPROFILE = prevUser;
      else delete process.env.USERPROFILE;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("already-accepted user gets NO prompt + NO POST", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-consent2-"));
    const prevHome = process.env.HOME;
    const prevUser = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    const adapter = mkAdapter();
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar });
    const fetched = stubFetch({ hasAccepted: true });
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.access", "AT-CONSENT2");

    try {
      await activate(ctx as never);
      await new Promise((r) => setTimeout(r, 50));
      const posts = fetched.calls.filter(
        (c) => c.url.endsWith("/v1/me/consent") && c.method === "POST");
      expect(posts.length).toBe(0);
      expect(_shown.some(
        (s) => s.kind === "info" && /spinner/i.test(s.text))).toBe(false);
    } finally {
      await deactivate();
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUser !== undefined) process.env.USERPROFILE = prevUser;
      else delete process.env.USERPROFILE;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("signed-out user gets NO prompt + NO POST (no token => no GET)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "kb-consent3-"));
      const prevHome = process.env.HOME;
      const prevUser = process.env.USERPROFILE;
      process.env.HOME = home; process.env.USERPROFILE = home;
      const adapter = mkAdapter();
      const statusBar = { set: vi.fn(), dispose: vi.fn() };
      __wireForTest({ adapter, statusBar });
      const fetched = stubFetch({ hasAccepted: false });
      const ctx = makeContext();  // NOT signed in
      try {
        await activate(ctx as never);
        await new Promise((r) => setTimeout(r, 50));
        const consentCalls = fetched.calls.filter(
          (c) => c.url.endsWith("/v1/me/consent"));
        expect(consentCalls).toHaveLength(0);
      } finally {
        await deactivate();
        if (prevHome !== undefined) process.env.HOME = prevHome;
        else delete process.env.HOME;
        if (prevUser !== undefined) process.env.USERPROFILE = prevUser;
        else delete process.env.USERPROFILE;
        try { rmSync(home, { recursive: true, force: true }); } catch { /* ok */ }
      }
    });
});

// audit-2026-06-09 #38: ConsentClient was the only client whose DEFAULT was
// bare `fetch` (no timeout) — the 2A-01 black-holed-connection hang class.
// Pin that the default-constructed client (the extension.ts wiring passes no
// fetch) sends every request with an AbortSignal.
describe("ConsentClient default fetch carries a timeout (audit #38)", () => {
  it("GET and POST both carry an abort signal", async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
      inits.push(init);
      return { ok: true, status: 200, json: async () => ({
        telemetry_opt_in: false, tos_accepted_version: "v1",
        current_tos_version: "v2",
        tos_version: "v2", accepted_at: "2026-01-01T00:00:00Z",
      }) } as Response;
    }));
    const c = new ConsentClient("http://x", () => "tok");
    expect(await c.read()).not.toBeNull();
    expect(await c.accept()).not.toBeNull();
    expect(inits).toHaveLength(2);
    // Pre-fix: the default was bare fetch -> no signal on either call.
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(inits[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
