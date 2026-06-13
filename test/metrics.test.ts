import { describe, it, expect, vi } from "vitest";
import { MetricsClient, noteMetricsSignOut } from "../src/metrics/client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("MetricsClient", () => {
  it("POSTs a well-formed metrics_event with a fresh UUID nonce + auth", async () => {
    const calls: { url: string; body: any; hdr: any }[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), hdr: init.headers });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("click", { adId: "a1", campaignId: "c1", ccVersion: "2.1.143" });
    await c.send("click", { adId: "a1", campaignId: "c1", ccVersion: "2.1.143" });
    expect(calls[0].url).toBe("http://b/v1/metrics");
    const b = calls[0].body;
    expect(b).toMatchObject({ event_type: "click", ad_id: "a1", campaign_id: "c1",
      client_id: "cid", claude_code_version: "2.1.143", extension_version: "0.1.0" });
    expect(typeof b.ts).toBe("string");
    expect(b.nonce).toMatch(UUID_RE);
    expect(calls[0].body.nonce).not.toBe(calls[1].body.nonce); // fresh per event
    expect(calls[0].hdr.authorization).toBe("Bearer tok");
  });
  it("includes the client-env fingerprint in body.ext when configured", async () => {
    const calls: { body: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    const env = { os: "win32", arch: "x64", os_version: "10.0.26200",
      editor: "Visual Studio Code" };
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0",
      f as never, env);
    await c.send("click", { adId: "a1", campaignId: "c1", ccVersion: "2.1.143" });
    expect(calls[0].body.ext).toEqual(env);
  });
  it("omits body.ext when no client-env is configured", async () => {
    const calls: { body: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("click", { adId: "a1", campaignId: "c1", ccVersion: "2.1.143" });
    expect("ext" in calls[0].body).toBe(false);
  });
  it("uses an explicit event UUID as the transmitted nonce", async () => {
    const calls: { body: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    const eventUuid = "123e4567-e89b-42d3-a456-426614174000";
    await c.send("click", {
      adId: "a1",
      campaignId: "c1",
      ccVersion: "2.1.143",
      eventUuid,
    });

    expect(calls[0].body.nonce).toBe(eventUuid);
  });
  it("sends X-Vibe-Corr only when corr is provided", async () => {
    const calls: { hdr: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ hdr: init.headers });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("click", { adId: "a", campaignId: "c", ccVersion: "v",
      corr: "a.r3nd" });
    await c.send("click", { adId: "a", campaignId: "c", ccVersion: "v" }); // no corr
    expect(calls[0].hdr["X-Vibe-Corr"]).toBe("a.r3nd");
    expect(calls[0].hdr.authorization).toBe("Bearer tok"); // existing hdrs intact
    expect(calls[0].hdr["content-type"]).toBe("application/json");
    expect("X-Vibe-Corr" in calls[1].hdr).toBe(false); // omitted when absent
  });
  it("sends view threshold fields for billable view tracking", async () => {
    const calls: { body: any }[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("view_threshold_met", {
      adId: "a",
      campaignId: "c",
      ccVersion: "v",
      surface: "overlay",
      visibleMs: 15100,
      sessionNonce: "session123",
      viewable: true,
      viewPct: 100,
      viewMs: 15100,
    });

    expect(calls[0].body).toMatchObject({
      event_type: "view_threshold_met",
      surface: "overlay",
      visible_ms: 15100,
      session_nonce: "session123",
      viewable: true,
      view_pct: 100,
      view_ms: 15100,
    });
  });
  it("never throws on network failure", async () => {
    const c = new MetricsClient("http://b", () => null, () => "cid", "0.1.0",
      (async () => { throw new Error("down"); }) as never);
    await expect(c.send("impression_rendered",
      { adId: "a", campaignId: "c", ccVersion: "v" })).resolves.toBeUndefined();
  });

  it("routes a tokenless (signed-out demo) send to /v1/metrics/demo with NO auth", async () => {
    const calls: { url: string; hdr: any; body: any }[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      calls.push({ url, hdr: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    // token() => null ⇒ signed out ⇒ demo routing.
    const c = new MetricsClient("http://b", () => null, () => "cid", "0.1.0", f as never);
    await c.send("view_threshold_met", { adId: "a", campaignId: "c", ccVersion: "v",
      sessionToken: "demo-tok" });
    expect(calls[0].url).toBe("http://b/v1/metrics/demo");
    expect("authorization" in calls[0].hdr).toBe(false);     // public endpoint
    expect(calls[0].body.client_id).toBe("cid");             // demo identity anchor
    expect(calls[0].body.session_token).toBe("demo-tok");
  });

  it("routes a signed-in send to /v1/metrics with the bearer (unchanged)", async () => {
    const calls: { url: string; hdr: any }[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      calls.push({ url, hdr: init.headers });
      return { ok: true, status: 200 } as Response;
    });
    const c = new MetricsClient("http://b", () => "tok", () => "cid", "0.1.0", f as never);
    await c.send("view_threshold_met", { adId: "a", campaignId: "c", ccVersion: "v" });
    expect(calls[0].url).toBe("http://b/v1/metrics");
    expect(calls[0].hdr.authorization).toBe("Bearer tok");
  });
});

// ---------------------------------------------------------------------------
// Audit #25: a mid-session token death silently demotes sends to
// /v1/metrics/demo with REAL ad ids. Demoted sends must stay distinguishable:
// every demo-route send is stamped ext.demo, and a was-signed-in (demoted)
// send additionally carries ext.demoted. The stamp rides inside `ext` — the
// only schema-allowed free-form field (the backend 400s unknown top-level
// keys, see backend/app/ads/router.py::_validate_metric_contract).
// ---------------------------------------------------------------------------
describe("demo-route demotion stamping", () => {
  const capture = () => {
    const calls: { url: string; body: any }[] = [];
    const f = vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });
    return { calls, f };
  };

  it("stamps ext.demoted when a previously-authed client loses its token mid-session", async () => {
    const { calls, f } = capture();
    let tok: string | null = "tok";
    const c = new MetricsClient("http://b", () => tok, () => "cid", "0.1.0", f as never);
    await c.send("view_tick", { adId: "real-ad", campaignId: "c1", ccVersion: "v" });
    tok = null; // mid-session token death (refresh rejected / nulled)
    await c.send("view_tick", { adId: "real-ad", campaignId: "c1", ccVersion: "v" });
    expect(calls[0].url).toBe("http://b/v1/metrics");
    expect("ext" in calls[0].body).toBe(false);     // authed send unchanged
    expect(calls[1].url).toBe("http://b/v1/metrics/demo");
    expect(calls[1].body.ext).toMatchObject({ demo: true, demoted: true });
  });

  it("stamps ext.demo (but NOT demoted) on never-authed signed-out demo sends", async () => {
    const { calls, f } = capture();
    const c = new MetricsClient("http://b", () => null, () => "cid", "0.1.0", f as never);
    await c.send("view_tick", { adId: "a", campaignId: "c", ccVersion: "v" });
    expect(calls[0].url).toBe("http://b/v1/metrics/demo");
    expect(calls[0].body.ext.demo).toBe(true);
    expect("demoted" in calls[0].body.ext).toBe(false);
  });

  it("does NOT stamp demoted after a deliberate sign-out (noteMetricsSignOut)", async () => {
    const { calls, f } = capture();
    let tok: string | null = "tok";
    const c = new MetricsClient("http://b", () => tok, () => "cid", "0.1.0", f as never);
    await c.send("view_tick", { adId: "a", campaignId: "c", ccVersion: "v" });
    tok = null;
    noteMetricsSignOut(); // cmdSignOut resets the demotion tracking
    await c.send("view_tick", { adId: "a", campaignId: "c", ccVersion: "v" });
    expect(calls[1].url).toBe("http://b/v1/metrics/demo");
    expect(calls[1].body.ext.demo).toBe(true);
    expect("demoted" in calls[1].body.ext).toBe(false);
  });

  it("merges the demo stamp with the client-env fingerprint without mutating it", async () => {
    const { calls, f } = capture();
    const env = { os: "win32", arch: "x64" };
    let tok: string | null = "tok";
    const c = new MetricsClient("http://b", () => tok, () => "cid", "0.1.0",
      f as never, env);
    await c.send("click", { adId: "a", campaignId: "c", ccVersion: "v" });
    tok = null;
    await c.send("click", { adId: "a", campaignId: "c", ccVersion: "v" });
    expect(calls[0].body.ext).toEqual(env); // authed: fingerprint untouched
    expect(calls[1].body.ext).toEqual(
      { os: "win32", arch: "x64", demo: true, demoted: true });
    expect(env).toEqual({ os: "win32", arch: "x64" }); // source not mutated
  });

  it("a recovered token routes authed again with no demo stamp", async () => {
    const { calls, f } = capture();
    let tok: string | null = "tok";
    const c = new MetricsClient("http://b", () => tok, () => "cid", "0.1.0", f as never);
    await c.send("view_tick", { adId: "a", campaignId: "c", ccVersion: "v" });
    tok = null;
    await c.send("view_tick", { adId: "a", campaignId: "c", ccVersion: "v" });
    tok = "tok2"; // refresh recovered mid-session
    await c.send("view_tick", { adId: "a", campaignId: "c", ccVersion: "v" });
    expect(calls[2].url).toBe("http://b/v1/metrics");
    expect("ext" in calls[2].body).toBe(false);
  });
});
