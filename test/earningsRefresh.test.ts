// audit-2026-06-09 #34 regression: showActive used to flip authHealthy to
// "401" on ANY earnings-fetch failure (network blip, 5xx, malformed body),
// so the debug menu falsely showed "Sign in again — your session expired"
// during every offline poll. Only a REAL backend 401 may raise that signal;
// transient failures must leave the last verdict in place. Also pins the
// second half of the finding: a token that dies DURING the fetch paints
// signed-out, not a stale green "active" bar.
import { describe, it, expect, vi } from "vitest";
import type { AuthClient } from "../src/auth/client";
import { setupEarningsRefresh } from "../src/activation/earningsRefresh";
import { EarningsClient } from "../src/earnings/client";
import { SessionState } from "../src/sessionState";
import { makeContext } from "./mocks/vscode";

// Wires a real EarningsClient + SessionState behind setupEarningsRefresh.
// Token starts null so the constructor's `void showActive()` takes the
// signed-out path and the tests drive exactly ONE deterministic run each.
function wire(f: typeof fetch) {
  let tok: string | null = null;
  const session = new SessionState();
  const statusBar = { set: vi.fn() };
  const capWarning = { show: vi.fn(), hide: vi.fn() };
  const auth = { accessToken: () => tok } as unknown as AuthClient;
  const client = new EarningsClient("http://x", () => tok, f);
  const { showActive } = setupEarningsRefresh(
    auth, client, session, statusBar, "2.1.143", makeContext() as never,
    undefined, capWarning);
  return { session, statusBar, capWarning, showActive,
           setToken: (t: string | null) => { tok = t; } };
}

const okFetch = (async () => ({
  ok: true,
  json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }),
})) as unknown as typeof fetch;

describe("setupEarningsRefresh authHealthy (audit #34)", () => {
  it("a 5xx does NOT set authHealthy '401'", async () => {
    const f = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const { session, showActive, setToken } = wire(f);
    setToken("tok");
    await showActive();
    expect(session.get().signedIn).toBe(true);
    expect(session.get().authHealthy).not.toBe("401");
  });

  it("a network error does NOT clobber a previously-ok verdict", async () => {
    let mode: "ok" | "throw" = "ok";
    const f = (async () => {
      if (mode === "throw") throw new Error("offline");
      return { ok: true,
        json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }) };
    }) as unknown as typeof fetch;
    const { session, showActive, setToken } = wire(f);
    setToken("tok");
    await showActive();
    expect(session.get().authHealthy).toBe("ok");
    mode = "throw";                       // laptop loses connectivity
    await showActive();
    expect(session.get().authHealthy).toBe("ok");   // pre-fix: "401"
    expect(session.get().signedIn).toBe(true);
  });

  it("a REAL backend 401 still sets authHealthy '401'", async () => {
    const f = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const { session, showActive, setToken } = wire(f);
    setToken("tok");
    await showActive();
    expect(session.get().signedIn).toBe(true);
    expect(session.get().authHealthy).toBe("401");
  });

  it("token death mid-fetch paints signed-out, not the green active bar", async () => {
    let kill: (() => void) | null = null;
    const f = (async () => {
      kill?.();                           // sign-out lands during the await
      return { ok: true,
        json: async () => ({ lifetime_usd: "1.20", today_usd: "0.04" }) };
    }) as unknown as typeof fetch;
    const { session, statusBar, showActive, setToken } = wire(f);
    setToken("tok");
    kill = () => setToken(null);
    await showActive();
    const last = statusBar.set.mock.calls.at(-1)?.[0] as { kind: string };
    expect(last.kind).toBe("signed-out"); // pre-fix: "active"
    expect(session.get().signedIn).toBe(false);
  });

  it("healthy fetch paints active with the fresh figures", async () => {
    const { session, statusBar, showActive, setToken } = wire(okFetch);
    setToken("tok");
    await showActive();
    expect(session.get().authHealthy).toBe("ok");
    const last = statusBar.set.mock.calls.at(-1)?.[0] as
      { kind: string; usd?: string; usdToday?: string };
    expect(last).toEqual({ kind: "active", version: "2.1.143",
                           usd: "1.20", usdToday: "0.04" });
  });
});

describe("setupEarningsRefresh cap-warning pill", () => {
  const cappedFetch = (async () => ({
    ok: true,
    json: async () => ({
      lifetime_usd: "84.10", today_usd: "50.00",
      cap: { scope: "daily", cap_usd: "50.00", reset_seconds: 22320 },
    }),
  })) as unknown as typeof fetch;

  it("shows the pill when the earnings response carries a cap", async () => {
    const { capWarning, showActive, setToken } = wire(cappedFetch);
    setToken("tok");
    await showActive();
    expect(capWarning.show).toHaveBeenCalledWith(
      { scope: "daily", capUsd: "50.00", resetSeconds: 22320 });
    expect(capWarning.hide).not.toHaveBeenCalled();
  });

  it("hides the pill when under both ceilings (no cap field)", async () => {
    const { capWarning, showActive, setToken } = wire(okFetch);
    setToken("tok");
    await showActive();
    expect(capWarning.hide).toHaveBeenCalled();
    expect(capWarning.show).not.toHaveBeenCalled();
  });

  it("hides the pill on a not-earning safety state (signed-out)", async () => {
    // Token null → the signed-out early-return must hide the pill.
    const { capWarning, showActive } = wire(okFetch);
    await showActive();
    expect(capWarning.hide).toHaveBeenCalled();
    expect(capWarning.show).not.toHaveBeenCalled();
  });
});
