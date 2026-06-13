import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex/adapter";
import type { PatchParams } from "../src/adapters/types";

const FIX = readFileSync(
  join(__dirname, "fixtures/synthetic-thinking-shimmer.js"), "utf8");

// Real Codex path shape:
// .../openai.chatgpt-<ver>/webview/assets/thinking-shimmer-<hash>.js
function tmpTarget(ver = "26.513.21555"): string {
  const root = mkdtempSync(join(tmpdir(), "vibe-ads-codex-"));
  const dir = join(root, `openai.chatgpt-${ver}`, "webview", "assets");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "thinking-shimmer-BcRunliI.js");
  writeFileSync(p, FIX, "utf8");
  return p;
}

function tmpTargetWithCsp(ver = "26.513.21555"):
  { target: string; ext: string; pristineExt: string } {
  const root = mkdtempSync(join(tmpdir(), "vibe-ads-codex-csp-"));
  const extRoot = join(root, `openai.chatgpt-${ver}`);
  const dir = join(extRoot, "webview", "assets");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(extRoot, "out"), { recursive: true });
  const target = join(dir, "thinking-shimmer-BcRunliI.js");
  const ext = join(extRoot, "out", "extension.js");
  const pristineExt =
    "const c=[\"default-src 'none'\","
    + "`connect-src ${e.cspSource} ${rfe}`].join('; ');";
  writeFileSync(target, FIX, "utf8");
  writeFileSync(ext, pristineExt, "utf8");
  return { target, ext, pristineExt };
}

const params: PatchParams = {
  tier: 3, adText: "Ramp corporate cards & expense mgmt",
  iconRef: "icon.r", iconUrl: "", clickToken: "ck", clickUrl: "https://ramp.example/lp",
  corr: "ad1.tst", loopbackPort: 5555, loopbackToken: "lt",
  loopbackBase: "http://127.0.0.1:5555/vibe-ads/lt", debug: false,
};

