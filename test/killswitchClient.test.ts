import { describe, it, expect } from "vitest";

import { KillSwitchClient } from "../src/killswitch/client";

/** Fake fetch capturing the requested URL and returning a scripted response.
 *  The client's fetch slot is constructor-injected, so no module mocking. */
function fakeFetch(opts: {
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
  reject?: boolean;
}) {
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(url);
    if (opts.reject) throw new TypeError("fetch failed: ECONNREFUSED");
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
        return opts.body;
      },
    };
  }) as never;
  return { f, seen };
}

const client = (f: never) => new KillSwitchClient("https://api.test", f);

describe("KillSwitchClient.checkOnce", () => {
  it("200 killed:false → serving allowed, not confirmed, not offline", async () => {
    const { f } = fakeFetch({ body: { killed: false } });
    const s = await client(f).checkOnce("2.1.161", "c1");
    expect(s).toMatchObject({ killed: false, confirmed: false, offline: false });
  });

  it("200 killed:true → killed AND confirmed (the restore-everything signal)", async () => {
    const { f } = fakeFetch({
      body: { killed: true, scope: "global", reason: "incident" } });
    const s = await client(f).checkOnce("2.1.161", "c1");
    expect(s).toMatchObject({
      killed: true, confirmed: true, offline: false,
      scope: "global", reason: "incident",
    });
  });

  it("coerces a truthy non-boolean killed field (hostile/loose backend JSON)", async () => {
    const { f } = fakeFetch({ body: { killed: 1 } });
    const s = await client(f).checkOnce("2.1.161", "c1");
    expect(s.killed).toBe(true);
    expect(s.confirmed).toBe(true);
  });

  it("non-2xx → fail-safe killed but UNCONFIRMED + offline (freeze, never restore)", async () => {
    const { f } = fakeFetch({ status: 503 });
    const s = await client(f).checkOnce("2.1.161", "c1");
    expect(s).toMatchObject({ killed: true, confirmed: false, offline: true });
    expect(s.reason).toBe("status 503");
  });

  it("network error → fail-safe killed, unconfirmed, offline", async () => {
    const { f } = fakeFetch({ reject: true });
    const s = await client(f).checkOnce("2.1.161", "c1");
    expect(s).toMatchObject({ killed: true, confirmed: false, offline: true });
    expect(s.reason).toContain("fail-safe");
  });

  it("malformed JSON body → fail-safe killed, unconfirmed, offline", async () => {
    // An HTML error page behind a 200 (proxy/captive portal) must not crash
    // the poll loop nor read as "not killed".
    const { f } = fakeFetch({ jsonThrows: true });
    const s = await client(f).checkOnce("2.1.161", "c1");
    expect(s).toMatchObject({ killed: true, confirmed: false, offline: true });
  });

  it("URL-encodes version and campaign query params", async () => {
    const { f, seen } = fakeFetch({ body: { killed: false } });
    await client(f).checkOnce("2.1.161 (Claude Code)", "camp&aign=x");
    expect(seen[0]).toBe(
      "https://api.test/v1/killswitch?version=2.1.161%20(Claude%20Code)"
      + "&campaign=camp%26aign%3Dx");
  });
});
