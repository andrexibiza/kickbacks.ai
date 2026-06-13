/** Audit #7 (wave 3): ONE loopback server per extension host.
 *
 *  Pre-fix, every normal boot ran TWO loopbacks: the boot-canary debug
 *  apply() bound the persisted stable port P first and held it all session,
 *  so the production loopback EADDRINUSE'd onto P+1 and OVERWROTE the
 *  "stable" port — the persisted port crept +1 per session, and a stale
 *  webview from the prior session (whose patch baked port P) reconnected to
 *  the DEBUG server whose wiring drops demo billing and blinds the desync
 *  watchdog. bootLoopback() now shares the first successfully-bound server:
 *  later callers get the SAME port/token/base, and the production (primary)
 *  caller takes the routes over via a live handler swap. The /ad
 *  canServeAds gating (wave 2) lives in the HANDLER closures themselves
 *  (debug.ts / webviewInjection.ts), so it rides along with whichever
 *  handler set is live — pinned in servingGate.test.ts and debug.test.ts. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Loopback, type LoopbackHandlers } from "../src/loopback";
import { bootLoopback, resetSharedLoopbackForTest }
  from "../src/util/loopbackBoot";
import { makeContext } from "./mocks/vscode";

const PORT_KEY = "kickbacks.loopback.port";

function mkHandlers(tag: string, log: string[]): LoopbackHandlers {
  return {
    onEvent: (k) => log.push(`${tag}:${k}`),
    onClick: () => log.push(`${tag}:click`),
    getActivity: () => ({ tag }),
    getCurrentAd: () => ({ adText: `${tag}-ad`, clickUrl: "https://x.test",
      iconUrl: "", adId: tag, campaignId: tag }),
  };
}

let live: Loopback[] = [];
const track = (lb: Loopback): Loopback => { live.push(lb); return lb; };

beforeEach(() => { resetSharedLoopbackForTest(); });
afterEach(async () => {
  for (const lb of live) await lb.stop();
  live = [];
  resetSharedLoopbackForTest();
});

describe("bootLoopback shared server (audit #7)", () => {
  it("two sequential consumers get the SAME port and ONE server; the "
    + "production (primary) wiring takes over /ad from the debug stub", async () => {
    const ctx = makeContext();
    const log: string[] = [];
    // Boot order of a normal session: debug stub first (boot canary)…
    const debugLb = track(new Loopback(mkHandlers("debug", log)));
    const a = await bootLoopback(debugLb, ctx as never, { secondary: true });
    expect(a.port).toBeGreaterThan(0);
    // …then the production loopback. Pre-fix this EADDRINUSE'd onto port+1.
    const prodLb = track(new Loopback(mkHandlers("prod", log)));
    const b = await bootLoopback(prodLb, ctx as never);
    expect(b.port).toBe(a.port);
    expect(b.token).toBe(a.token);
    expect(b.base).toBe(a.base);
    // ONE server: production shares the debug-owned bind, no second listen.
    expect(debugLb.isRunning()).toBe(true);
    expect(prodLb.isRunning()).toBe(false);
    // The production handlers now serve the shared routes (the takeover):
    // a stale webview reconnecting to the stable port reaches PRODUCTION
    // wiring, not the debug stub.
    const ad = await (await fetch(`${b.base}/ad`)).json();
    expect(ad.adId).toBe("prod");
    await fetch(`${b.base}/view_tick?surface=overlay&visible_ms=5000`,
      { method: "POST" });
    expect(log).toContain("prod:view_tick");
    expect(log.filter((l) => l.startsWith("debug:"))).toEqual([]);
    // The persisted stable port was NOT overwritten with port+1.
    expect(ctx.globalState.get<number>(PORT_KEY)).toBe(a.port);
  });

  it("a later SECONDARY (debug) registrant never displaces the primary's "
    + "handlers — but still shares the port", async () => {
    const ctx = makeContext();
    const log: string[] = [];
    // K_ON=false boot: production boots first…
    const prodLb = track(new Loopback(mkHandlers("prod", log)));
    const a = await bootLoopback(prodLb, ctx as never);
    expect(a.port).toBeGreaterThan(0);
    // …then the user enables Kickbacks → debug apply() boots its stub.
    const debugLb = track(new Loopback(mkHandlers("debug", log)));
    const b = await bootLoopback(debugLb, ctx as never, { secondary: true });
    expect(b.port).toBe(a.port);
    expect(debugLb.isRunning()).toBe(false);
    // Production wiring (the billing authority) keeps the routes.
    const ad = await (await fetch(`${a.base}/ad`)).json();
    expect(ad.adId).toBe("prod");
  });

  it("restart simulation: the persisted stable port does NOT creep across "
    + "sessions (debug-then-production each session re-binds the SAME port)",
  async () => {
    const ctx = makeContext();   // ONE globalState across both "sessions"
    const log: string[] = [];
    // ── Session 1: normal boot order, both consumers.
    const s1debug = track(new Loopback(mkHandlers("debug", log)));
    const s1a = await bootLoopback(s1debug, ctx as never, { secondary: true });
    const s1prod = track(new Loopback(mkHandlers("prod", log)));
    const s1b = await bootLoopback(s1prod, ctx as never);
    const P = s1a.port;
    expect(P).toBeGreaterThan(0);
    expect(s1b.port).toBe(P);
    expect(ctx.globalState.get<number>(PORT_KEY)).toBe(P);
    // ── Host restart: server torn down, module state rebuilt.
    await s1debug.stop(); await s1prod.stop();
    resetSharedLoopbackForTest();
    // ── Session 2: same boot order against the SAME persisted state.
    const s2debug = track(new Loopback(mkHandlers("debug", log)));
    const s2a = await bootLoopback(s2debug, ctx as never, { secondary: true });
    const s2prod = track(new Loopback(mkHandlers("prod", log)));
    const s2b = await bootLoopback(s2prod, ctx as never);
    // Pre-fix: session 1 persisted P+1, so session 2 bound P+1 / P+2 — the
    // creep that broke last session's baked-in patch URL every reload.
    expect(s2a.port).toBe(P);
    expect(s2b.port).toBe(P);
    expect(ctx.globalState.get<number>(PORT_KEY)).toBe(P);
  });

  it("a stopped owner doesn't poison the share: the next consumer re-binds "
    + "fresh on the same stable port", async () => {
    const ctx = makeContext();
    const log: string[] = [];
    const lb1 = track(new Loopback(mkHandlers("one", log)));
    const a = await bootLoopback(lb1, ctx as never);
    expect(a.port).toBeGreaterThan(0);
    await lb1.stop();
    // The shared record now points at a dead server → fresh bind, not the
    // stale cached result.
    const lb2 = track(new Loopback(mkHandlers("two", log)));
    const b = await bootLoopback(lb2, ctx as never);
    expect(lb2.isRunning()).toBe(true);
    expect(b.port).toBe(a.port);   // preferred-port reuse, same stable port
    const ad = await (await fetch(`${b.base}/ad`)).json();
    expect(ad.adId).toBe("two");
  });
});
