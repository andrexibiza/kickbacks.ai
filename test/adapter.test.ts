import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync }
  from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, resolveBlockAsset }
  from "../src/adapters/claude-code/adapter";

const FIX = readFileSync(join(__dirname, "fixtures/synthetic-index.js"), "utf8");

function tmpTarget(): string {
  const d = mkdtempSync(join(tmpdir(), "vibe-ads-"));
  const p = join(d, "index.js");
  writeFileSync(p, FIX, "utf8");
  return p;
}
const params = {
  tier: 3 as const, adText: "Ramp corporate cards & expense mgmt",
  iconRef: "icon.r", iconUrl: "", clickToken: "ck", clickUrl: "https://ramp.example/lp", corr: "ad1.tst",
  loopbackPort: 5555, loopbackToken: "lt",
  loopbackBase: "http://127.0.0.1:5555",
};

describe("ClaudeCodeAdapter", () => {
  let target: string;
  beforeEach(() => { target = tmpTarget(); });

  it("preflight compatible on a fixture with a >=2-elem anchored array", () => {
    const a = new ClaudeCodeAdapter(target);
    const pf = a.preflight();
    expect(pf.compatible).toBe(true);
    expect(pf.version).not.toBeNull();
  });

  it("version(): strips CC's platform-specific packaging suffix", () => {
    // CC moved to platform packages (…-win32-x64); the label must read the
    // bare semver, not "2.1.161-win32-x64" — across every platform/arch combo.
    const v = (dir: string) =>
      new ClaudeCodeAdapter(`/x/${dir}/webview/index.js`).version();
    expect(v("anthropic.claude-code-2.1.161-win32-x64")).toBe("2.1.161");
    expect(v("anthropic.claude-code-2.1.161-darwin-arm64")).toBe("2.1.161");
    expect(v("anthropic.claude-code-2.1.180-linux-x64")).toBe("2.1.180");
    expect(v("anthropic.claude-code-2.1.143")).toBe("2.1.143"); // legacy, no suffix
  });

  it("version(): 'unknown' when the path has no claude-code dir segment", () => {
    // The no-target sentinel path resolves to no semver — never throw, never
    // mislabel.
    expect(new ClaudeCodeAdapter("/__vibe_ads_no_target__").version())
      .toBe("unknown");
  });

  it("isPatched(): false pristine, true after applyPatch, false after restore",
    () => {
    const a = new ClaudeCodeAdapter(target);
    expect(a.isPatched()).toBe(false);
    a.applyPatch(params);
    expect(a.isPatched()).toBe(true);
    a.restore();
    expect(a.isPatched()).toBe(false);
  });

  it("diagnose(): compatible fixture reports live array + bare verb present", () => {
    const d = new ClaudeCodeAdapter(target).diagnose();
    expect(d.compatible).toBe(true);
    expect(d.targetExists).toBe(true);
    expect(d.live.hasArray).toBe(true);
    expect(d.live.bareVerbPresent).toBe(true);
  });

  it("diagnose(): stripped file reports incompatible, no array, no bare verb (→ reinstall CC)", () => {
    writeFileSync(target, 'var V=["Alpha","Bravo"];', "utf8");
    const d = new ClaudeCodeAdapter(target).diagnose();
    expect(d.compatible).toBe(false);
    expect(d.live.hasArray).toBe(false);
    expect(d.live.bareVerbPresent).toBe(false);
  });

  it("diagnose(): verb word present but not in an array (→ bundle-format change)", () => {
    writeFileSync(target, 'var msg="Discombobulating the widgets";', "utf8");
    const d = new ClaudeCodeAdapter(target).diagnose();
    expect(d.compatible).toBe(false);
    expect(d.live.hasArray).toBe(false);
    expect(d.live.bareVerbPresent).toBe(true);
  });

  it("findArray is resilient: locates the array via an alternate verb when Discombobulating is gone", () => {
    // Simulate a future CC that renamed/removed "Discombobulating" but kept the
    // verb array (with other distinctive verbs). Detection must survive.
    writeFileSync(target,
      'var Gz1=["Working","Flibbertigibbeting","Brewing","Clauding","Cooking"];', "utf8");
    expect(new ClaudeCodeAdapter(target).preflight().compatible).toBe(true);
  });

  it("preflight still incompatible when NONE of the anchor verbs are present", () => {
    writeFileSync(target, 'var V=["Alpha","Bravo","Charlie","Delta"];', "utf8");
    expect(new ClaudeCodeAdapter(target).preflight().compatible).toBe(false);
  });

  it("preflight falls back to the live file when the backup is stale (no verb array)", () => {
    // Field repro (shipuser machine): a tainted/truncated .kickbacks-backup
    // lacks the verb array, so preflight USED to read it and dead-end as
    // incompatible even though the live CC build is fine. It must now fall back
    // to the live file and report compatible.
    const a = new ClaudeCodeAdapter(target);
    writeFileSync(target + ".kickbacks-backup", "garbage without the anchor", "utf8");
    expect(a.preflight().compatible).toBe(true);
  });

  it("applyPatch recaptures a clean backup when the existing one is stale", () => {
    const a = new ClaudeCodeAdapter(target);
    const bak = target + ".kickbacks-backup";
    writeFileSync(bak, "garbage without the anchor", "utf8");
    const res = a.applyPatch(params);
    expect(res.ok).toBe(true);
    expect(a.isPatched()).toBe(true);
    // The stale backup was replaced by a fresh capture from the live file, so
    // the pristine source once again carries the verb array.
    expect(readFileSync(bak, "utf8")).toContain('"Discombobulating"');
  });

  it("preflight incompatible only when BOTH backup and live lack the array", () => {
    const a = new ClaudeCodeAdapter(target);
    writeFileSync(target, 'var V=["A","B","C"];', "utf8");          // live: no anchor
    writeFileSync(target + ".kickbacks-backup", "also no anchor", "utf8"); // backup: no anchor
    const pf = a.preflight();
    expect(pf.compatible).toBe(false);
    expect(pf.reason).toContain("verb array not found");
  });

  it("preflight incompatible (graceful) when anchor missing — no writes", () => {
    writeFileSync(target, 'var V=["A","B","C"];', "utf8");
    const a = new ClaudeCodeAdapter(target);
    expect(a.preflight().compatible).toBe(false);
    expect(readFileSync(target, "utf8")).toBe('var V=["A","B","C"];'); // untouched
  });

  // Self-heal regression: deactivate() is best-effort, and a *different*
  // extension version can leave the file patched. On next load preflight()
  // reads the live (already-patched) file whose anchor our own Tier-0 swap
  // removed — it must NOT dead-end as "incompatible". A co-located pristine
  // backup proves THIS build was compatible, so preflight evaluates against
  // it (same source applyPatch() already uses). Without this the only
  // recovery is a manual debug-menu off→on toggle.
  it("preflight self-heals: compatible when the live file is already-patched but a pristine backup exists", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params); // live file now patched: block appended after the verb array
    const patched = readFileSync(target, "utf8");
    // Sanity: CC's native verb dictionary is INTACT now (we no longer
    // collapse it to [adText,""]). The visible failure when our block
    // fails is then CC's normal "Discombobulating…" cycling — a clear
    // signal that the overlay didn't render, instead of a plain-text
    // ad that silently masks block.desync.
    expect(patched).toContain('"Discombobulating"');
    expect(patched).toContain('/* VIBE-ADS-START */');
    expect(existsSync(target + ".kickbacks-backup")).toBe(true);
    const pf = a.preflight();
    expect(pf.compatible).toBe(true);
    expect(pf.version).not.toBeNull();
  });

  it("applyPatch writes a one-time backup, swaps the array, appends one block, idempotent", () => {
    const a = new ClaudeCodeAdapter(target);
    expect(a.applyPatch(params).ok).toBe(true);
    const after1 = readFileSync(target, "utf8");
    expect(existsSync(target + ".kickbacks-backup")).toBe(true);
    expect(after1).toContain(params.adText);
    expect(after1).toContain("/* VIBE-ADS-START */");
    expect((after1.match(/VIBE-ADS-START/g) || []).length).toBe(1);
    a.applyPatch(params); // idempotent
    expect(readFileSync(target, "utf8")).toBe(after1);
  });

  it("restore is byte-exact and honest", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params);
    const r = a.restore();
    expect(r.restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(FIX); // byte-exact
    expect(existsSync(target + ".kickbacks-backup")).toBe(false);
    const r2 = a.restore(); // honest: nothing to restore
    expect(r2.restored).toBe(false);
    expect(r2.reason).toMatch(/no backup/i);
  });

  // Reversibility across the Vibe-Ads rename: an install patched BEFORE the
  // rename carries a ".vibads-backup" pristine file and a /* VIBADS-START */
  // block. restore() must still find that backup, and re-apply must strip the
  // legacy block instead of stacking a second one.
  it("restores a pre-rename install from the legacy .vibads-backup", () => {
    const legacyBak = target + ".vibads-backup";
    writeFileSync(legacyBak, FIX, "utf8"); // pristine captured pre-rename
    writeFileSync(target,
      'var V=["x"];/* VIBADS-START */window.__v=1;/* VIBADS-END */', "utf8");
    const a = new ClaudeCodeAdapter(target);
    const r = a.restore();
    expect(r.restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(FIX); // byte-exact pristine
    expect(existsSync(legacyBak)).toBe(false); // legacy backup consumed
  });

  it("re-apply over a legacy VIBADS block does not stack (single new block)", () => {
    writeFileSync(target + ".vibads-backup", FIX, "utf8");
    writeFileSync(target,
      FIX + '\n/* VIBADS-START */window.__v=1;/* VIBADS-END */\n', "utf8");
    const a = new ClaudeCodeAdapter(target);
    expect(a.applyPatch(params).ok).toBe(true);
    const out = readFileSync(target, "utf8");
    expect((out.match(/VIBADS-START/g) || []).length).toBe(0); // legacy stripped
    expect((out.match(/VIBE-ADS-START/g) || []).length).toBe(1); // exactly one new
    expect(out).toContain(params.adText);
  });

  it("never throws on a bad path", () => {
    const a = new ClaudeCodeAdapter("/no/such/dir/index.js");
    expect(a.preflight().compatible).toBe(false);
    expect(a.applyPatch(params).ok).toBe(false);
    expect(a.restore().restored).toBe(false);
  });

  it("substitutes __VIBE_ADS_BANNER_ON__ and carries no legacy banner sentinel", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch({ ...params, bannerOn: true });
    const out = readFileSync(target, "utf8");
    expect(out).toContain("var BANNER_ON = true");
    const asset = readFileSync(
      join(__dirname, "../src/adapters/claude-code/block.asset.js"), "utf8");
    expect(asset.includes("__VIBE_ADS_BANNER__")).toBe(false);
    expect(asset.includes("var BANNER =")).toBe(false);
  });

  it("bannerOn false ⇒ var BANNER_ON = false", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch({ ...params, bannerOn: false });
    expect(readFileSync(target, "utf8")).toContain("var BANNER_ON = false");
  });
});

