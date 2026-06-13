import { describe, it, expect, vi } from "vitest";
import { PortfolioClient, fetchPortfolioWithDemoFallback } from "../src/portfolio/client";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe("PortfolioClient", () => {
  it("maps S2's real flat shape into a PatchAd; caches with ttl", async () => {
    const fetchMock = vi.fn(async () => ok({
      ttl_seconds: 60,
      ads: [{ ad_id: "a1", campaign_id: "c1", seat: "c1", weight: 1,
              title_text: "Acme deploys faster than your CI now", icon_ref: "icon.a",
              click_url: "https://acme.test/x" }],
    }));
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const ad = await c.fetchAd("2.1.143");
    // `seat` in the wire payload above is ignored by the parser and absent
    // from the mapped ad (toEqual asserts the exact shape — no `seat` key).
    expect(ad).toEqual({ adId: "a1", campaignId: "c1",
      adText: "Acme deploys faster than your CI now", iconRef: "icon.a",
      iconUrl: "", clickUrl: "https://acme.test/x", bannerEnabled: false,
      sessionToken: "" });
  });

  it("banner_enabled:true in payload => bannerEnabled true", async () => {
    const fetchMock = vi.fn(async () => ok({
      ttl_seconds: 60,
      ads: [{ ad_id: "a2", campaign_id: "c2", seat: "c2", weight: 1,
              title_text: "Banner ad text", icon_ref: "icon.b",
              click_url: "https://banner.test/x", banner_enabled: true }],
    }));
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const ad = await c.fetchAd("2.1.143");
    expect(ad?.bannerEnabled).toBe(true);
  });

  it("banner_enabled absent in payload => bannerEnabled false", async () => {
    const fetchMock = vi.fn(async () => ok({
      ttl_seconds: 60,
      ads: [{ ad_id: "a3", campaign_id: "c3", seat: "c3", weight: 1,
              title_text: "No banner ad text", icon_ref: "icon.c",
              click_url: "https://nobanner.test/x" }],
    }));
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const ad = await c.fetchAd("2.1.143");
    expect(ad?.bannerEnabled).toBe(false);
  });

  it("empty ads -> null (valid: no patch)", async () => {
    const c = new PortfolioClient("http://b", () => "tok",
      (async () => ok({ ttl_seconds: 60, ads: [] })) as never);
    expect(await c.fetchAd("2.1.143")).toBeNull();
  });

  it("on fetch error serves last good ad until ttl, then null", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n === 1) return ok({ ttl_seconds: 0, ads: [{ ad_id: "a1", campaign_id: "c1",
        seat: "c1", weight: 1, title_text: "x".repeat(35), icon_ref: "i",
        click_url: "https://t/x" }] });
      throw new Error("network down");
    });
    const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    expect((await c.fetchAd("2.1.143"))?.adId).toBe("a1");   // primes cache
    // ttl_seconds:0 -> cache already expired, error -> null
    expect(await c.fetchAd("2.1.143")).toBeNull();
  });

  describe("fetchDemoPortfolio (signed-out preview)", () => {
    it("hits /v1/portfolio/demo with client_id and NO auth header, stamps demo:true", async () => {
      const calls: { url: string; init: any }[] = [];
      const fetchMock = vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        return ok({ ttl_seconds: 60, ads: [{ ad_id: "a1", campaign_id: "c1",
          seat: "c1", title_text: "x".repeat(35), icon_ref: "i",
          click_url: "https://t/x", session_token: "demo-tok" }] });
      });
      // token() returns a value, but fetchDemoPortfolio must NOT send it as auth.
      const c = new PortfolioClient("http://b", () => "tok", fetchMock as never);
      const r = await c.fetchDemoPortfolio("2.1.143", "dev-123");
      expect(calls[0].url).toBe(
        "http://b/v1/portfolio/demo?claude_code_version=2.1.143&client_id=dev-123");
      // No Authorization header on the public demo surface.
      expect(calls[0].init.headers.authorization).toBeUndefined();
      expect(r!.ads[0].demo).toBe(true);
      expect(r!.ads[0].sessionToken).toBe("demo-tok");
      expect(r!.ad?.demo).toBe(true);
    });

    it("real fetchPortfolio does NOT stamp demo", async () => {
      const c = new PortfolioClient("http://b", () => "tok",
        (async () => ok({ ttl_seconds: 60, ads: [{ ad_id: "a1", campaign_id: "c1",
          seat: "c1", title_text: "x".repeat(35), icon_ref: "i",
          click_url: "https://t/x" }] })) as never);
      const r = await c.fetchPortfolio("2.1.143");
      expect(r!.ads[0].demo).toBeUndefined();
    });
  });
});

