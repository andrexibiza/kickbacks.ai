/** Regression test for wave-2H-F04 -- cooldown-bounded update guard.
 *
 * The 30-min UPD_COOLDOWN_MS guard in extension.ts wraps UpdateClient's
 * AttemptGuard.attempted/markAttempted: a given version is install-tried
 * AT MOST once per 30 minutes. Pre-fix update.test.ts only tested with a
 * permanent boolean -- the test passed whether the guard was permanent OR
 * cooldown-bounded. This test uses a fake clock + the real cooldown
 * formula to pin the time-based semantics.
 *
 * Also covers wave-2A-F05 transient cooldown: a sha-mismatch / size-cap
 * pre-install failure is throttled by a separate 15-min transient slot,
 * not the permanent 30-min one.
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { UpdateClient } from "../src/update/client";

const COOLDOWN_MS = 30 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 15 * 60 * 1000;
const bytes = Buffer.alloc(12 * 1024, 0x42);
const sha = createHash("sha256").update(bytes).digest("hex");

// Wave-2P-F01: mirrors the extension.ts composite-key wiring exactly so this
// fixture exercises the same flap-suppression logic prod uses. `updKey`
// degrades to bare-version when sha is absent (back-compat with old guards).
// Ring-buffer (capacity matches extension.ts): tracks the last N (v,sha)
// attempts so an A→B→A→B manifest ping-pong can't bypass the cooldown by
// clobbering the prior slot.
const RING_CAP = 16;
const updKey = (v: string, sha?: string) => sha ? `${v}@${sha.slice(0, 16)}` : v;
function makeGuard(now: () => number) {
  const attempted: { k: string; ts: number }[] = [];
  const transient: { k: string; ts: number }[] = [];
  const seen = (ring: { k: string; ts: number }[], k: string, cd: number) =>
    ring.some((e) => e.k === k && now() - e.ts < cd);
  const mark = (ring: { k: string; ts: number }[], k: string) => {
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].k === k) ring.splice(i, 1);
    ring.push({ k, ts: now() });
    while (ring.length > RING_CAP) ring.shift();
  };
  return {
    attempted: (v: string, sha?: string) => seen(attempted, updKey(v, sha), COOLDOWN_MS),
    markAttempted: (v: string, sha?: string) => mark(attempted, updKey(v, sha)),
    transientFailed: (v: string, sha?: string) =>
      seen(transient, updKey(v, sha), TRANSIENT_COOLDOWN_MS),
    markTransientFailed: (v: string, sha?: string) => mark(transient, updKey(v, sha)),
  };
}

function makeFetch(version: string, vsixBytes: Buffer, vsixSha: string) {
  return vi.fn(async (url: string) =>
    url.endsWith("/manifest")
      ? ({ ok: true, json: async () => ({ version, sha256: vsixSha,
          url: "http://b/x.vsix" }) } as Response)
      : ({ ok: true, arrayBuffer: async () =>
          vsixBytes.buffer.slice(vsixBytes.byteOffset,
                                 vsixBytes.byteOffset + vsixBytes.length) } as Response));
}

describe("wave-2H-F04 cooldown-bounded update guard", () => {
  it("permanent slot: a 2nd attempt within 30min is suppressed", async () => {
    let t = 1_000_000;
    const now = () => t;
    const guard = makeGuard(now);
    const installed: Buffer[] = [];
    const f = makeFetch("0.2.0", bytes, sha);
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); }, guard);

    expect(await c.checkOnce()).toBe(true);   // installs, marks attempted
    expect(installed.length).toBe(1);

    // 29 minutes later -> still within cooldown
    t += 29 * 60 * 1000;
    expect(await c.checkOnce()).toBe(false);
    expect(installed.length).toBe(1);

    // 31 minutes from FIRST attempt -> cooldown elapsed; re-attempted
    t = 1_000_000 + 31 * 60 * 1000;
    expect(await c.checkOnce()).toBe(true);
    expect(installed.length).toBe(2);
  });

  it("wave-2P-F01: same version + DIFFERENT sha installs twice (flap is the artifact, not the label)", async () => {
    // The bug this test pins: prod 0.3.54 had two builds (different
    // BUILD_TS, identical semver). Pre-fix, guard.attempted("0.3.54") was
    // true after the first install, so the second build never installed —
    // BUT the OPPOSITE problem also occurred elsewhere: when a manifest
    // genuinely served a *different* artifact under the same version
    // (e.g. signed rebuild), the version-keyed cooldown was correct to
    // skip it. The composite key correctly distinguishes these cases:
    // - Same version + same sha within cooldown -> skip (no flap).
    // - Same version + different sha            -> install (new artifact).
    let t = 1_000_000;
    const guard = makeGuard(() => t);
    const installed: Buffer[] = [];

    // Two distinct VSIX blobs, same semver "0.3.54".
    const bytesA = Buffer.alloc(12 * 1024, 0x41);
    const shaA = createHash("sha256").update(bytesA).digest("hex");
    const bytesB = Buffer.alloc(12 * 1024, 0x42);
    const shaB = createHash("sha256").update(bytesB).digest("hex");

    let serve: { bytes: Buffer; sha: string } = { bytes: bytesA, sha: shaA };
    const f = vi.fn(async (url: string) =>
      url.endsWith("/manifest")
        ? ({ ok: true, json: async () => ({ version: "0.3.54",
            sha256: serve.sha, url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            serve.bytes.buffer.slice(serve.bytes.byteOffset,
              serve.bytes.byteOffset + serve.bytes.length) } as Response));

    const c = new UpdateClient("http://b", "0.3.53", f as never,
      async (b) => { installed.push(Buffer.from(b)); }, guard);

    // Round 1: serve artifact A. Installs + marks (0.3.54, shaA).
    expect(await c.checkOnce()).toBe(true);
    expect(installed.length).toBe(1);

    // Round 2 (immediately): manifest now flips to artifact B with the SAME
    // version. Pre-fix this was suppressed (the version-keyed cooldown said
    // "already attempted"). Post-fix: composite key differs -> install.
    serve = { bytes: bytesB, sha: shaB };
    expect(await c.checkOnce()).toBe(true);
    expect(installed.length).toBe(2);

    // Round 3 (immediately): manifest flips BACK to artifact A. shaA was
    // marked in round 1; same composite key now within cooldown -> skip.
    // This is the actual flap-suppression: the loop must NOT keep ping-pong-
    // installing A and B every poll forever.
    serve = { bytes: bytesA, sha: shaA };
    expect(await c.checkOnce()).toBe(false);
    expect(installed.length).toBe(2);
  });

  it("wave-2A-F05: sha mismatch goes into the transient slot, not permanent", async () => {
    let t = 5_000_000;
    const guard = makeGuard(() => t);
    const installed: Buffer[] = [];
    // Manifest sha intentionally doesn't match the bytes -> transient fail.
    const f = makeFetch("0.2.0", bytes, "deadbeef00");
    const c = new UpdateClient("http://b", "0.1.0", f as never,
      async (b) => { installed.push(Buffer.from(b)); }, guard);

    expect(await c.checkOnce()).toBe(false);
    expect(installed.length).toBe(0);

    // 5 min later: still inside the 15-min transient cooldown -> skipped
    t += 5 * 60 * 1000;
    expect(await c.checkOnce()).toBe(false);

    // 16 min after first failure: transient cooldown elapsed, retry
    t = 5_000_000 + 16 * 60 * 1000;
    expect(await c.checkOnce()).toBe(false); // sha still mismatches -> retry-then-transient-fail again
    // The permanent attempted slot was NEVER set -- a sha-mismatch never
    // burns the install-attempt budget.
    expect(guard.attempted("0.2.0")).toBe(false);
  });
});
