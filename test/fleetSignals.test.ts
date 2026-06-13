// Fleet-chattiness fix (2026-06-12): the backend piggybacks the killswitch
// verdict (`kill`) and status-bar earnings (`balances` incl. `cap`) on the
// portfolio + metrics responses, and the extension stands its standalone
// /v1/killswitch + /v1/earnings pollers down while that data is fresh.
// Load-bearing rules pinned here:
//   - only a FRESH 2xx parse produces a signal (never the warm-cache path);
//   - a piggybacked verdict can never produce the OFFLINE posture;
//   - cap-KEY-presence (even null) is the new-backend marker; without it the
//     earnings poll keeps running (old backend ⇒ today's behavior);
//   - registration replays the boot-time buffered verdict.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FleetSignals, parseKillField, parseBalancesField,
  KILL_STALE_MS,
} from "../src/fleetSignals";
import { PortfolioClient } from "../src/portfolio/client";
import { MetricsClient } from "../src/metrics/client";
import { setupEarningsRefresh } from "../src/activation/earningsRefresh";
import { EarningsClient } from "../src/earnings/client";
import { SessionState } from "../src/sessionState";
import type { AuthClient } from "../src/auth/client";
import { makeContext } from "./mocks/vscode";

afterEach(() => {
  vi.useRealTimers();
});

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

// ─── parsers ────────────────────────────────────────────────────────────────

describe("parseKillField", () => {
  it("maps a clear verdict; fresh 200 semantics (confirmed=killed)", () => {
    expect(parseKillField({ killed: false, scope: null, reason: "" }))
      .toEqual({ killed: false, confirmed: false, scope: undefined,
                 reason: "", offline: false });
  });

  it("maps a kill verdict with confirmed=true", () => {
    const ks = parseKillField({ killed: true, reason: "fail-safe" });
    expect(ks).toMatchObject({ killed: true, confirmed: true,
                               reason: "fail-safe" });
  });

  it("NEVER produces the offline posture", () => {
    for (const raw of [{ killed: true }, { killed: false },
                       { killed: true, offline: true }]) {
      expect(parseKillField(raw)?.offline).toBe(false);
    }
  });

  it("returns undefined (no signal) for missing/malformed input", () => {
    for (const raw of [undefined, null, "x", 7, {}, { killed: "yes" }]) {
      expect(parseKillField(raw)).toBeUndefined();
    }
  });
});

describe("parseBalancesField", () => {
  it("cap KEY present (null) ⇒ capCapable, cap undefined", () => {
    const s = parseBalancesField(
      { lifetime_usd: "1.20", today_usd: "0.04", cap: null });
    expect(s).toMatchObject({ lifetimeUsd: "1.20", todayUsd: "0.04",
                              capCapable: true });
    expect(s?.cap).toBeUndefined();
  });

  it("cap KEY absent ⇒ NOT capCapable (old backend marker)", () => {
    const s = parseBalancesField({ lifetime_usd: "1.20", today_usd: "0.04" });
    expect(s?.capCapable).toBe(false);
  });

  it("parses a real cap block via parseCap", () => {
    const s = parseBalancesField({
      lifetime_usd: "1.20", today_usd: "0.04",
      cap: { scope: "daily", cap_usd: "50.00", reset_seconds: 3600 } });
    expect(s?.cap).toEqual({ scope: "daily", capUsd: "50.00",
                             resetSeconds: 3600 });
  });

  it("returns undefined for malformed input", () => {
    for (const raw of [undefined, null, {}, { lifetime_usd: 5 },
                       { lifetime_usd: "1", today_usd: 2 }]) {
      expect(parseBalancesField(raw)).toBeUndefined();
    }
  });
});

// ─── the store ──────────────────────────────────────────────────────────────

