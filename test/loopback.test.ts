import { describe, it, expect, afterEach } from "vitest";
import { Loopback } from "../src/loopback";

let lb: Loopback | null = null;
afterEach(async () => { if (lb) { await lb.stop(); lb = null; } });

describe("Loopback", () => {
  it("token-gated routes fire callbacks; bad token 404s", async () => {
    const events: string[] = [];
    let clicked = "";
    lb = new Loopback({
      onEvent: (k) => events.push(k),
      onClick: (ct) => { clicked = ct; },
      getActivity: () => ({ tool: "Bash", ts: 42 }),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;

    expect((await fetch(`${base}/impression_rendered`, { method: "POST" })).status).toBe(204);
    expect((await fetch(`${base}/click?ct=abc`, { method: "POST" })).status).toBe(204);
    const act = await (await fetch(`${base}/activity`)).json();
    expect(act).toEqual({ tool: "Bash", ts: 42 });
    expect(events).toContain("impression_rendered");
    expect(clicked).toBe("abc");

    const bad = await fetch(`http://127.0.0.1:${port}/vibe-ads/WRONG/activity`);
    expect(bad.status).toBe(404);
  });

  it("/click accepts the corr query param without regressing ct parsing", async () => {
    // Task 6 added `&corr=<id>` to the click ping; the route now also reads
    // url.searchParams.get("corr"). Guard that the extra param does not break
    // ct extraction / the 204 contract (the corr→dlog hop is covered by
    // log.test.ts + the live C-check).
    let clicked: string | null = null;
    lb = new Loopback({
      onEvent: () => {},
      onClick: (ct) => { clicked = ct; },
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;
    const r = await fetch(`${base}/click?ct=ck&corr=debug.973525`,
      { method: "POST" });
    expect(r.status).toBe(204);
    expect(clicked).toBe("ck");
    // corr-only (no ct) must still 204 and fire onClick with "" — never throw
    const r2 = await fetch(`${base}/click?corr=ad1.zz`, { method: "POST" });
    expect(r2.status).toBe(204);
    expect(clicked).toBe("");
  });

  it("/click relays event_uuid for end-to-end ledger tracing", async () => {
    let saw: { ct: string; eventUuid?: string } | null = null;
    lb = new Loopback({
      onEvent: () => {},
      onClick: (ct, _surface, _visibleMs, eventUuid) => {
        saw = { ct, eventUuid };
      },
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;
    const eventUuid = "123e4567-e89b-42d3-a456-426614174000";

    const r = await fetch(`${base}/click?ct=ck&event_uuid=${eventUuid}`,
      { method: "POST" });

    expect(r.status).toBe(204);
    expect(saw).toEqual({ ct: "ck", eventUuid });
  });

  it("/click extracts surface for all four product surfaces", async () => {
    // Surface attribution must reach the onClick callback verbatim across
    // every product line. A regression here (e.g. accepting only "overlay"
    // and silently dropping codex_overlay / statusline / banner) would
    // bucket all clicks under the CC default and break per-product
    // revenue reporting. Whitelist is in loopback.ts; this is its boundary
    // contract.
    const captured: Array<{ ct: string; surface?: string }> = [];
    lb = new Loopback({
      onEvent: () => {},
      onClick: (ct, surface) => { captured.push({ ct, surface }); },
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;
    for (const s of ["overlay", "banner", "codex_overlay", "statusline"]) {
      const r = await fetch(`${base}/click?ct=ck&corr=cx&surface=${s}`,
        { method: "POST" });
      expect(r.status).toBe(204);
    }
    expect(captured.map((c) => c.surface)).toEqual(
      ["overlay", "banner", "codex_overlay", "statusline"]);
    expect(captured.every((c) => c.ct === "ck")).toBe(true);
  });

  it("/click ignores an UNKNOWN surface value (defensive whitelist; never "
    + "blocks the click)", async () => {
    // The whitelist is server-authoritative — a client sending a typo or
    // an attacker-crafted surface must NOT inject a bogus attribution
    // label into the ledger. The click still bills (defensive: never lose
    // revenue over a label), but `surface` is undefined downstream.
    let saw: { ct: string; surface?: string } | null = null;
    lb = new Loopback({
      onEvent: () => {},
      onClick: (ct, surface) => { saw = { ct, surface }; },
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;
    const r = await fetch(`${base}/click?ct=ck&surface=javascript:alert(1)`,
      { method: "POST" });
    expect(r.status).toBe(204);
    expect(saw).not.toBeNull();
    expect((saw as unknown as { ct: string }).ct).toBe("ck");
    expect((saw as unknown as { surface?: string }).surface).toBeUndefined();
  });

  it("relays view tracking routes with visibility metadata", async () => {
    const seen: unknown[] = [];
    lb = new Loopback({
      onEvent: (k, payload) => { seen.push(k, payload); },
      onClick: () => {},
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;

    const r = await fetch(
      `${base}/view_threshold_met?surface=overlay&visible_ms=15100&session=session123&event_uuid=123e4567-e89b-42d3-a456-426614174000`,
      { method: "POST" },
    );

    expect(r.status).toBe(204);
    expect(seen).toEqual([
      "view_threshold_met",
      {
        surface: "overlay",
        visibleMs: 15100,
        sessionNonce: "session123",
        eventUuid: "123e4567-e89b-42d3-a456-426614174000",
        viewable: true,
        viewPct: 100,
        viewMs: 15100,
      },
    ]);
  });

  it("answers the CORS preflight so the vscode-webview origin can POST", async () => {
    lb = new Loopback({ onEvent: () => {}, onClick: () => {}, getActivity: () => ({}), getCurrentAd: () => null });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;

    // The block's dlog POST sends content-type: application/json, which makes
    // the webview fire an OPTIONS preflight first. It must succeed with ACAO.
    const pre = await fetch(`${base}/log`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect((pre.headers.get("access-control-allow-methods") || "")).toContain("POST");
    expect((pre.headers.get("access-control-allow-headers") || "").toLowerCase())
      .toContain("content-type");
  });

  it("every real response carries Access-Control-Allow-Origin", async () => {
    lb = new Loopback({
      onEvent: () => {}, onClick: () => {},
      getActivity: () => ({ tool: "Bash" }),
      getCurrentAd: () => null,
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;

    const act = await fetch(`${base}/activity`);
    expect(act.headers.get("access-control-allow-origin")).toBe("*");
    const imp = await fetch(`${base}/impression_rendered`, { method: "POST" });
    expect(imp.headers.get("access-control-allow-origin")).toBe("*");
    // even a 404 must carry it (a preflight to an unknown path still needs it)
    const miss = await fetch(`http://127.0.0.1:${port}/vibe-ads/WRONG/x`);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("start() is resilient and stop() is idempotent", async () => {
    lb = new Loopback({ onEvent: () => {}, onClick: () => {}, getActivity: () => ({}), getCurrentAd: () => null });
    const a = await lb.start();
    expect(a.port).toBeGreaterThan(0);
    await lb.stop(); await lb.stop(); // no throw
  });

  it("setHandlers live-swaps every route on the running server (audit #7 — "
    + "the shared-loopback takeover)", async () => {
    const seen: string[] = [];
    lb = new Loopback({
      onEvent: (k) => seen.push(`a:${k}`),
      onClick: () => seen.push("a:click"),
      getActivity: () => ({ who: "a" }),
      getCurrentAd: () => ({ adText: "a-ad", clickUrl: "https://a.test",
        iconUrl: "", adId: "a", campaignId: "a" }),
    });
    const { port, token } = await lb.start();
    const base = `http://127.0.0.1:${port}/vibe-ads/${token}`;
    expect((await (await fetch(`${base}/ad`)).json()).adId).toBe("a");
    lb.setHandlers({
      onEvent: (k) => seen.push(`b:${k}`),
      onClick: () => seen.push("b:click"),
      getActivity: () => ({ who: "b" }),
      getCurrentAd: () => ({ adText: "b-ad", clickUrl: "https://b.test",
        iconUrl: "", adId: "b", campaignId: "b" }),
    });
    // Same bound port + token; every route now dispatches to B.
    expect((await (await fetch(`${base}/ad`)).json()).adId).toBe("b");
    expect(await (await fetch(`${base}/activity`)).json())
      .toEqual({ who: "b" });
    expect((await fetch(`${base}/view_tick?surface=overlay`,
      { method: "POST" })).status).toBe(204);
    expect((await fetch(`${base}/click?ct=ck`, { method: "POST" })).status)
      .toBe(204);
    expect(seen).toContain("b:view_tick");
    expect(seen).toContain("b:click");
    expect(seen.filter((s) => s.startsWith("a:"))).toEqual([]);
  });

  it("isRunning() tracks bind state across start/stop (audit #7 — stale "
    + "shared-server detection)", async () => {
    lb = new Loopback({ onEvent: () => {}, onClick: () => {},
      getActivity: () => ({}), getCurrentAd: () => null });
    expect(lb.isRunning()).toBe(false);
    await lb.start();
    expect(lb.isRunning()).toBe(true);
    await lb.stop();
    expect(lb.isRunning()).toBe(false);
  });
});
