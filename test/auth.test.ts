import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the log module so these tests never touch the real debug log or
// read dev-machine sentinels / env vars that could flip assertions.
vi.mock("../src/log", () => ({ debugEnabled: () => false, dlog: () => {},
  dlogRaw: () => {}, codexEnabled: () => false, codexCliEnabled: () => false,
  LOG_PATH: "/tmp/test-log" }));

import { AuthClient } from "../src/auth/client";
import { createVault } from "../src/auth/vault";
import { makeContext, _opened, _shown } from "./mocks/vscode";

// Hermetic fallback file per test (never touch the real ~/.vibe-ads).
const mkAuthFile = () => join(mkdtempSync(join(tmpdir(), "vibe-ads-auth-")), "auth.json");
// Hermetic vault: an unknown platform => "plain" scheme, so seal/open never
// shell out (fixture-only rule). Per-OS behavior is covered by vault.test.ts.
const noExec = (async () => { throw new Error("no exec in tests"); }) as never;
const pv = () => createVault("test", noExec);

describe("AuthClient", () => {
  it("uses explicit dev-bypass as an in-memory token only for loopback bases", async () => {
    const oldKickbacks = process.env.KICKBACKS_DEV_BYPASS;
    const oldVibeAds = process.env.VIBE_ADS_DEV_BYPASS;
    process.env.VIBE_ADS_DEV_BYPASS = "1";
    delete process.env.KICKBACKS_DEV_BYPASS;
    const s = new Map<string, string>(), g = new Map<string, unknown>();
    const ctx = {
      secrets: { get: async (k: string) => s.get(k),
        store: async (k: string, v: string) => { s.set(k, v); },
        delete: async (k: string) => { s.delete(k); } },
      globalState: { get: (k: string) => g.get(k),
        update: async (k: string, v: unknown) => { g.set(k, v); } },
      subscriptions: [],
    };
    const f = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    try {
      const a = new AuthClient("http://127.0.0.1:6080", ctx as never,
        f as never, 0, mkAuthFile(), pv());
      await a.loadCached();
      expect(a.accessToken()).toBe("dev-bypass");
      expect(a.signedIn()).toBe(true);
      expect(await a.refresh()).toBe(true);
      expect(f).not.toHaveBeenCalled();
      expect(s.size).toBe(0);
    } finally {
      if (oldKickbacks === undefined) delete process.env.KICKBACKS_DEV_BYPASS;
      else process.env.KICKBACKS_DEV_BYPASS = oldKickbacks;
      if (oldVibeAds === undefined) delete process.env.VIBE_ADS_DEV_BYPASS;
      else process.env.VIBE_ADS_DEV_BYPASS = oldVibeAds;
    }
  });

  it("refuses dev-bypass when the backend base is not loopback", async () => {
    const old = process.env.VIBE_ADS_DEV_BYPASS;
    process.env.VIBE_ADS_DEV_BYPASS = "1";
    const s = new Map<string, string>(), g = new Map<string, unknown>();
    const ctx = {
      secrets: { get: async (k: string) => s.get(k),
        store: async (k: string, v: string) => { s.set(k, v); },
        delete: async (k: string) => { s.delete(k); } },
      globalState: { get: (k: string) => g.get(k),
        update: async (k: string, v: unknown) => { g.set(k, v); } },
      subscriptions: [],
    };
    try {
      const a = new AuthClient("https://api.kickbacks.ai", ctx as never,
        (async () => ({ ok: false, status: 500 }) as Response) as never,
        0, mkAuthFile(), pv());
      await a.loadCached();
      expect(a.accessToken()).toBeNull();
      expect(a.signedIn()).toBe(false);
    } finally {
      if (old === undefined) delete process.env.VIBE_ADS_DEV_BYPASS;
      else process.env.VIBE_ADS_DEV_BYPASS = old;
    }
  });

  it("signIn opens the broker URL then polls until tokens, stores in SecretStorage", async () => {
    const ctx = makeContext();
    let polls = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/extension/start"))
        return { status: 307,
          headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null },
        } as unknown as Response;
      polls++;
      if (polls < 2) return { ok: true, status: 200, json: async () => ({ status: "pending" }) } as Response;
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }) } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    await a.signIn();
    expect(_opened.some((u) => u.includes("https://g/auth"))).toBe(true);
    expect(await ctx.secrets.get("kickbacks.access")).toBe("AT");
    expect(await ctx.secrets.get("kickbacks.refresh")).toBe("RT");
    expect(a.accessToken()).toBe("AT");
    expect(a.signedIn()).toBe(true);
  });

  it("refresh swaps access AND persists the rotated refresh token", async () => {
    const ctx = makeContext();
    await ctx.secrets.store("kickbacks.refresh", "RT");
    const f = vi.fn(async (url: string) => {
      if (url.includes("/auth/refresh"))
        return { ok: true, status: 200, json: async () =>
          ({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }) } as Response;
      return { ok: false, status: 500 } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    expect(await a.refresh()).toBe(true);
    expect(a.accessToken()).toBe("AT2");
    expect(await ctx.secrets.get("kickbacks.refresh")).toBe("RT2"); // rotation persisted
  });

  it("single-flights concurrent refresh() calls so the rotating token is consumed once", async () => {
    // Two callers (status-bar earnings 401 + portfolio 401) racing on the
    // SAME refresh token used to double-POST /refresh; S1 rotates on first
    // use, so the second call sent a consumed token, 401'd, and nulled `at`
    // — clobbering the first call's success. Single-flight must collapse
    // them to ONE request.
    const s = new Map<string, string>(), g = new Map<string, unknown>();
    const ctx = {
      secrets: { get: async (k: string) => s.get(k),
        store: async (k: string, v: string) => { s.set(k, v); },
        delete: async (k: string) => { s.delete(k); } },
      globalState: { get: (k: string) => g.get(k),
        update: async (k: string, v: unknown) => { g.set(k, v); } },
      subscriptions: [],
    };
    await ctx.secrets.store("kickbacks.refresh", "RT");
    let calls = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/auth/refresh")) {
        calls++;
        return { ok: true, status: 200, json: async () =>
          ({ access_token: "AT2", refresh_token: "RT2" }) } as Response;
      }
      return { ok: false, status: 500 } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    const [r1, r2] = await Promise.all([a.refresh(), a.refresh()]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(calls).toBe(1);                 // one POST, not two
    expect(a.accessToken()).toBe("AT2");
  });

  it("refresh() recovers the token from the sealed file when SecretStorage is empty", async () => {
    // Reinstall / keyring-less: secrets holds nothing, but a prior signIn
    // sealed the token to the durable file. refresh() (called WITHOUT an
    // explicit token, e.g. via a 401 retry) must find it there.
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    const signInF = vi.fn(async (url: string) =>
      url.includes("/extension/start")
        ? { status: 307, headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response);
    const a1 = new AuthClient("http://b", isoCtx() as never, signInF as never, 0, file, pv());
    await a1.signIn();                      // seals plain:1:RT to `file`

    const refreshF = vi.fn(async (url: string) =>
      url.includes("/auth/refresh")
        ? { ok: true, status: 200, json: async () =>
            ({ access_token: "AT3", refresh_token: "RT3" }) } as Response
        : { ok: false, status: 500 } as Response);
    const a2 = new AuthClient("http://b", isoCtx() as never, refreshF as never, 0, file, pv());
    expect(await a2.refresh()).toBe(true);  // empty secrets -> file fallback
    expect(a2.accessToken()).toBe("AT3");
  });

  it("fires the onSignedIn login trigger after a successful interactive sign-in", async () => {
    const ctx = makeContext();
    let fired = 0;
    const f = vi.fn(async (url: string) =>
      url.includes("/extension/start")
        ? { status: 307, headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response);
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    a.setOnSignedIn(() => { fired++; });
    await a.signIn();
    expect(fired).toBe(1);                 // login trigger → immediate reassert
  });

  it("always-writes a sealed envelope to the file (the keyring-less Linux fix)", async () => {
    const file = mkAuthFile();
    const ctx = makeContext();
    const f = vi.fn(async (url: string) => {
      if (url.includes("/extension/start"))
        return { status: 307, headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response;
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT", refresh_token: "RT" }) } as Response;
    });
    const a = new AuthClient("http://b", ctx as never, f as never, 0, file, pv());
    await a.signIn();
    const fb = JSON.parse(readFileSync(file, "utf8"));
    expect(fb.refresh).toBe("plain:1:RT");        // sealed envelope, not bare token
    expect(fb.refresh).not.toBe("RT");
  });

  it("survives a reinstall: empty SecretStorage recovers via the sealed file", async () => {
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    const ctx1 = isoCtx();
    const f1 = vi.fn(async (url: string) => {
      if (url.includes("/extension/start"))
        return { status: 307, headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response;
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT", refresh_token: "RT" }) } as Response;
    });
    const a1 = new AuthClient("http://b", ctx1 as never, f1 as never, 0, file, pv());
    await a1.signIn();

    const ctx2 = isoCtx(); // brand-new namespace (= reinstall/rename)
    const f2 = vi.fn(async (url: string) => {
      if (url.includes("/auth/refresh"))
        return { ok: true, status: 200, json: async () =>
          ({ access_token: "AT-NEW", refresh_token: "RT2" }) } as Response;
      return { ok: false, status: 500 } as Response;
    });
    const a2 = new AuthClient("http://b", ctx2 as never, f2 as never, 0, file, pv());
    expect(a2.accessToken()).toBeNull();
    await a2.loadCached();
    expect(a2.accessToken()).toBe("AT-NEW");                 // no re-sign-in
  });

  it("upgrades a PRE-VAULT plaintext refresh token in place on first read", async () => {
    // Isolated ctx — makeContext() shares a module-global secrets Map, which
    // would leak a prior test's tokens and skip the file-recovery path.
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    // Simulate an older build's file: bare token, no envelope prefix.
    const seed = new AuthClient("http://b", isoCtx() as never, (async () => ({})) as never, 0, file, pv());
    const cid = seed.clientId();
    require("node:fs").writeFileSync(file,
      JSON.stringify({ refresh: "LEGACY-RT", clientId: cid }));
    const f = vi.fn(async (url: string) =>
      url.includes("/auth/refresh")
        ? { ok: true, status: 200, json: async () =>
            ({ access_token: "AT", refresh_token: "RT2" }) } as Response
        : { ok: false, status: 500 } as Response);
    const a = new AuthClient("http://b", isoCtx() as never, f as never, 0, file, pv());
    await a.loadCached();
    expect(a.accessToken()).toBe("AT");                       // legacy token still worked
    const fb = JSON.parse(readFileSync(file, "utf8"));
    expect(fb.refresh.startsWith("plain:1:")).toBe(true);     // re-sealed (upgraded)
  });

  it("signOut clears all stores incl. the OS vault entry; no silent re-mint", async () => {
    const isoCtx = () => {
      const s = new Map<string, string>(), g = new Map<string, unknown>();
      return {
        secrets: { get: async (k: string) => s.get(k),
          store: async (k: string, v: string) => { s.set(k, v); },
          delete: async (k: string) => { s.delete(k); } },
        globalState: { get: (k: string) => g.get(k),
          update: async (k: string, v: unknown) => { g.set(k, v); } },
        subscriptions: [],
      };
    };
    const file = mkAuthFile();
    const vault = pv();
    const clearSpy = vi.spyOn(vault, "clear");
    const ctx1 = isoCtx();
    const f1 = vi.fn(async (url: string) =>
      url.includes("/extension/start")
        ? { status: 307, headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response);
    const a1 = new AuthClient("http://b", ctx1 as never, f1 as never, 0, file, vault);
    await a1.signIn();
    const id1 = a1.clientId();
    expect(a1.signedIn()).toBe(true);

    await a1.signOut();
    expect(a1.signedIn()).toBe(false);
    expect(a1.accessToken()).toBeNull();
    expect(clearSpy).toHaveBeenCalled();                      // OS-store entry purged
    expect(JSON.parse(readFileSync(file, "utf8")).refresh).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8")).clientId).toBe(id1); // anon id kept

    const ctx2 = isoCtx(); // reinstall after sign-out MUST stay signed out
    const a2 = new AuthClient("http://b", ctx2 as never,
      (async () => ({ ok: false, status: 500 })) as never, 0, file, pv());
    await a2.loadCached();
    expect(a2.accessToken()).toBeNull();
    expect(a2.clientId()).toBe(id1);
  });

  // BL-188: sign-out must also revoke the rotating refresh token SERVER-side
  // — pre-fix it stayed mintable for its full TTL after a client-local clear.
  it("signOut posts the refresh token to /v1/auth/signout for revocation", async () => {
    const file = mkAuthFile();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.includes("/extension/start")
        ? { status: 307, headers: { get: (k: string) =>
            k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response
        : { ok: true, status: 200,
            json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response;
    });
    const a = new AuthClient("http://b", makeContext() as never, f as never, 0, file, pv());
    await a.signIn();
    await a.signOut();
    const revoke = calls.find((c) => c.url.includes("/v1/auth/signout"));
    expect(revoke).toBeTruthy();
    expect(revoke!.init?.method).toBe("POST");
    expect(String(revoke!.init?.body)).toContain("RT");   // the stored token
    expect(a.signedIn()).toBe(false);                     // local clear intact
  });

  it("signOut still completes (and clears locally) when revocation fails", async () => {
    const file = mkAuthFile();
    const f = vi.fn(async (url: string) => {
      if (url.includes("/extension/start")) {
        return { status: 307, headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response;
      }
      if (url.includes("/v1/auth/signout")) {
        throw new Error("offline");                       // revocation refused
      }
      return { ok: true, status: 200,
        json: async () => ({ access_token: "AT", refresh_token: "RT" }) } as Response;
    });
    const a = new AuthClient("http://b", makeContext() as never, f as never, 0, file, pv());
    await a.signIn();
    await a.signOut();                                    // must not throw
    expect(a.signedIn()).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).refresh).toBeUndefined();
  });

  it("clientId is a stable persisted anon id (survives a fresh ctx via file)", async () => {
    const file = mkAuthFile();
    const a1 = new AuthClient("http://b", makeContext() as never, (async () => ({})) as never, 0, file, pv());
    const id1 = a1.clientId();
    expect(id1.length).toBeGreaterThanOrEqual(16);
    const a2 = new AuthClient("http://b", makeContext() as never, (async () => ({})) as never, 0, file, pv());
    expect(a2.clientId()).toBe(id1);
  });

  it("storageInfo reports the active scheme + keyring health", async () => {
    const ctx = makeContext();
    const a = new AuthClient("http://b", ctx as never,
      (async () => ({ ok: true, status: 200, json: async () => ({ access_token: "AT", refresh_token: "RT" }) })) as never,
      0, mkAuthFile(), pv());
    expect(a.storageInfo().scheme).toBe("plain");
    expect(a.storageInfo().keyringDurable).toBeUndefined();    // not probed yet
  });
});

// audit BL-015 (wave-2A H1 coverage): a refresh() failure must clear the
// in-memory access token so signedIn() flips to false at the right moment.
// Pre-fix a dead token lingered until explicit signOut() and every backend
// call 401'd while signedIn() still reported true.
describe("AuthClient refresh failure clears session (H1)", () => {
  it("H1: refresh() with no stored token clears in-memory `at`", async () => {
    vi.resetModules();
    vi.doMock("../src/log", () => ({ debugEnabled: () => false, dlog: () => {},
      dlogRaw: () => {}, codexEnabled: () => false,
      LOG_PATH: "/tmp/t" }));
    const { AuthClient: AC } = await import("../src/auth/client");
    const ctx = makeContext();
    // Seed with a "dead" access token (no refresh token in storage).
    await ctx.secrets.store("kickbacks.access", "DEAD");
    const a = new AC("http://localhost:6080", ctx as never,
      (async () => ({ ok: false, status: 401 })) as never,
      0, mkAuthFile(), pv());
    await a.loadCached();                       // pulls DEAD into this.at
    expect(a.accessToken()).toBe("DEAD");       // pre-fix behavior persists
    const refreshed = await a.refresh();         // no refresh token -> false
    expect(refreshed).toBe(false);
    // Post-fix: at is cleared, so signedIn() flips to false.
    expect(a.accessToken()).toBeNull();
    expect(a.signedIn()).toBe(false);
    vi.doUnmock("../src/log");
    vi.resetModules();
  });
});

// Shared isolated ctx for the audit-fix suites below (makeContext shares a
// module-global secrets Map; these need a clean per-test namespace).
const isoCtx = () => {
  const s = new Map<string, string>(), g = new Map<string, unknown>();
  return {
    secrets: { get: async (k: string) => s.get(k),
      store: async (k: string, v: string) => { s.set(k, v); },
      delete: async (k: string) => { s.delete(k); } },
    globalState: { get: (k: string) => g.get(k),
      update: async (k: string, v: unknown) => { g.set(k, v); } },
    subscriptions: [],
  };
};
// Locked/absent Secret Service (keyring-less Linux): get works, store THROWS
// — the env the file fallback exists for. `seed` pre-populates the cache.
const lockedCtx = (seed?: [string, string][]) => {
  const s = new Map<string, string>(seed), g = new Map<string, unknown>();
  return {
    secrets: { get: async (k: string) => s.get(k),
      store: async () => {
        throw new Error("Cannot create an item in a locked collection"); },
      delete: async (k: string) => { s.delete(k); } },
    globalState: { get: (k: string) => g.get(k),
      update: async (k: string, v: unknown) => { g.set(k, v); } },
    subscriptions: [],
  };
};

// audit 2026-06-09 #11: ctx.secrets.store() is best-effort — a throwing
// keyring must not abort activation (loadCached) nor turn a server-side-
// successful refresh into a sign-out after the rotating token was consumed.
describe("AuthClient keyring store failures are best-effort (#11)", () => {
  it("loadCached survives a throwing keyring store and still re-mints from the file", async () => {
    const file = mkAuthFile();
    writeFileSync(file, JSON.stringify({ refresh: "plain:1:RT", clientId: "cid11" }));
    const f = vi.fn(async (url: string) =>
      url.includes("/auth/refresh")
        ? { ok: true, status: 200, json: async () =>
            ({ access_token: "AT", refresh_token: "RT2" }) } as Response
        : { ok: false, status: 500 } as Response);
    const a = new AuthClient("http://b", lockedCtx() as never, f as never, 0, file, pv());
    await a.loadCached();           // pre-fix: REJECTED at the re-warm store()
    expect(a.accessToken()).toBe("AT");
    expect(a.signedIn()).toBe(true);
    // The rotated token still landed in the durable file (sealToFile).
    expect(JSON.parse(readFileSync(file, "utf8")).refresh).toBe("plain:1:RT2");
  });

  it("a successful rotation with a dead keyring still counts as success", async () => {
    const file = mkAuthFile();
    const f = vi.fn(async (url: string) =>
      url.includes("/auth/refresh")
        ? { ok: true, status: 200, json: async () =>
            ({ access_token: "AT2", refresh_token: "RT2" }) } as Response
        : { ok: false, status: 500 } as Response);
    const a = new AuthClient("http://b",
      lockedCtx([["kickbacks.refresh", "RT"]]) as never, f as never, 0, file, pv());
    expect(await a.refresh()).toBe(true);     // pre-fix: false (store threw)
    expect(a.accessToken()).toBe("AT2");
    expect(JSON.parse(readFileSync(file, "utf8")).refresh).toBe("plain:1:RT2");
    expect(a.storageInfo().keyringDurable).toBe(false); // probe sees dead keyring
  });
});

// audit 2026-06-09 #37: interactive sign-in is single-flighted, and a still-
// running poll loop exits silently if sign-in arrived via another path.
describe("AuthClient interactive sign-in single-flight (#37)", () => {
  it("concurrent signIn() calls coalesce onto ONE state + browser tab + poll loop", async () => {
    const openedBefore = _opened.length;
    let starts = 0, polls = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/extension/start")) {
        starts++;
        return { status: 307, headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response;
      }
      polls++;
      if (polls < 2) return { ok: true, status: 200, json: async () => ({ status: "pending" }) } as Response;
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT", refresh_token: "RT" }) } as Response;
    });
    const a = new AuthClient("http://b", isoCtx() as never, f as never, 0, mkAuthFile(), pv());
    const [r1, r2] = await Promise.all([a.signIn(), a.signIn()]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(starts).toBe(1);                        // pre-fix: 2 parallel flows
    expect(_opened.length - openedBefore).toBe(1); // one browser tab, not two
  });

  it("a still-polling loop exits silently (no error toast) once signed in via another path", async () => {
    const shownBefore = _shown.length;
    let polls = 0;
    let client: AuthClient | undefined;
    const f = vi.fn(async (url: string) => {
      if (url.includes("/extension/start"))
        return { status: 307, headers: { get: (k: string) =>
          k.toLowerCase() === "location" ? "https://g/auth?state=S1" : null } } as unknown as Response;
      if (url.includes("/auth/refresh"))
        return { ok: true, status: 200, json: async () =>
          ({ access_token: "AT-R", refresh_token: "RT2" }) } as Response;
      polls++;                       // poll endpoint: this state NEVER completes
      if (polls === 2) await client?.refresh("RT"); // background path signs us in
      return { ok: true, status: 200, json: async () => ({ status: "pending" }) } as Response;
    });
    client = new AuthClient("http://b", isoCtx() as never, f as never, 0, mkAuthFile(), pv());
    expect(await client.signIn()).toBe(true); // pre-fix: false after 120 polls
    expect(polls).toBeLessThan(120);          // pre-fix: full 3-minute loop
    expect(client.accessToken()).toBe("AT-R");
    // No "sign-in timed out" toast minutes after the user already signed in.
    expect(_shown.slice(shownBefore).filter((m) => m.kind === "error")).toEqual([]);
  });
});

// audit 2026-06-09 #33: clientId() runs on EVERY metrics send; it must not
// read-merge-write auth.json unless the id is actually missing there — the
// unconditional RMW could resurrect a refresh envelope another window had
// just rotated (single-use token => clobber = sign-out).
describe("AuthClient clientId() write discipline (#33)", () => {
  it("does NOT rewrite auth.json when the id is already on disk", async () => {
    const file = mkAuthFile();
    const a1 = new AuthClient("http://b", isoCtx() as never, (async () => ({})) as never, 0, file, pv());
    const id = a1.clientId();                 // first call creates the file
    utimesSync(file, 1, 1);                   // sentinel mtime
    const stamp = statSync(file).mtimeMs;
    expect(a1.clientId()).toBe(id);           // warm path (globalState hit)
    const a2 = new AuthClient("http://b", isoCtx() as never, (async () => ({})) as never, 0, file, pv());
    expect(a2.clientId()).toBe(id);           // cold path (id read FROM file)
    // pre-fix: both calls unconditionally rewrote the file (mtime moves).
    expect(statSync(file).mtimeMs).toBe(stamp);
  });

  it("a needed write merges with the on-disk token envelope, never clobbers it", async () => {
    const file = mkAuthFile();
    // Another window just sealed a rotated token; this window has no id yet.
    writeFileSync(file, JSON.stringify({ refresh: "plain:1:ROTATED" }));
    const a = new AuthClient("http://b", isoCtx() as never, (async () => ({})) as never, 0, file, pv());
    const id = a.clientId();                  // must write (id missing on disk)
    const fb = JSON.parse(readFileSync(file, "utf8"));
    expect(fb.clientId).toBe(id);
    expect(fb.refresh).toBe("plain:1:ROTATED"); // envelope preserved
  });
});

// audit 2026-06-09 #10: only an EXPLICIT server rejection may discard tokens.
// Pre-fix, _refresh's catch (and every !ok status) nulled `at` — a pure
// network blip during the activation-time forced refresh permanently signed
// the user out in-memory (demo demotion, user-credit loss) with no retry path.
describe("AuthClient refresh transient-vs-fatal (#10)", () => {
  // Signed-in client with AT0 in memory and RT in secrets; `f` is swappable.
  const mkSignedIn = async (f: (url: string) => Promise<unknown>) => {
    const ctx = isoCtx();
    await ctx.secrets.store("kickbacks.access", "AT0");
    await ctx.secrets.store("kickbacks.refresh", "RT");
    const a = new AuthClient("http://b", ctx as never, f as never, 0, mkAuthFile(), pv());
    await a.loadCached();
    expect(a.accessToken()).toBe("AT0");
    return a;
  };

  it("a NETWORK throw keeps the tokens; a later refresh() succeeds", async () => {
    let online = false;
    const a = await mkSignedIn(async (url: string) => {
      if (!url.includes("/auth/refresh")) return { ok: false, status: 500 };
      if (!online) throw new Error("ENOTFOUND");   // Wi-Fi not up yet
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT2", refresh_token: "RT2" }) };
    });
    expect(await a.refresh()).toBe(false);   // transient failure reported...
    expect(a.accessToken()).toBe("AT0");     // ...but session NOT discarded
    expect(a.signedIn()).toBe(true);         // pre-fix: false forever
    online = true;                           // network returns minutes later
    expect(await a.refresh()).toBe(true);    // retry path works
    expect(a.accessToken()).toBe("AT2");
  });

  it("a 5xx is transient: tokens kept", async () => {
    const a = await mkSignedIn(async () => ({ ok: false, status: 503 }));
    expect(await a.refresh()).toBe(false);
    expect(a.accessToken()).toBe("AT0");     // pre-fix: nulled on any !ok
    expect(a.signedIn()).toBe(true);
  });

  it("an explicit 401 still clears the session (H1 contract preserved)", async () => {
    const a = await mkSignedIn(async () => ({ ok: false, status: 401 }));
    expect(await a.refresh()).toBe(false);
    expect(a.accessToken()).toBeNull();      // explicit rejection => signed out
    expect(a.signedIn()).toBe(false);
  });

  it("a 400 with an invalid_grant-style body is an explicit rejection", async () => {
    const a = await mkSignedIn(async () => ({ ok: false, status: 400,
      clone: () => ({ text: async () => '{"detail":"invalid_grant"}' }) }));
    expect(await a.refresh()).toBe(false);
    expect(a.accessToken()).toBeNull();
  });

  it("a 4xx WITHOUT a rejection body (gateway noise) is transient", async () => {
    const a = await mkSignedIn(async () => ({ ok: false, status: 429,
      clone: () => ({ text: async () => "rate limited" }) }));
    expect(await a.refresh()).toBe(false);
    expect(a.accessToken()).toBe("AT0");
  });
});