describe("FleetSignals store", () => {
  it("noteKill stamps freshness and fires the sink", () => {
    const fs = new FleetSignals();
    const sink = vi.fn();
    fs.onKillVerdict(sink);
    expect(fs.killFreshWithin(KILL_STALE_MS)).toBe(false);
    fs.noteKill({ killed: false });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(fs.killFreshWithin(KILL_STALE_MS)).toBe(true);
  });

  it("malformed kill input produces NO signal and NO freshness", () => {
    const fs = new FleetSignals();
    const sink = vi.fn();
    fs.onKillVerdict(sink);
    fs.noteKill({ killed: "nope" });
    fs.noteKill(undefined);
    expect(sink).not.toHaveBeenCalled();
    expect(fs.killFreshWithin(KILL_STALE_MS)).toBe(false);
  });

  it("freshness expires after KILL_STALE_MS", () => {
    vi.useFakeTimers();
    const fs = new FleetSignals();
    fs.noteKill({ killed: false });
    vi.advanceTimersByTime(KILL_STALE_MS - 1);
    expect(fs.killFreshWithin(KILL_STALE_MS)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(fs.killFreshWithin(KILL_STALE_MS)).toBe(false);
  });

  it("onKillVerdict REPLAYS a fresh buffered verdict at registration "
     + "(boot portfolio fetch precedes the kill machinery)", () => {
    const fs = new FleetSignals();
    fs.noteKill({ killed: true, reason: "global" });   // before any sink
    const sink = vi.fn();
    fs.onKillVerdict(sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ killed: true,
                                                  confirmed: true });
  });

  it("noteBalances stores a snapshot and fires the earnings sink", () => {
    const fs = new FleetSignals();
    const sink = vi.fn();
    fs.onEarningsUpdated(sink);
    fs.noteBalances({ lifetime_usd: "2.00", today_usd: "0.10", cap: null });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(fs.earningsSnapshot()).toMatchObject({ lifetimeUsd: "2.00" });
    fs.clearEarnings();
    expect(fs.earningsSnapshot()).toBeNull();
  });
});

// ─── wire-client integration ────────────────────────────────────────────────

const AD = { ad_id: "a1", campaign_id: "c1", title_text: "x".repeat(35),
             icon_ref: "i", click_url: "https://t/x", session_token: "tok" };

describe("PortfolioClient fleet-signal sink", () => {
  it("fires kill + balances from a fresh AUTHED 2xx", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    const f = vi.fn(async () => ok({
      ttl_seconds: 60, ads: [AD],
      kill: { killed: false, scope: null, reason: "" },
      balances: { lifetime_usd: "1.20", today_usd: "0.04", cap: null },
    }));
    const c = new PortfolioClient("http://b", () => "tok", f as never, signals);
    await c.fetchPortfolio("2.1.143");
    expect(signals.noteKill).toHaveBeenCalledWith(
      { killed: false, scope: null, reason: "" });
    expect(signals.noteBalances).toHaveBeenCalledWith(
      { lifetime_usd: "1.20", today_usd: "0.04", cap: null });
  });

  it("fires kill even when a global kill EMPTIES the inventory", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    const f = vi.fn(async () => ok({
      ttl_seconds: 60, ads: [], kill: { killed: true, reason: "global" } }));
    const c = new PortfolioClient("http://b", () => "tok", f as never, signals);
    await c.fetchPortfolio("2.1.143");
    expect(signals.noteKill).toHaveBeenCalledWith(
      { killed: true, reason: "global" });
  });

  it("does NOT fire from the warm-cache fallback path", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return ok({ ttl_seconds: 60, ads: [AD],
                               kill: { killed: false } });
      throw new Error("network down");
    });
    const c = new PortfolioClient("http://b", () => "tok", f as never, signals);
    await c.fetchPortfolio("2.1.143");          // primes cache, 1 signal
    const r = await c.fetchPortfolio("2.1.143"); // error → warm cache serve
    expect(r).not.toBeNull();
    expect(signals.noteKill).toHaveBeenCalledTimes(1); // no second signal
  });

  it("the DEMO route fires kill but never balances", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    const f = vi.fn(async () => ok({
      ttl_seconds: 60, ads: [AD], kill: { killed: false } }));
    const c = new PortfolioClient("http://b", () => null, f as never, signals);
    await c.fetchDemoPortfolio("2.1.143", "dev-1");
    expect(signals.noteKill).toHaveBeenCalledTimes(1);
    expect(signals.noteBalances).not.toHaveBeenCalled();
  });

  it("threads the campaign param onto the portfolio URL", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      return ok({ ttl_seconds: 60, ads: [] });
    });
    const c = new PortfolioClient("http://b", () => "tok", f as never);
    await c.fetchPortfolio("2.1.143", "camp-9");
    expect(urls[0]).toContain("&campaign=camp-9");
  });
});

