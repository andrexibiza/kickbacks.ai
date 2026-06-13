/** Regression tests for wave-2I-F03 — first-run consent prompt.
 *
 * The prompt is one-time per (extension instance × tos_version), only
 * fires for signed-in users who have not accepted the live ToS, and
 * never throws into activation.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsentClient } from "../src/consent/client";
import { maybePromptForConsent } from "../src/consent/prompt";

const baseState = {
  telemetry_opt_in: false,
  tos_accepted_version: null,
  current_tos_version: "2026-05-17",
};

function makeFetch(getResp: any, postResp: any = { ok: true, json: async () => ({ tos_version: "2026-05-17", accepted_at: "now" }) }) {
  return (async (url: string, init?: any) => {
    if (init?.method === "POST") return postResp;
    return getResp;
  }) as unknown as typeof fetch;
}

function makeCtx(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    globalState: {
      get: (k: string) => store.get(k),
      update: async (k: string, v: unknown) => { store.set(k, v); },
    },
    _store: store,
  } as any;
}

function makeVsc() {
  const calls: any[] = [];
  return {
    calls,
    window: {
      showInformationMessage: vi.fn(async (..._args: any[]) => {
        calls.push(_args);
        return undefined; // dismissed by default
      }),
    },
    env: { openExternal: vi.fn(async () => true) },
    Uri: { parse: (s: string) => s },
  } as any;
}

describe("ConsentClient", () => {
  it("returns parsed state on 200", async () => {
    const c = new ConsentClient("http://x", () => "tok",
      makeFetch({ ok: true, json: async () => baseState }));
    expect(await c.read()).toEqual({
      telemetryOptIn: false,
      tosAcceptedVersion: null,
      currentTosVersion: "2026-05-17",
    });
  });
  it("null when signed out", async () => {
    const c = new ConsentClient("http://x", () => null,
      makeFetch({ ok: true, json: async () => baseState }));
    expect(await c.read()).toBeNull();
  });
  it("null on bad json (no current_tos_version)", async () => {
    const c = new ConsentClient("http://x", () => "tok",
      makeFetch({ ok: true, json: async () => ({}) }));
    expect(await c.read()).toBeNull();
  });
  it("accept POSTs and returns version", async () => {
    const c = new ConsentClient("http://x", () => "tok",
      makeFetch({ ok: true, json: async () => baseState }));
    expect(await c.accept()).toEqual({ tosVersion: "2026-05-17", acceptedAt: "now" });
  });
});

describe("maybePromptForConsent", () => {
  it("no-ops when signed out (read returns null)", async () => {
    const client = new ConsentClient("http://x", () => null, makeFetch({ ok: true, json: async () => baseState }));
    const vsc = makeVsc();
    await maybePromptForConsent({ client, ctx: makeCtx(), vsc });
    expect(vsc.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("no-ops when already consented to current version", async () => {
    const accepted = { ...baseState, telemetry_opt_in: true, tos_accepted_version: "2026-05-17" };
    const client = new ConsentClient("http://x", () => "tok", makeFetch({ ok: true, json: async () => accepted }));
    const vsc = makeVsc();
    await maybePromptForConsent({ client, ctx: makeCtx(), vsc });
    expect(vsc.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("does not re-prompt if globalState already marked shown for this version", async () => {
    const client = new ConsentClient("http://x", () => "tok", makeFetch({ ok: true, json: async () => baseState }));
    const vsc = makeVsc();
    const ctx = makeCtx({ "vibe-ads.consent.promptShownForVersion": "2026-05-17" });
    await maybePromptForConsent({ client, ctx, vsc });
    expect(vsc.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("prompts when fresh + signed in + not consented", async () => {
    const client = new ConsentClient("http://x", () => "tok", makeFetch({ ok: true, json: async () => baseState }));
    const vsc = makeVsc();
    const ctx = makeCtx();
    await maybePromptForConsent({ client, ctx, vsc });
    expect(vsc.window.showInformationMessage).toHaveBeenCalledOnce();
    // dismissed by default → globalState marks shown for this version
    expect(ctx._store.get("vibe-ads.consent.promptShownForVersion")).toBe("2026-05-17");
  });

  it("Agree path POSTs and marks shown only after success", async () => {
    const client = new ConsentClient("http://x", () => "tok", makeFetch(
      { ok: true, json: async () => baseState },
      { ok: true, json: async () => ({ tos_version: "2026-05-17", accepted_at: "2026-05-17T00:00:00Z" }) },
    ));
    const vsc = makeVsc();
    vsc.window.showInformationMessage = vi.fn(async () => "Agree") as any;
    const ctx = makeCtx();
    await maybePromptForConsent({ client, ctx, vsc });
    expect(ctx._store.get("vibe-ads.consent.promptShownForVersion")).toBe("2026-05-17");
  });

  it("Privacy Policy path opens URL and does NOT mark shown", async () => {
    const client = new ConsentClient("http://x", () => "tok", makeFetch({ ok: true, json: async () => baseState }));
    const vsc = makeVsc();
    vsc.window.showInformationMessage = vi.fn(async () => "Privacy Policy") as any;
    const ctx = makeCtx();
    await maybePromptForConsent({ client, ctx, vsc });
    expect(vsc.env.openExternal).toHaveBeenCalledOnce();
    // Not marked — so next session re-surfaces (gentle, not pushy)
    expect(ctx._store.has("vibe-ads.consent.promptShownForVersion")).toBe(false);
  });
});