describe("fetchPortfolioWithDemoFallback", () => {
  const real = (token: string) => ok({
    ttl_seconds: 60, ads: [{ ad_id: "real1", campaign_id: "c1", seat: "s",
      title_text: "x".repeat(35), icon_ref: "i", click_url: "https://r.test",
      session_token: token }],
  });
  const demo = ok({
    ttl_seconds: 60, ads: [{ ad_id: "demo1", campaign_id: "cd", seat: "s",
      title_text: "y".repeat(35), icon_ref: "i", click_url: "https://d.test",
      session_token: "demo-tok" }],
  });
  const empty = ok({ ttl_seconds: 60, ads: [] });
  // A non-2xx makes PortfolioClient.fetchPortfolio throw internally → null
  // (the "hard failure / 401" signal, distinct from a valid-but-empty 200).
  const fail = { ok: false, status: 401, json: async () => ({}) } as Response;

  function authStub(over: Partial<{ token: string | null; refresh: () => Promise<boolean> }> = {}) {
    return {
      accessToken: () => (("token" in over) ? over.token! : "tok"),
      clientId: () => "cid",
      refresh: over.refresh ?? (async () => false),
    };
  }

  it("signed in with a valid token → real portfolio (no refresh, no demo)", async () => {
    const refresh = vi.fn(async () => true);
    const fetchMock = vi.fn(async (_url: string) => real("real-tok"));
    const pc = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const r = await fetchPortfolioWithDemoFallback(pc, authStub({ token: "tok", refresh }), "v");
    expect(r!.ad?.adId).toBe("real1");
    expect(refresh).not.toHaveBeenCalled();          // valid token ⇒ no refresh
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/portfolio?"); // not demo
  });

  it("signed out (no token) → demo straight away, never refreshes", async () => {
    const refresh = vi.fn(async () => false);
    const fetchMock = vi.fn(async (_url: string) => demo);
    const pc = new PortfolioClient("http://b", () => null, fetchMock as never);
    const r = await fetchPortfolioWithDemoFallback(pc, authStub({ token: null, refresh }), "v");
    expect(r!.ad?.adId).toBe("demo1");
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/portfolio/demo");
  });

  it("signed in, EMPTY inventory (valid 200) → keep it, NO refresh, NO demo", async () => {
    // The critical guard: empty inventory must not be mistaken for a dead token.
    // Refreshing here could clear a valid session on a transient empty poll.
    const refresh = vi.fn(async () => true);
    const fetchMock = vi.fn(async (_url: string) => empty);
    const pc = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const r = await fetchPortfolioWithDemoFallback(pc, authStub({ token: "tok", refresh }), "v");
    expect(r!.ad).toBeNull();                         // empty portfolio preserved
    expect(refresh).not.toHaveBeenCalled();           // empty ≠ dead token
    expect(fetchMock).toHaveBeenCalledTimes(1);       // no demo fetch
  });

  it("dead token (real fetch hard-fails/401 → null, refresh fails) → demo fallback", async () => {
    let tok: string | null = "stale";
    const refresh = vi.fn(async () => { tok = null; return false; });
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/demo") ? demo : fail);          // real fetch → null
    const pc = new PortfolioClient("http://b", () => tok, fetchMock as never);
    const auth = { accessToken: () => tok, clientId: () => "cid", refresh };
    const r = await fetchPortfolioWithDemoFallback(pc, auth, "v");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r!.ad?.adId).toBe("demo1");               // demo fallback served
  });

  it("TRANSIENT refresh failure (token kept) → null, NO demo demotion (audit #10)", async () => {
    // Offline at activation: the real fetch throws, the forced refresh fails
    // TRANSIENTLY (network, not 401) — post-#10, refresh() keeps the access
    // token. The fallback must NOT demote the session to demo (demo metrics
    // credit no user); it serves nothing this tick and the next periodic
    // refresh retries. Pre-fix: any failed refresh routed straight to demo.
    const refresh = vi.fn(async () => false);        // token survives (transient)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/demo")) return demo;        // trap: wrong demotion
      throw new Error("ENOTFOUND");                  // real fetch: offline
    });
    const pc = new PortfolioClient("http://b", () => "tok", fetchMock as never);
    const r = await fetchPortfolioWithDemoFallback(pc, authStub({ token: "tok", refresh }), "v");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r).toBeNull();                            // nothing this tick — not demo
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/demo")))
      .toBe(false);                                  // demo endpoint never hit
  });

  it("dead-then-revived token (real hard-fails, refresh re-mints) → real portfolio", async () => {
    let tok: string | null = "stale";
    const refresh = vi.fn(async () => { tok = "fresh"; return true; });
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/demo") ? demo : (tok === "fresh" ? real("fresh-tok") : fail));
    const pc = new PortfolioClient("http://b", () => tok, fetchMock as never);
    const auth = { accessToken: () => tok, clientId: () => "cid", refresh };
    const r = await fetchPortfolioWithDemoFallback(pc, auth, "v");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r!.ad?.adId).toBe("real1");               // re-minted ⇒ real ads
  });
});