describe("MetricsClient fleet-signal sink", () => {
  const send = async (signals: { noteKill: ReturnType<typeof vi.fn>;
                                 noteBalances: ReturnType<typeof vi.fn> },
                      token: string | null, body: unknown,
                      okResp = true) => {
    const f = vi.fn(async () => okResp
      ? ok(body)
      : ({ ok: false, status: 500 }) as Response);
    const m = new MetricsClient("http://b", () => token, () => "cid",
      "0.0.1", f as never, undefined, signals);
    await m.send("click", { adId: "a1", campaignId: "c1",
                            ccVersion: "2.1.143" });
  };

  it("authed 2xx: kill + balances both reach the store", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    await send(signals, "tok", {
      measurement: "measured", billed: true,
      kill: { killed: false },
      balances: { lifetime_usd: "2.00", today_usd: "0.10", cap: null } });
    expect(signals.noteKill).toHaveBeenCalledWith({ killed: false });
    expect(signals.noteBalances).toHaveBeenCalledWith(
      { lifetime_usd: "2.00", today_usd: "0.10", cap: null });
  });

  it("signed-out (demo route): kill only, never balances", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    await send(signals, null, {
      measurement: "measured", billed: true, kill: { killed: false },
      balances: { lifetime_usd: "9.99", today_usd: "9.99" } });
    expect(signals.noteKill).toHaveBeenCalledTimes(1);
    expect(signals.noteBalances).not.toHaveBeenCalled();
  });

  it("a non-2xx response produces no signals", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    await send(signals, "tok", {}, false);
    expect(signals.noteKill).not.toHaveBeenCalled();
    expect(signals.noteBalances).not.toHaveBeenCalled();
  });

  it("an old-backend empty body produces no signals and no throw", async () => {
    const signals = { noteKill: vi.fn(), noteBalances: vi.fn() };
    const f = vi.fn(async () => ({ ok: true, status: 200,
      json: async () => { throw new Error("no body"); } }) as never);
    const m = new MetricsClient("http://b", () => "tok", () => "cid",
      "0.0.1", f as never, undefined, signals);
    await m.send("click", { adId: "a1", campaignId: "c1",
                            ccVersion: "2.1.143" });
    expect(signals.noteKill).not.toHaveBeenCalled();
  });
});

// ─── earningsRefresh fast path ──────────────────────────────────────────────

function wire(f: typeof fetch, signals: FleetSignals | null) {
  let tok: string | null = null;
  const session = new SessionState();
  const statusBar = { set: vi.fn() };
  const capWarning = { show: vi.fn(), hide: vi.fn() };
  const auth = { accessToken: () => tok } as unknown as AuthClient;
  const client = new EarningsClient("http://x", () => tok, f);
  const { showActive } = setupEarningsRefresh(
    auth, client, session, statusBar, "2.1.143", makeContext() as never,
    undefined, capWarning, signals);
  return { session, statusBar, capWarning, showActive,
           setToken: (t: string | null) => { tok = t; } };
}

describe("setupEarningsRefresh fleet-signal fast path", () => {
  it("paints from a fresh capCapable snapshot with ZERO network fetches", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("must not fetch"); });
    const signals = new FleetSignals();
    signals.noteBalances({ lifetime_usd: "3.00", today_usd: "0.30",
                           cap: null });
    const { statusBar, showActive, setToken } =
      wire(fetchSpy as never, signals);
    setToken("tok");
    await showActive();
    expect(fetchSpy).not.toHaveBeenCalled();
    const last = statusBar.set.mock.calls.at(-1)?.[0] as { kind: string };
    expect(last).toEqual({ kind: "active", version: "2.1.143",
                           usd: "3.00", usdToday: "0.30" });
  });

  it("drives the cap pill from the snapshot's cap", async () => {
    const signals = new FleetSignals();
    signals.noteBalances({ lifetime_usd: "3.00", today_usd: "50.00",
      cap: { scope: "daily", cap_usd: "50.00", reset_seconds: 60 } });
    const { capWarning, showActive, setToken } =
      wire((async () => { throw new Error("no"); }) as never, signals);
    setToken("tok");
    await showActive();
    expect(capWarning.show).toHaveBeenCalledWith(
      { scope: "daily", capUsd: "50.00", resetSeconds: 60 });
  });

  it("falls back to GET /v1/earnings when the carrier was NOT capCapable "
     + "(old backend keeps today's behavior)", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true,
      json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }) }));
    const signals = new FleetSignals();
    signals.noteBalances({ lifetime_usd: "9.99", today_usd: "9.99" }); // no cap key
    const { statusBar, showActive, setToken } =
      wire(fetchSpy as never, signals);
    setToken("tok");
    await showActive();
    expect(fetchSpy).toHaveBeenCalled();
    const last = statusBar.set.mock.calls.at(-1)?.[0] as { usd?: string };
    expect(last.usd).toBe("1.20");   // network figures, not the snapshot
  });

  it("falls back to the network once the snapshot goes stale", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => ({ ok: true,
      json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }) }));
    const signals = new FleetSignals();
    signals.noteBalances({ lifetime_usd: "3.00", today_usd: "0.30",
                           cap: null });
    const { showActive, setToken } = wire(fetchSpy as never, signals);
    setToken("tok");
    vi.advanceTimersByTime(91_000);
    await showActive();
    expect(fetchSpy).toHaveBeenCalled();
  });
});
