import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { UpdateClient, _vsixUrlAllowed } from "../src/update/client";

// wave-2A-F01 introduces a 10 KiB minimum-size sanity for the VSIX bytes
// (rejects empty / garbage / CDN-stub downloads). Use a 12 KiB filler.
const bytes = Buffer.alloc(12 * 1024, 0x42); // 12288 bytes of "B"
const sha = createHash("sha256").update(bytes).digest("hex");

describe("UpdateClient", () => {
  it("installs when manifest version is newer and sha256 matches", async () => {
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/ext/manifest"))
        return { ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
          url: "http://b/v1/ext/vibe-ads.vsix" }) } as Response;
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } as Response;
    });
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (buf) => { installed.push(Buffer.from(buf)); });
    expect(await c.checkOnce()).toBe(true);
    expect(installed).toHaveLength(1);
  });
  it("aborts on sha256 mismatch (no install)", async () => {
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: "deadbeef",
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } as Response));
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); });
    expect(await c.checkOnce()).toBe(false);
    expect(installed).toHaveLength(0);
  });
  // trey-nag-loop 2026-06-11: the attempted slot is cooldown-bounded so a
  // FAILED install can retry — but that let a SUCCESSFUL install re-run
  // every time the cooldown expired (re-download + re-install + re-toast
  // every ~31 min until the user reloaded). A success record suppresses the
  // artifact independent of any cooldown.
  it("success record: an installed artifact is never re-attempted, even when attempted() no longer fences", async () => {
    const installed: Buffer[] = [];
    let slot: string | undefined;
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response));
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); },
      { // attempted() always false = the 30-min cooldown has expired
        attempted: () => false, markAttempted: () => {},
        installed: (v, s) => slot === `${v}@${s}`,
        markInstalled: (v, s) => { slot = `${v}@${s}`; } });
    expect(await c.checkOnce()).toBe(true);    // installs, records success
    expect(installed).toHaveLength(1);
    expect(await c.checkOnce()).toBe(false);   // suppressed by success record
    expect(installed).toHaveLength(1);         // pre-fix: re-installed here
  });

  it("success record: a THROWING install is NOT recorded (cooldown retry stays possible)", async () => {
    const markInstalled = vi.fn();
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response));
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async () => { throw new Error("installExtension failed"); },
      { attempted: () => false, markAttempted: () => {},
        installed: () => false, markInstalled });
    expect(await c.checkOnce()).toBe(false);
    expect(markInstalled).not.toHaveBeenCalled();
  });

  it("attempts a given version AT MOST ONCE (restart-loop guard)", async () => {
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response));
    let mark: string | undefined;
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); },
      { attempted: (v) => v === mark, markAttempted: (v) => { mark = v; } });
    expect(await c.checkOnce()).toBe(true);   // first: installs, marks 0.2.0
    expect(installed).toHaveLength(1);
    expect(await c.checkOnce()).toBe(false);  // second: already attempted -> skip
    expect(installed).toHaveLength(1);        // NO re-install -> no restart loop
  });

  // audit-2026-06-09 #31: the attempt fence is only written AFTER the
  // download, so without a single-flight guard an overlapping 90s poll
  // (slow VSIX download) double-downloads and double-installs the same
  // artifact. The overlapping call must return false WITHOUT fetching.
  it("single-flight: an overlapping checkOnce neither downloads nor installs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const installed: Buffer[] = [];
    let vsixFetches = 0;
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/manifest"))
        return { ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
          url: "http://b/x.vsix" }) } as Response;
      vsixFetches++;
      await gate;                              // download outlives the next poll
      return { ok: true, arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
      } as Response;
    });
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); });
    const first = c.checkOnce();
    // Let the first call pass the manifest fetch and park on the download.
    await new Promise((r) => setTimeout(r, 10));
    const second = c.checkOnce();              // the overlapping 90s tick
    await new Promise((r) => setTimeout(r, 10));
    // Pre-fix the second poll started its own VSIX download here.
    expect(vsixFetches).toBe(1);
    release();
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(installed).toHaveLength(1);         // exactly one install
  });

  it("no-op when manifest version is not newer", async () => {
    const c = new UpdateClient("http://b", "0.2.0",
      (async () => ({ ok: true, json: async () =>
        ({ version: "0.2.0", sha256: "x", url: "y" }) })) as never,
      async () => { throw new Error("should not install"); });
    expect(await c.checkOnce()).toBe(false);
  });

  // wave-2A-F01 regression: VSIX size sanity + signature flag
  it("aborts when VSIX bytes are below the minimum-size sanity (10 KiB)", async () => {
    // 1 KiB filler — well under the 10 KiB floor. sha matches the manifest
    // so the sha-mismatch path can't be what blocks; only the size check.
    const tinyBytes = Buffer.alloc(1024, 0x55);
    const tinySha = createHash("sha256").update(tinyBytes).digest("hex");
    const installed: Buffer[] = [];
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: tinySha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            tinyBytes.buffer.slice(tinyBytes.byteOffset,
                                   tinyBytes.byteOffset + tinyBytes.length) } as Response));
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); });
    expect(await c.checkOnce()).toBe(false);
    expect(installed).toHaveLength(0);
  });

  it("with VIBE_ADS_REQUIRE_MANIFEST_SIG=1 + no embedded pubkey -> abort", async () => {
    const original = process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
    process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG = "1";
    try {
      const installed: Buffer[] = [];
      const f = vi.fn(async (url: string) =>
        url.endsWith("/manifest")
          ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
              url: "http://b/x.vsix" }) } as Response)
          : ({ ok: true, arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
            } as Response));
      const c = new UpdateClient("http://b", "0.1.0", f as never,
        async (b) => { installed.push(Buffer.from(b)); });
      // No __MANIFEST_PUBKEY_PEM__ define and the flag is on -> refuse.
      expect(await c.checkOnce()).toBe(false);
      expect(installed).toHaveLength(0);
    } finally {
      if (original === undefined) delete process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
      else process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG = original;
    }
  });

  // wave-2A-F01 layer 3: VSIX download-origin pin (supply-chain).
  it("blocks a VSIX url whose origin is off the published bucket (no install)", async () => {
    const installed: Buffer[] = [];
    // Manifest points the download at an attacker host but carries a VALID
    // sha for those bytes (the sha pin alone cannot save us here).
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
            url: "https://evil.example.com/payload.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response));
    // base is the GCS-style prod host so same-origin does NOT rescue evil.com.
    const c = new UpdateClient(
      "https://kickbacks-public-x.a.run.app", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); });
    expect(await c.checkOnce()).toBe(false);
    expect(installed).toHaveLength(0);
    // The blocked path must NOT have fetched the payload (only the manifest).
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("_vsixUrlAllowed: prod bucket allowed, dev/self-host allowed, others blocked", () => {
    const base = "https://kickbacks-public-x.a.run.app";
    // Production published bucket (both URL styles).
    expect(_vsixUrlAllowed(
      "https://kickbacks-vsix.storage.googleapis.com/kickbacks-0.3.99.vsix", base)).toBe(true);
    expect(_vsixUrlAllowed(
      "https://storage.googleapis.com/kickbacks-vsix/kickbacks-0.3.99.vsix", base)).toBe(true);
    // Another bucket on the shared GCS host is NOT allowed.
    expect(_vsixUrlAllowed(
      "https://storage.googleapis.com/some-other-bucket/x.vsix", base)).toBe(false);
    // Dev self-host: same origin as the manifest base, or loopback.
    expect(_vsixUrlAllowed("http://b/x.vsix", "http://b")).toBe(true);
    expect(_vsixUrlAllowed("http://127.0.0.1:6080/x.vsix", base)).toBe(true);
    // Attacker host + non-https are rejected.
    expect(_vsixUrlAllowed("https://evil.example.com/x.vsix", base)).toBe(false);
    expect(_vsixUrlAllowed("http://kickbacks-vsix.storage.googleapis.com/x.vsix", base)).toBe(false);
    expect(_vsixUrlAllowed("not a url", base)).toBe(false);
  });

  it("with flag OFF and no signature -> install proceeds (backward-compat)", async () => {
    const original = process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
    delete process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG;
    try {
      const installed: Buffer[] = [];
      const f = vi.fn(async (url: string) =>
        url.endsWith("/manifest")
          ? ({ ok: true, json: async () => ({ version: "0.2.0", sha256: sha,
              url: "http://b/x.vsix" }) } as Response)
          : ({ ok: true, arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
            } as Response));
      const c = new UpdateClient("http://b", "0.1.0", f as never,
        async (b) => { installed.push(Buffer.from(b)); });
      expect(await c.checkOnce()).toBe(true);
      expect(installed).toHaveLength(1);
    } finally {
      if (original !== undefined) process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG = original;
    }
  });
});
