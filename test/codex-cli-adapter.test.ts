import { describe, it, expect } from "vitest";
import { CodexCliWrapperAdapter, resolveWrapperAsset }
  from "../src/adapters/codex-cli/adapter";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync,
         existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatchParams } from "../src/adapters/types";

const PRISTINE_CMD =
  "@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n" +
  ":start\nSETLOCAL\nCALL :find_dp0\n\n" +
  'IF EXIST "%dp0%\\node.exe" (\n' +
  '  SET "_prog=%dp0%\\node.exe"\n' +
  ') ELSE (\n' +
  '  SET "_prog=node"\n' +
  '  SET PATHEXT=%PATHEXT:;.JS;=;%\n' +
  ")\n\n" +
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
  '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n';

const PRISTINE_SH =
  "#!/usr/bin/env node\n" +
  "// @openai/codex shim — boots node + codex.js\n" +
  'import { spawn } from "node:child_process";\n';

function patchParams(overrides: Partial<PatchParams> = {}): PatchParams {
  return {
    tier: 0,
    adText: "Test Ad XYZ",
    iconRef: "i.svg",
    iconUrl: "",
    clickToken: "",
    clickUrl: "https://example.com",
    corr: "c.test",
    loopbackPort: 0,
    loopbackToken: "",
    loopbackBase: "",
    ...overrides,
  };
}

