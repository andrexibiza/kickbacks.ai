import { describe, it, expect, vi } from "vitest";
import { KillSwitchClient } from "../src/killswitch/client";

const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;

describe("KillSwitchClient", () => {
  it("checkOnce returns killed flag from the endpoint (CONFIRMED, offline=false)", async () => {
    const c = new KillSwitchClient("http://b",
      (async () => ok({ killed: true, scope: "global", reason: "stop" })) as never);
    expect(await c.checkOnce("2.1.143", "c1")).toEqual(
      { killed: true, confirmed: true, scope: "global", reason: "stop",
        offline: false });
  });
  it("a 200 killed:false clears everything (recovery shape)", async () => {
    const c = new KillSwitchClient("http://b",
      (async () => ok({ killed: false })) as never);
    const r = await c.checkOnce("2.1.143", "c1");
    expect(r.killed).toBe(false);
    expect(r.confirmed).toBe(false);
    expect(r.offline).toBe(false);
  });
  it("fail-safe: on network error treat as KILLED + offline=true but NEVER"
    + " confirmed (wave-2 kill hysteresis)", async () => {
    const c = new KillSwitchClient("http://b",
      (async () => { throw new Error("down"); }) as never);
    const r = await c.checkOnce("2.1.143", "c1");
    expect(r.killed).toBe(true);
    expect(r.confirmed).toBe(false);
    expect(r.offline).toBe(true);
  });
  it("fail-safe: on non-ok status treat as KILLED + offline=true but NEVER"
    + " confirmed", async () => {
    const c = new KillSwitchClient("http://b",
      (async () => ({ ok: false, status: 502 }) as Response) as never);
    const r = await c.checkOnce("2.1.143", "c1");
    expect(r.killed).toBe(true);
    expect(r.confirmed).toBe(false);
    expect(r.offline).toBe(true);
  });
});