// CSP connect-src persistence. The relaxation must outlive a routine
// deactivate()/reload — Claude Code captures its webview CSP template into
// memory at extension-host load, BEFORE our re-patch, so a CSP reverted on
// every deactivate is never effective for the running session (loopback
// telemetry stays CSP-blocked). Policy: routine restore keeps the (invisible,
// loopback-only) connect-src; explicit restore/kill/sign-out fully reverts.
describe("CSP sibling patch + scoped restore", () => {
  // target = <root>/webview/index.js so extTarget() -> <root>/extension.js.
  function withSibling(): { target: string; ext: string } {
    const root = mkdtempSync(join(tmpdir(), "vibe-ads-csp-"));
    mkdirSync(join(root, "webview"), { recursive: true });
    const target = join(root, "webview", "index.js");
    writeFileSync(target, FIX, "utf8");
    const ext = join(root, "extension.js");
    // contains the exact CSP anchor the adapter rewrites (literal ${q})
    writeFileSync(ext, "globalThis.x=1;var CSP=\"default-src 'none'; ${q}; img-src data:\";", "utf8");
    return { target, ext };
  }
  const MARK = "connect-src http://127.0.0.1:*";

  it("applyPatch inserts connect-src into the sibling extension.js + backs it up", () => {
    const { target, ext } = withSibling();
    expect(new ClaudeCodeAdapter(target).applyPatch(params).ok).toBe(true);
    expect(readFileSync(ext, "utf8")).toContain(MARK);
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(true);
  });

  it("restore({keepCsp:true}) reverts index.js but LEAVES the CSP relaxation", () => {
    const { target, ext } = withSibling();
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params);
    const r = a.restore({ keepCsp: true });
    expect(r.restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(FIX);            // visible change gone
    expect(readFileSync(ext, "utf8")).toContain(MARK);         // CSP persists
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(true);   // still reversible
  });

  it("restore() (explicit, no opts) fully reverts BOTH index.js and the CSP", () => {
    const { target, ext } = withSibling();
    const pristineExt = readFileSync(ext, "utf8");
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params);
    const r = a.restore();
    expect(r.restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(FIX);
    expect(readFileSync(ext, "utf8")).toBe(pristineExt);       // byte-exact
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(false);
  });

  // Regression: CC 2.1.145 renamed the first template variable in the CSP
  // template from ${q} to ${U}, which silently broke the CSP patch because
  // the patcher's anchor was a literal string. Every webview→loopback fetch
  // (clicks, impressions, view-tracking) was CSP-blocked. The fix made
  // CSP_ANCHOR_RE match any single-identifier template token; this test
  // pins that 2.1.143's ${q}, 2.1.145's ${U}, and a hypothetical future
  // ${q2} all patch correctly, while preserving the original variable so the
  // rest of the CSP template renders identically.
  it("CSP patch tolerates CC template-variable renames (2.1.143/${q},"
    + " 2.1.145/${U}, and arbitrary single-identifier tokens)", () => {
    const cases = [
      { label: "2.1.143", token: "${q}" },
      { label: "2.1.145", token: "${U}" },
      { label: "hypothetical", token: "${q2}" },
    ];
    for (const c of cases) {
      const root = mkdtempSync(join(tmpdir(), "vibe-ads-csp-ver-"));
      mkdirSync(join(root, "webview"), { recursive: true });
      const target = join(root, "webview", "index.js");
      writeFileSync(target, FIX, "utf8");
      const ext = join(root, "extension.js");
      const cspLine =
        `var CSP="default-src 'none'; ${c.token}; ${"${M}"}; "`
        + `+ "script-src 'nonce-${"${D}"}'";`;
      writeFileSync(ext, cspLine, "utf8");
      expect(new ClaudeCodeAdapter(target).applyPatch(params).ok).toBe(true);
      const patched = readFileSync(ext, "utf8");
      expect(patched).toContain(MARK);                             // relaxed
      expect(patched).toContain(c.token);                          // var preserved
      expect(patched).toContain(`'none'; connect-src`);            // additive connect-src right after default-src
      expect(patched).not.toContain("img-src https://");           // H3: never inject our own img-src
    }
  });

  // H3 regression: real CC builds ship `${M}` = `img-src ${cspSource} data:`.
  // The patch must NOT emit a SECOND img-src — per CSP3 only the first is
  // honored, so a narrow ad-icon img-src would silently override CC's own
  // image policy and break CC's data:/markdown/webview images (prime
  // directive). Assert the patched policy has exactly one img-src (CC's).
  it("CSP patch does not duplicate img-src (preserves CC's image policy)", () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-ads-csp-img-"));
    mkdirSync(join(root, "webview"), { recursive: true });
    const target = join(root, "webview", "index.js");
    writeFileSync(target, FIX, "utf8");
    const ext = join(root, "extension.js");
    // CC's real shape: first var, then an img-src directive with data:.
    writeFileSync(ext,
      "var CSP=\"default-src 'none'; ${q}; img-src https://cc.example data:\";",
      "utf8");
    expect(new ClaudeCodeAdapter(target).applyPatch(params).ok).toBe(true);
    const patched = readFileSync(ext, "utf8");
    expect(patched).toContain(MARK);                                  // our connect-src added
    expect((patched.match(/img-src/g) || []).length).toBe(1);         // exactly ONE img-src
    expect(patched).toContain("img-src https://cc.example data:");    // and it's CC's, intact
  });

  // Regression: when the CSP anchor literally can't be found in extension.js,
  // applyPatch used to silently skip the relaxation — and the user only
  // discovered telemetry was dead by noticing the ledger had no clicks. Pin
  // that the visible patch (index.js) still succeeds (prime directive: never
  // break the editor), but the CSP miss is observable via the return shape
  // so future CC renames are diagnosable without grepping debug.log.
  it("applyPatch succeeds even when the CSP anchor isn't present (no-op CSP,"
    + " visible patch still lands — preserves prime directive)", () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-ads-csp-no-anchor-"));
    mkdirSync(join(root, "webview"), { recursive: true });
    const target = join(root, "webview", "index.js");
    writeFileSync(target, FIX, "utf8");
    const ext = join(root, "extension.js");
    // CSP template variable position has been replaced with something the
    // regex won't match (e.g. a different shape altogether).
    writeFileSync(ext, "var CSP=\"unrelated cspstuff goes here\";", "utf8");
    expect(new ClaudeCodeAdapter(target).applyPatch(params).ok).toBe(true);
    expect(readFileSync(ext, "utf8")).not.toContain(MARK);  // CSP unmodified
    // But the visible patch DID land — index.js has the block
    expect(readFileSync(target, "utf8")).toContain("/* VIBE-ADS-START */");
  });

  // prime(): the boot-time "guaranteed startup reassert". Relaxes the CSP so
  // the loopback surface is ready BEFORE an ad is in hand, WITHOUT injecting a
  // visible block. Same connect-src + backup + reversibility as applyPatch's
  // CSP layer, but index.js is never touched.
  it("prime() inserts the connect-src + backs up the sibling, WITHOUT injecting a block", () => {
    const { target, ext } = withSibling();
    const a = new ClaudeCodeAdapter(target);
    expect(a.prime().ok).toBe(true);
    expect(readFileSync(ext, "utf8")).toContain(MARK);          // CSP relaxed
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(true);    // reversible
    expect(readFileSync(target, "utf8")).toBe(FIX);             // index.js untouched
    expect(a.isPatched()).toBe(false);                          // no visible block
  });

  it("prime() is idempotent (second call is an 'already' no-op, no double insert)", () => {
    const { target, ext } = withSibling();
    const a = new ClaudeCodeAdapter(target);
    a.prime();
    const after1 = readFileSync(ext, "utf8");
    const r2 = a.prime();
    expect(r2.ok).toBe(true);
    expect(r2.reason).toBe("already");
    expect(readFileSync(ext, "utf8")).toBe(after1);             // byte-identical
    expect((after1.match(/connect-src http:\/\/127\.0\.0\.1/g) || []).length).toBe(1);
  });

  it("prime() then applyPatch is a no-op on the already-primed CSP; restore({keepCsp:true}) keeps it", () => {
    const { target, ext } = withSibling();
    const a = new ClaudeCodeAdapter(target);
    a.prime();
    const primedExt = readFileSync(ext, "utf8");
    expect(a.applyPatch(params).ok).toBe(true);                 // ad arrives
    expect(readFileSync(ext, "utf8")).toBe(primedExt);          // CSP unchanged by applyPatch
    expect(a.isPatched()).toBe(true);                           // block now present
    a.restore({ keepCsp: true });
    expect(readFileSync(ext, "utf8")).toContain(MARK);          // CSP survives routine restore
  });

  it("prime() then explicit restore() fully reverts the primed CSP (byte-exact)", () => {
    const { target, ext } = withSibling();
    const pristineExt = readFileSync(ext, "utf8");
    const a = new ClaudeCodeAdapter(target);
    a.prime();
    expect(readFileSync(ext, "utf8")).toContain(MARK);
    a.restore();                                                // explicit, no opts
    expect(readFileSync(ext, "utf8")).toBe(pristineExt);        // CSP reverted byte-exact
    expect(existsSync(ext + ".vibe-ads-backup")).toBe(false);
  });

  it("prime() never throws on a bad path", () => {
    const a = new ClaudeCodeAdapter("/no/such/dir/webview/index.js");
    expect(a.prime().ok).toBe(false);                           // graceful: no sibling
  });
});