describe("CodexCliWrapperAdapter — Windows .cmd shim", () => {
  function setup(content = PRISTINE_CMD) {
    const home = mkdtempSync(join(tmpdir(), "kb-cxcli-"));
    const shimDir = join(home, "AppData", "Roaming", "npm");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "codex.cmd");
    writeFileSync(shim, content);
    return { home, shim, backup: join(shimDir, "codex.vibe-ads-orig.cmd"),
             adFile: join(home, ".vibe-ads", "codex-cli-ad.txt") };
  }

  it("preflight: compatible on a plausibly-npm-shim", () => {
    const { home, shim } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    const pf = a.preflight();
    expect(pf.ok).toBe(true);
    expect(pf.compatible).toBe(true);
  });

  it("preflight: incompatible when shim doesn't reference @openai/codex", () => {
    const { home, shim } = setup("@echo off\necho not-codex\n");
    const a = new CodexCliWrapperAdapter(shim, home);
    const pf = a.preflight();
    expect(pf.compatible).toBe(false);
    expect(pf.reason).toMatch(/openai\/codex/);
  });

  it("preflight: incompatible when shim file is missing", () => {
    const { home, shim } = setup();
    rmSync(shim);
    const a = new CodexCliWrapperAdapter(shim, home);
    const pf = a.preflight();
    expect(pf.compatible).toBe(false);
    expect(pf.reason).toBe("shim not found");
  });

  it("applyPatch: writes wrapper with MARKER, creates backup + ad-text file", () => {
    const { home, shim, backup, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    const r = a.applyPatch(patchParams());
    expect(r.ok).toBe(true);
    const wrapper = readFileSync(shim, "utf8");
    expect(wrapper).toContain("VIBE-ADS-CODEX-CLI");
    // The wrapper should delegate to the backup we just saved
    expect(wrapper).toContain(backup);
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf8")).toBe(PRISTINE_CMD);
    expect(readFileSync(adFile, "utf8").trim()).toBe("Test Ad XYZ");
    expect(a.isPatched()).toBe(true);
  });

  it("applyPatch is idempotent: second call doesn't rewrap or overwrite backup", () => {
    const { home, shim, backup } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    a.applyPatch(patchParams());
    const wrapper1 = readFileSync(shim, "utf8");
    const backupBefore = readFileSync(backup, "utf8");
    a.applyPatch(patchParams({ adText: "Different Ad" }));
    const wrapper2 = readFileSync(shim, "utf8");
    // Wrapper itself unchanged (no rewrite when MARKER already present)
    expect(wrapper2).toBe(wrapper1);
    // Backup still pristine — never overwritten by the wrapper bytes
    expect(readFileSync(backup, "utf8")).toBe(backupBefore);
  });

  it("applyPatch: ad-text file is updated on every call (decoupled from wrapper)", () => {
    const { home, shim, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    a.applyPatch(patchParams({ adText: "First Ad" }));
    expect(readFileSync(adFile, "utf8").trim()).toBe("First Ad");
    a.applyPatch(patchParams({ adText: "Second Ad" }));
    expect(readFileSync(adFile, "utf8").trim()).toBe("Second Ad");
  });

  it("applyPatch strips control chars from the ad file (wrappers print it raw to the terminal)", () => {
    const { home, shim, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    const ESC = "\u001b", BEL = "\u0007";
    a.applyPatch(patchParams({
      adText: "Evil" + ESC + "]0;pwned" + BEL + ESC + "[31mAd" }));
    expect(readFileSync(adFile, "utf8")).toBe("Evil]0;pwned[31mAd\n");
  });

  it("applyPatch is PERMISSIVE: emoji/pipes/unicode written byte-identical", () => {
    const { home, shim, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    const line = "Déployez 🚀 | ai.dev — vite";
    a.applyPatch(patchParams({ adText: line }));
    expect(readFileSync(adFile, "utf8")).toBe(line + "\n");
  });

  it("applyPatch falls back to the default line when adText strips to empty", () => {
    const { home, shim, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    a.applyPatch(patchParams({ adText: "\u001b\u0007" }));
    expect(readFileSync(adFile, "utf8")).toBe("Earning Kickback\n");
  });

  it("restore: byte-exact restoration of the npm shim", () => {
    const { home, shim, backup, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    a.applyPatch(patchParams());
    expect(readFileSync(shim, "utf8")).not.toBe(PRISTINE_CMD);
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(true);
    expect(readFileSync(shim, "utf8")).toBe(PRISTINE_CMD);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(adFile)).toBe(false);
  });

  it("restore: returns restored:false when no backup is present", () => {
    const { home, shim } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(/no backup/);
  });

  it("wrapper substitutes the ad-file and backup paths verbatim", () => {
    const { home, shim, backup, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    a.applyPatch(patchParams());
    const wrapper = readFileSync(shim, "utf8");
    expect(wrapper).toContain(adFile);
    expect(wrapper).toContain(backup);
    // No raw template placeholders should leak through
    expect(wrapper).not.toContain("__VIBE_ADS_AD_PATH__");
    expect(wrapper).not.toContain("__VIBE_ADS_BACKUP__");
  });
});

describe("CodexCliWrapperAdapter — POSIX shim", () => {
  function setup(content = PRISTINE_SH) {
    const home = mkdtempSync(join(tmpdir(), "kb-cxcli-posix-"));
    const shimDir = join(home, "usr", "local", "bin");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "codex");
    writeFileSync(shim, content);
    return { home, shim, backup: join(shimDir, "codex.vibe-ads-orig"),
             adFile: join(home, ".vibe-ads", "codex-cli-ad.txt") };
  }

  it("preflight: compatible on a JS-shebang npm shim", () => {
    const { home, shim } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    expect(a.preflight().compatible).toBe(true);
  });

  it("applyPatch: writes shell wrapper, backup uses no-extension naming", () => {
    const { home, shim, backup, adFile } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    const r = a.applyPatch(patchParams());
    expect(r.ok).toBe(true);
    const wrapper = readFileSync(shim, "utf8");
    expect(wrapper).toContain("VIBE-ADS-CODEX-CLI");
    expect(wrapper).toMatch(/^#!\/bin\/sh/);
    expect(wrapper).toContain('exec "' + backup + '"');
    expect(wrapper).toContain(adFile);
    expect(readFileSync(backup, "utf8")).toBe(PRISTINE_SH);
  });

  it("restore: byte-exact round-trip of the POSIX shim", () => {
    const { home, shim } = setup();
    const a = new CodexCliWrapperAdapter(shim, home);
    a.applyPatch(patchParams());
    a.restore();
    expect(readFileSync(shim, "utf8")).toBe(PRISTINE_SH);
  });
});

describe("resolveWrapperAsset", () => {
  it("picks the .cmd asset on Windows, .sh on POSIX", () => {
    const dir = join(__dirname, "..", "src", "adapters", "codex-cli");
    const winAsset = resolveWrapperAsset(dir, true);
    const posixAsset = resolveWrapperAsset(dir, false);
    expect(winAsset.endsWith("wrapper.cmd.asset")).toBe(true);
    expect(posixAsset.endsWith("wrapper.sh.asset")).toBe(true);
  });
});