describe("CodexAdapter", () => {
  let target: string;
  beforeEach(() => { target = tmpTarget(); });

  it("fixture carries the four S9 anchors", () => {
    expect(FIX.replace(/\s+/g, "")).toContain("export{vasn,gast}");
    expect(FIX).toContain("defaultMessage:`Thinking`");
    expect(FIX).toContain("id:`thinkingShimmer.default`");
    expect(FIX).toMatch(/\(0,\s*d\.jsxs?\)/);
  });

  it("preflight compatible on the fixture; version from the dir segment", () => {
    const a = new CodexAdapter(target);
    const pf = a.preflight();
    expect(pf.ok).toBe(true);
    expect(pf.compatible).toBe(true);
    expect(pf.version).toBe("26.513.21555");
  });

  it("preflight incompatible (graceful, no writes) when anchors missing", () => {
    writeFileSync(target, "export{};var x=1;", "utf8");
    const a = new CodexAdapter(target);
    expect(a.preflight().compatible).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("export{};var x=1;");
  });

  it("preflight not-found is graceful", () => {
    const a = new CodexAdapter(target + ".nope");
    const pf = a.preflight();
    expect(pf.ok).toBe(true);
    expect(pf.compatible).toBe(false);
  });

  it("version reads the openai.chatgpt-<ver> path segment", () => {
    expect(new CodexAdapter(target).version()).toBe("26.513.21555");
  });

  it("applyPatch adds loopback hosts to Codex out/extension.js connect-src", () => {
    const { target: cspTarget, ext } = tmpTargetWithCsp();
    const a = new CodexAdapter(cspTarget);
    expect(a.applyPatch(params).ok).toBe(true);
    const patched = readFileSync(ext, "utf8");
    expect(patched).toContain(
      "connect-src http://127.0.0.1:* http://localhost:* "
      + "${e.cspSource} ${rfe}");
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(true);

    a.applyPatch(params);
    expect((readFileSync(ext, "utf8").match(/http:\/\/127\.0\.0\.1:\*/g) || [])
      .length).toBe(1);
  });

  it("applyPatch: one-time backup, single block at function v(e){, idempotent", () => {
    const a = new CodexAdapter(target);
    expect(a.applyPatch(params).ok).toBe(true);
    const out1 = readFileSync(target, "utf8");
    expect(existsSync(target + ".vibe-ads-backup")).toBe(true);
    // Markers wrap the WHOLE arg= statement (OUTSIDE the wrapper) so a future
    // strip removes it entirely — no empty `e=()||e;` residue can remain.
    expect(out1).toMatch(/function v\(e\)\{\/\* VIBE-ADS-START \*\/e=\(/);
    expect(out1).toMatch(/\)\|\|e;\/\* VIBE-ADS-END \*\/\s*let /);
    expect(out1).toContain(params.adText);
    expect((out1.match(/VIBE-ADS-START/g) || []).length).toBe(1);
    expect(out1).toContain('"http://127.0.0.1:5555/vibe-ads/lt"'); // loopbackBase substituted
    a.applyPatch(params);                        // idempotent (re-derived from pristine)
    expect(readFileSync(target, "utf8")).toBe(out1);
  });

  it("applyPatch wraps the entry arg and resolves every sentinel", () => {
    const a = new CodexAdapter(target);
    a.applyPatch(params);
    const out = readFileSync(target, "utf8");
    // Body-level overlay block: a pure passthrough IIFE (returns undefined →
    // `e = <iife> || e` leaves Codex's component untouched). The arg is still
    // wrapped by the adapter; no JSX runtime is injected (DOM-only overlay).
    expect(out).toMatch(
      /function v\(e\)\{\/\* VIBE-ADS-START \*\/e=\(.*\)\|\|e;\/\* VIBE-ADS-END \*\//s);
    expect(out).toContain("data-vibe-ads"); // overlay element marker present
    expect(out).not.toContain("__VIBE_ADS_");
  });

  it("self-heals every historical injection form (no e=()||e; residue)", () => {
    // Regression for the 'finnicky/stopped working' root cause: a re-derive
    // from an already-patched file with NO backup must reproduce the TRUE
    // pristine, never leave an empty-wrapper residue, and stay ESM-valid +
    // idempotent. Covers current/legacy/residue forms.
    const seeds = [
      FIX,                                                        // clean
      FIX.replace(/function v\(e\)\{/,
        "function v(e){/* VIBE-ADS-START */e=((function(){return})())||e;/* VIBE-ADS-END */"), // new form
      FIX.replace(/function v\(e\)\{/,
        "function v(e){e=(/* VIBE-ADS-START */0/* VIBE-ADS-END */)||e;"), // legacy markers-inside
      FIX.replace(/function v\(e\)\{/, "function v(e){e=()||e;e=()||e;"), // accumulated residue
    ];
    for (const seed of seeds) {
      writeFileSync(target, seed, "utf8");                  // NO backup written
      const a = new CodexAdapter(target);
      expect(a.applyPatch(params).ok).toBe(true);
      const o1 = readFileSync(target, "utf8");
      expect((o1.match(/VIBE-ADS-START/g) || []).length).toBe(1);
      expect(o1).not.toMatch(/=\(\)\|\|/);                  // zero empty residue
      a.applyPatch(params);
      expect(readFileSync(target, "utf8")).toBe(o1);        // idempotent
      const r = a.restore();
      expect(r.restored).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(FIX);       // byte-true pristine
    }
  });

  it("applyPatch isPatched() reflects state", () => {
    const a = new CodexAdapter(target);
    expect(a.isPatched()).toBe(false);
    a.applyPatch(params);
    expect(a.isPatched()).toBe(true);
  });

  it("applyPatch graceful when target missing", () => {
    const a = new CodexAdapter(target + ".nope");
    expect(a.applyPatch(params).ok).toBe(false);
  });

  it("applyPatch incompatible build → ok:false, no write", () => {
    writeFileSync(target, "export{};var x=1;", "utf8");
    const a = new CodexAdapter(target);
    expect(a.applyPatch(params).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("export{};var x=1;");
    expect(existsSync(target + ".vibe-ads-backup")).toBe(false);
  });

  it("restore is byte-exact + honest, removes backup, isPatched()→false", () => {
    const a = new CodexAdapter(target);
    a.applyPatch(params);
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(FIX);          // byte-exact
    expect(existsSync(target + ".vibe-ads-backup")).toBe(false);
    expect(a.isPatched()).toBe(false);
  });

  it("restore with no backup is an honest no-op", () => {
    const a = new CodexAdapter(target);
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(/no backup/i);
  });

  it("restore({ keepCsp:true }) reverts the chunk but leaves CSP relaxation", () => {
    const { target: cspTarget, ext } = tmpTargetWithCsp();
    const a = new CodexAdapter(cspTarget);
    a.applyPatch(params);
    expect(a.restore({ keepCsp: true }).restored).toBe(true);
    expect(readFileSync(cspTarget, "utf8")).toBe(FIX);
    expect(readFileSync(ext, "utf8")).toContain("connect-src http://127.0.0.1:*");
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(true);
  });

  it("restore() fully reverts the Codex CSP relaxation", () => {
    const { target: cspTarget, ext, pristineExt } = tmpTargetWithCsp();
    const a = new CodexAdapter(cspTarget);
    a.applyPatch(params);
    expect(a.restore().restored).toBe(true);
    expect(readFileSync(cspTarget, "utf8")).toBe(FIX);
    expect(readFileSync(ext, "utf8")).toBe(pristineExt);
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(false);
  });

  // prime(): the boot-time structural reassert — relax the loopback CSP with
  // NO block injected, so the surface is primed before an ad arrives.
  it("prime() relaxes the Codex CSP + backs it up, WITHOUT injecting a block", () => {
    const { target: cspTarget, ext } = tmpTargetWithCsp();
    const a = new CodexAdapter(cspTarget);
    expect(a.prime().ok).toBe(true);
    expect(readFileSync(ext, "utf8")).toContain("connect-src http://127.0.0.1:*");
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(true);
    expect(readFileSync(cspTarget, "utf8")).toBe(FIX);       // chunk untouched
    expect(a.isPatched()).toBe(false);                       // no block
  });

  it("prime() is idempotent (no double connect-src insert)", () => {
    const { target: cspTarget, ext } = tmpTargetWithCsp();
    const a = new CodexAdapter(cspTarget);
    a.prime();
    const after1 = readFileSync(ext, "utf8");
    a.prime();
    expect(readFileSync(ext, "utf8")).toBe(after1);
    expect((after1.match(/http:\/\/127\.0\.0\.1:\*/g) || []).length).toBe(1);
  });

  it("prime() then explicit restore() fully reverts the primed CSP (no block backup)", () => {
    const { target: cspTarget, ext, pristineExt } = tmpTargetWithCsp();
    const a = new CodexAdapter(cspTarget);
    a.prime();
    expect(readFileSync(ext, "utf8")).toContain("connect-src http://127.0.0.1:*");
    a.restore();                                             // explicit opt-out
    expect(readFileSync(ext, "utf8")).toBe(pristineExt);     // CSP byte-exact reverted
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(false);
  });

  it("prime() graceful when the sibling extension.js is absent", () => {
    const a = new CodexAdapter(target);                      // tmpTarget(): no out/extension.js
    expect(a.prime().ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(FIX);          // chunk untouched
  });

  it("never throws on a garbled target", () => {
    writeFileSync(target, "  not js  ", "utf8");
    const a = new CodexAdapter(target);
    expect(() => a.preflight()).not.toThrow();
    expect(a.applyPatch(params).ok).toBe(false);
    expect(() => a.restore()).not.toThrow();
    expect(() => a.isPatched()).not.toThrow();
  });
});
