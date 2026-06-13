import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync,
         copyFileSync, chmodSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import type { TargetAdapter, PreflightResult, OpResult, RestoreResult,
              PatchParams } from "../types";
import { sha256 } from "../../util/crypto";
import { resolveAsset } from "../../util/asset";

const MARKER = "VIBE-ADS-CODEX-CLI";
const AD_FILE_NAME = "codex-cli-ad.txt";

/** Terminal esc()-analog: strip control chars (C0 + DEL + C1) — and ONLY
 *  those — before the wrappers printf/echo the ad text raw to a terminal.
 *  Emoji / pipes / unicode / URLs pass through untouched (permissive by
 *  design — see backend validate_creative_fields, same char class). */
function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Resolve the wrapper asset in BOTH unbundled (co-located src) and
 *  esbuild-bundled (dist/adapters/codex-cli/) layouts — mirrors the
 *  CLI status-line adapter's resolveStatuslineAsset contract. */
export function resolveWrapperAsset(baseDir: string, isWin: boolean): string {
  const name = isWin ? "wrapper.cmd.asset" : "wrapper.sh.asset";
  return resolveAsset(baseDir, "adapters/codex-cli", name);
}

/** Wraps the npm-installed `codex` CLI shim with a small script that prints
 *  a one-line ad banner above the real codex invocation. Reversible: the
 *  pristine shim is copied to `<stem>.vibe-ads-orig<.cmd>` alongside it
 *  (kept next to the shim so the wrapper's `call` can target it on Windows,
 *  which requires a .cmd extension).
 *
 *  Codex CLI has no documented hook surface (per row 05 of
 *  test-stack/codexcli-test-e2e/), so a PATH wrapper is the only injection
 *  path that doesn't require an open-source binary rewrite. The banner is
 *  a startup print, NOT a live spinner verb — replacing the TUI's "Working"
 *  status row would require a context-anchored binary patch which is
 *  intentionally out of scope here. */
export class CodexCliWrapperAdapter implements TargetAdapter {
  readonly name = "codex-cli-wrapper";
  private readonly shim: string;
  private readonly home: string;
  private readonly isWin: boolean;

  /** @param shimPath absolute path to the npm-generated codex shim
   *      (codex.cmd on Windows; the extensionless `codex` JS shebang on POSIX).
   *  @param home directory hosting `~/.vibe-ads/` (typically os.homedir()). */
  constructor(shimPath: string, home: string) {
    this.shim = resolve(shimPath);
    this.home = resolve(home);
    this.isWin = this.shim.toLowerCase().endsWith(".cmd");
  }

  private vibeDir(): string { return join(this.home, ".vibe-ads"); }
  private adFilePath(): string { return join(this.vibeDir(), AD_FILE_NAME); }
  /** Backup lives ALONGSIDE the shim, not under ~/.vibe-ads, because cmd.exe's
   *  `call` resolves relative to the wrapper and only honours .cmd/.bat
   *  extensions on Windows. Keep round-trip simple by mirroring the shim's
   *  basename + extension. */
  private backupPath(): string {
    const dir = dirname(this.shim);
    if (this.isWin) {
      const stem = basename(this.shim, ".cmd");
      return join(dir, stem + ".vibe-ads-orig.cmd");
    }
    return join(dir, basename(this.shim) + ".vibe-ads-orig");
  }

  version(): string | null { return "cli"; }

  isPatched(): boolean {
    try {
      return existsSync(this.shim)
        && readFileSync(this.shim, "utf8").includes(MARKER);
    } catch { return false; }
  }

  preflight(): PreflightResult {
    try {
      if (!existsSync(this.shim))
        return { ok: true, compatible: false, version: "cli",
                 reason: "shim not found" };
      const raw = readFileSync(this.shim, "utf8");
      if (raw.includes(MARKER))
        return { ok: true, compatible: true, version: "cli" };
      // Sanity-check: only wrap things that LOOK like an npm-generated
      // codex shim — both the Windows .cmd and the POSIX JS-shebang version
      // reference `@openai/codex` (or its Windows-path form). A substring
      // match on bare "codex" would false-positive on any unrelated
      // codex.cmd containing the word ("not-codex", "claude-codex", etc.).
      if (!/@openai[\/\\]codex|codex\.js/.test(raw))
        return { ok: true, compatible: false, version: "cli",
                 reason: "shim doesn't look like @openai/codex" };
      return { ok: true, compatible: true, version: "cli" };
    } catch (e) {
      return { ok: false, compatible: false, version: null, reason: String(e) };
    }
  }

  private renderWrapper(): string {
    const asset = resolveWrapperAsset(dirname(__filename), this.isWin);
    return readFileSync(asset, "utf8")
      .split("__VIBE_ADS_AD_PATH__").join(this.adFilePath())
      .split("__VIBE_ADS_BACKUP__").join(this.backupPath());
  }

  applyPatch(p: PatchParams): OpResult {
    try {
      if (!existsSync(this.shim))
        return { ok: false, reason: "shim not found" };
      // Always (re)write the ad-text file. Cheap, decoupled from the wrapper
      // so an ad change does NOT require a wrapper rewrite — the wrapper
      // re-reads this file on every codex invocation.
      mkdirSync(this.vibeDir(), { recursive: true });
      // Control chars are stripped here (the shell/batch wrappers print the
      // file raw and cannot sanitize); an adText that strips to empty falls
      // back to the default line rather than printing a blank banner.
      writeFileSync(this.adFilePath(),
        (stripControlChars(p.adText || "") || "Earning Kickback") + "\n",
        "utf8");
      // Idempotent: if the shim already carries our marker, no wrapper rewrite.
      const current = readFileSync(this.shim, "utf8");
      if (current.includes(MARKER)) return { ok: true };
      // First-time install: snapshot the pristine npm shim. The check guards
      // against ever overwriting an existing backup with our wrapper, which
      // would happen if a stale wrapper file somehow lost its MARKER.
      if (!existsSync(this.backupPath()))
        copyFileSync(this.shim, this.backupPath());
      const wrapper = this.renderWrapper();
      writeFileSync(this.shim, wrapper, "utf8");
      if (!this.isWin) {
        try { chmodSync(this.shim, 0o755); } catch { /* best-effort */ }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  restore(): RestoreResult {
    try {
      const bak = this.backupPath();
      if (!existsSync(bak))
        return { ok: true, restored: false, reason: "no backup present" };
      const pristine = readFileSync(bak);
      writeFileSync(this.shim, pristine);
      if (sha256(readFileSync(this.shim)) !== sha256(pristine))
        return { ok: false, restored: false,
                 reason: "sha256 mismatch after restore" };
      rmSync(bak);
      if (existsSync(this.adFilePath())) {
        try { rmSync(this.adFilePath()); } catch { /* best-effort */ }
      }
      return { ok: true, restored: true };
    } catch (e) {
      return { ok: false, restored: false, reason: String(e) };
    }
  }
}