// Regression for S3 Wave 1 review CRIT #1: the block asset must resolve in
// BOTH the unbundled (co-located) and the esbuild-bundled (dist/) layouts.
describe("resolveBlockAsset (bundled-vs-unbundled)", () => {
  it("finds the asset co-located (unbundled / vitest layout)", () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-rb1-"));
    writeFileSync(join(d, "block.asset.js"), "x", "utf8");
    expect(resolveBlockAsset(d)).toBe(join(d, "block.asset.js"));
  });
  it("finds the asset at adapters/claude-code (bundled dist/ layout)", () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-rb2-"));
    mkdirSync(join(d, "adapters", "claude-code"), { recursive: true });
    writeFileSync(join(d, "adapters", "claude-code", "block.asset.js"), "x", "utf8");
    expect(resolveBlockAsset(d)).toBe(join(d, "adapters", "claude-code", "block.asset.js"));
  });
  it("esbuild build actually places the asset where the BUNDLED adapter looks", () => {
    // Build the real bundle, then assert the asset exists at the path
    // resolveBlockAsset() will compute from dirname(dist/extension.js).
    execFileSync("node", ["esbuild.mjs"], { cwd: join(__dirname, ".."), stdio: "pipe" });
    const distDir = join(__dirname, "..", "dist");
    expect(existsSync(join(distDir, "extension.js"))).toBe(true);
    const resolved = resolveBlockAsset(distDir); // dirname(__filename) at runtime
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toBe(join(distDir, "adapters", "claude-code", "block.asset.js"));
  });
});
