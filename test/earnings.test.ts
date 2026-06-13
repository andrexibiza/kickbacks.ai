import { describe, it, expect, vi, afterEach } from "vitest";
import { EarningsClient } from "../src/earnings/client";

const okFetch = (async () => ({
  ok: true,
  json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }),
})) as unknown as typeof fetch;
const errFetch = (async () => ({ ok: false })) as unknown as typeof fetch;
const badJson = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;

describe("EarningsClient", () => {
  it("returns today + lifetime when signed in", async () => {
    const c = new EarningsClient("http://x", () => "tok", okFetch);
    expect(await c.fetch()).toEqual({ lifetimeUsd: "1.20", todayUsd: "0.04" });
  });
  it("null when signed out (no token)", async () => {
    const c = new EarningsClient("http://x", () => null, okFetch);
    expect(await c.fetch()).toBeNull();
  });
  it("null on non-200", async () => {
    const c = new EarningsClient("http://x", () => "tok", errFetch);
    expect(await c.fetch()).toBeNull();
  });
  it("null when JSON missing fields", async () => {
    const c = new EarningsClient("http://x", () => "tok", badJson);
    expect(await c.fetch()).toBeNull();
  });
});

// audit-2026-06-09 #34: fetch() collapses every failure to null, so the
// caller (earningsRefresh) could not tell a real backend 401 from a network
// blip and falsely flipped authHealthy to "401". fetchDetailed preserves the
// failure KIND: "401" only for a genuine unrecovered HTTP 401.
describe("EarningsClient.fetchDetailed (audit #34)", () => {
  const fetch401 = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
  const fetch500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  const fetchThrow = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

  it("real 401 with no recovery hook -> outcome '401'", async () => {
    const c = new EarningsClient("http://x", () => "tok", fetch401);
    expect(await c.fetchDetailed()).toEqual({ outcome: "401" });
  });
  it("network error -> 'error', NOT '401'", async () => {
    const c = new EarningsClient("http://x", () => "tok", fetchThrow);
    expect(await c.fetchDetailed()).toEqual({ outcome: "error" });
  });
  it("5xx -> 'error', NOT '401'", async () => {
    const c = new EarningsClient("http://x", () => "tok", fetch500);
    expect(await c.fetchDetailed()).toEqual({ outcome: "error" });
  });
  it("malformed body -> 'error', NOT '401'", async () => {
    const c = new EarningsClient("http://x", () => "tok", badJson);
    expect(await c.fetchDetailed()).toEqual({ outcome: "error" });
  });
  it("401 + successful refresh + ok retry -> 'ok'", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 401 };
      return { ok: true,
        json: async () => ({ lifetime_usd: "2.00", today_usd: "0.10" }) };
    }) as unknown as typeof fetch;
    const c = new EarningsClient("http://x", () => "tok", f, async () => true);
    expect(await c.fetchDetailed()).toEqual({ outcome: "ok",
      earnings: { lifetimeUsd: "2.00", todayUsd: "0.10" } });
  });
  it("401 + successful refresh + second 401 -> '401' (really expired)", async () => {
    const c = new EarningsClient("http://x", () => "tok", fetch401, async () => true);
    expect(await c.fetchDetailed()).toEqual({ outcome: "401" });
  });
  it("401 + FAILED refresh -> '401' (session genuinely broken)", async () => {
    const c = new EarningsClient("http://x", () => "tok", fetch401, async () => false);
    expect(await c.fetchDetailed()).toEqual({ outcome: "401" });
  });
});

// audit-2026-06-09 #38: extension.ts passes bare global `fetch` positionally
// (to reach onAuth401), bypassing the timeoutFetch(15000) default — the
// 2A-01 black-holed-connection hang class. The constructor must re-wrap
// exactly that case while leaving injected mocks untouched.
describe("EarningsClient timeout wiring (audit #38)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("bare global fetch passed positionally is re-wrapped with an abort signal", async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
      inits.push(init);
      return { ok: true,
        json: async () => ({ lifetime_usd: "1.00", today_usd: "0.01" }) };
    }));
    // Mirrors the extension.ts wiring: global fetch as the 3rd positional arg.
    const c = new EarningsClient("http://x", () => "tok", fetch,
      async () => false);
    expect(await c.fetch()).toEqual({ lifetimeUsd: "1.00", todayUsd: "0.01" });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    // The bearer header survives the re-wrap.
    expect((inits[0]?.headers as Record<string, string>).authorization)
      .toBe("Bearer tok");
  });
});
