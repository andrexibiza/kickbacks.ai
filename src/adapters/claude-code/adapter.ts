import { readFileSync, writeFileSync, existsSync, rmSync,
  renameSync, unlinkSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { TargetAdapter, PreflightResult, OpResult, RestoreResult, PatchParams,
  AdapterDiagnostics } from "../types";
import { dlog } from "../../log";
import { sha256 } from "../../util/crypto";
import { resolveAsset } from "../../util/asset";

// Distinctive nonsense/brand verbs from Claude Code's action-verb array. We
// anchor on the SET, not a single literal, so renaming or removing any ONE verb
// in a future CC release doesn't break detection — the array is still located
// as long as ANY of these survive. All verified present (once each) in CC
// 2.1.161's 84-verb array; they're made-up/brand words extremely unlikely to
// appear elsewhere in the bundle, so a false match on a different array is
// implausible. (Deep dive 2026-06-03; see [[cc-platform-specific-ext-dir]].)
const ANCHORS = [
  '"Discombobulating"', '"Flibbertigibbeting"', '"Combobulating"',
  '"Clauding"', '"Reticulating"', '"Smooshing"', '"Wibbling"', '"Booping"',
];
// >=2 comma-separated double-quoted tokens (the S0 multi-element requirement).
const ARRAY_RE = /\[(?:"[^"\\]*"\s*,\s*)+"[^"\\]*"\]/g;
const BLOCK_START = "/* VIBE-ADS-START */";
// Strip a previously-injected block delimited by EITHER the current markers
// or the legacy /* VIBADS-START/END */ markers. An install patched before the
// Vibe-Ads rename still carries the old markers; re-apply must not stack the
// block and restore-via-Tier-0 must still find it (reversibility contract).
const BLOCK_RE = /\/\* VIB(?:E-)?ADS-START \*\/[\s\S]*?\/\* VIB(?:E-)?ADS-END \*\//g;

/** Resolve the shipped block asset relative to `baseDir` (= dirname of the
 *  running adapter file). In the esbuild-bundled VSIX the adapter is inlined
 *  into dist/extension.js so baseDir=<dist> and the asset lives at
 *  dist/adapters/claude-code/block.asset.js (per esbuild.mjs). In unbundled
 *  vitest the adapter is src/adapters/claude-code/adapter.ts so the asset is
 *  co-located. Try both; first existing wins. (S3 Wave 1 review CRIT #1.) */
export function resolveBlockAsset(baseDir: string): string {
  return resolveAsset(baseDir, "adapters/claude-code", "block.asset.js");
}

// Atomic file replacement: write the new bytes to a temp sibling, then
// `rename` the temp over the target. POSIX `rename` is atomic; on Win32
// it is "best-effort atomic" but still crash-safe in practice — the
// target either holds the OLD bytes or the NEW bytes, never a partial
// write. This closes the wave-2A race where a power loss / CC self-
// update collision mid-`writeFileSync` could leave webview/index.js
// truncated. Falls back to a direct write if rename fails (e.g. on
// some Windows filesystems where ENOENT can race the temp creation),
// so the worst case stays the prior behavior, not a refusal to write.
function atomicWriteFile(target: string, data: Buffer): void {
  const tmp = target + ".kickbacks-tmp-" + process.pid + "-" + Date.now();
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  } catch {
    // best-effort cleanup of the temp; then fall back to a direct write
    // so we don't fail-closed on systems where rename semantics differ.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    writeFileSync(target, data);
  }
}

export class ClaudeCodeAdapter implements TargetAdapter {
  readonly name = "claude-code";
  private readonly target: string;
  constructor(target: string) { this.target = resolve(target); }

  // --- Approach C: relax the Claude Code chat-webview CSP ----------------
  // CC ships that webview with `default-src 'none'` and NO connect-src
  // (getHtmlForWebview in extension.js), so the injected block's loopback
  // fetch — clicks-metric, impressions, activity, debug log — is silently
  // CSP-blocked. The real click-through is handled by the anchor's http(s)
  // href (host-opened, CSP-exempt); this patch additionally revives the
  // owned loopback for billing/telemetry by inserting a connect-src into
  // that one dynamic CSP template. Sibling file (../extension.js), its own
  // one-time pristine backup, byte-exact restore, idempotent — same
  // reversibility contract as the index.js patch. Best-effort: a missing
  // sibling / absent anchor never fails applyPatch (the href still works).
  //
  // NOTE (known gap): only local loopback (127.0.0.1/localhost) is opened.
  // VS Code Remote/tunnels reach the loopback via an https asExternalUri
  // host that this literal does not cover — out of scope for the local trial.
  // The dynamic CSP template lives inside a JS template literal in
  // CC's extension.js. Across CC releases the first template variable after
  // `default-src 'none';` has been renamed (`${q}` in 2.1.143 → `${U}` in
  // 2.1.145), so a literal anchor silently bails on every CC upgrade and
  // billing telemetry quietly stops. Match the SHAPE instead — any single
  // template-variable token following `default-src 'none';` — and preserve
  // whatever variable was there via a capture group. The static (non-templated)
  // CSP that uses `{{NONCE}}` is intentionally NOT matched here so we don't
  // touch a CSP shape that's used in a different code path.
  private readonly CSP_ANCHOR_RE = /default-src 'none'; (\$\{[a-zA-Z_]\w*\})/;
  private readonly CSP_MARK = "connect-src http://127.0.0.1:*";
  // H3 (prime-directive): only emit the ADDITIVE connect-src that the loopback
  // needs (CC ships no connect-src, so there's no duplicate). We must NOT emit
  // a second `img-src`: CC's own template var (e.g. `${M}` = `img-src
  // ${cspSource} data:`) follows our insertion, and per CSP3 only the FIRST
  // `img-src` is honored — so a narrow ad-icon `img-src` here would silently
  // override CC's image policy and break CC's markdown/data:/webview images.
  // The ad favicon degrades to the inline SVG "K" badge, which is harmless.
  private readonly CSP_INSERT_PREFIX =
    "default-src 'none'; connect-src http://127.0.0.1:* http://localhost:*; ";

  private extTarget(): string {
    // target = <ext>/anthropic.claude-code-X/webview/index.js
    // sibling = <ext>/anthropic.claude-code-X/extension.js
    return join(dirname(dirname(this.target)), "extension.js");
  }
  private extBackupPath(): string { return this.extTarget() + ".vibe-ads-backup"; }

  /** Idempotent, reversible connect-src insertion. Never throws.
   *
   *  Returns the patch outcome so callers (debug.log) can surface a silent
   *  miss — `anchor missing` historically meant a CC version bumped the
   *  template variable name (e.g. ${q} → ${U} between 2.1.143 and 2.1.145),
   *  which silently broke every webview→loopback fetch (clicks, impressions,
   *  view-tracking ping-back) and was only detectable by a missing-line audit
   *  in debug.log. */
  private patchCspWithReason():
    { ok: boolean; reason?: "no-sibling" | "already" | "anchor-missing" | "io-err" } {
    try {
      const ext = this.extTarget();
      if (!existsSync(ext)) return { ok: false, reason: "no-sibling" };
      const src = readFileSync(ext, "utf8");
      if (src.includes(this.CSP_MARK)) return { ok: true, reason: "already" };
      const m = this.CSP_ANCHOR_RE.exec(src);
      if (!m) return { ok: false, reason: "anchor-missing" };
      if (!existsSync(this.extBackupPath()))
        writeFileSync(this.extBackupPath(), Buffer.from(src, "utf8")); // pristine
      // m[1] is the template variable token (e.g. "${q}" or "${U}"); preserve
      // it so the rest of CC's CSP template renders identically.
      const replaced = src.replace(this.CSP_ANCHOR_RE,
        this.CSP_INSERT_PREFIX + m[1]);
      writeFileSync(ext, Buffer.from(replaced, "utf8"));
      return { ok: true };
    } catch { return { ok: false, reason: "io-err" }; }
  }

  /** Back-compat shim. The href click-out never depended on this — but its
   *  silent failure DID hide a hard CC-upgrade regression for a release, so
   *  every applyPatch now also calls patchCspWithReason() and surfaces a dlog
   *  line (see applyPatch in this file). */
  private patchCsp(): void { this.patchCspWithReason(); }

  /** Prime the structural connect-src CSP relaxation WITHOUT injecting an ad
   *  block. See TargetAdapter.prime. Reuses the exact idempotent insertion
   *  applyPatch performs, so a later applyPatch is a no-op on the CSP and a
   *  routine restore({keepCsp:true}) keeps it. */
  prime(): OpResult {
    const r = this.patchCspWithReason();
    try {
      dlog("ext", "csp.prime", { ok: r.ok, reason: r.reason || "ok" });
    } catch { /* dlog must never break prime */ }
    return { ok: r.ok, reason: r.reason };
  }

  /** Byte-exact revert of the CSP patch from its pristine backup. Never throws. */
  private restoreCsp(): void {
    try {
      const bak = this.extBackupPath();
      if (!existsSync(bak)) return;
      const pristine = readFileSync(bak);
      writeFileSync(this.extTarget(), pristine);
      if (sha256(readFileSync(this.extTarget())) === sha256(pristine))
        rmSync(bak);
    } catch { /* best-effort */ }
  }

  private backupPath(): string { return this.target + ".kickbacks-backup"; }
  // Pre-rename installs wrote the pristine backup under earlier names; prefer
  // any existing backup (new OR legacy) so we never (a) lose the real pristine
  // by overwriting it with an already-patched file, nor (b) report "no backup"
  // when a legacy one exists. New backups use the .kickbacks-backup name.
  //   W1 (this rename):   .vibe-ads-backup   (the Vibe-Ads era)
  //   pre-S3 install:     .vibads-backup     (the original spelling)
  private legacyBackupPaths(): string[] {
    return [this.target + ".vibe-ads-backup",
            this.target + ".vibads-backup"];
  }
  private existingBackupPath(): string | null {
    if (existsSync(this.backupPath())) return this.backupPath();
    for (const p of this.legacyBackupPaths()) if (existsSync(p)) return p;
    return null;
  }

  private findArray(src: string): [number, number] | null {
    for (const m of src.matchAll(ARRAY_RE)) {
      if (ANCHORS.some((a) => m[0].includes(a)))
        return [m.index!, m.index! + m[0].length];
    }
    return null;
  }

  version(): string | null {
    // Version is the parent extension dir name segment, e.g.
    // .../anthropic.claude-code-2.1.143/webview/index.js — or, since CC moved to
    // platform-specific packages, .../anthropic.claude-code-2.1.161-win32-x64/…
    // Capture just the semver core so neither the status bar nor telemetry ever
    // shows the "-win32-x64" packaging suffix. Fall back to the raw tail if the
    // shape is unexpected, so a locatable dir never regresses to "unknown".
    const core = /anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(this.target);
    if (core) return core[1];
    const loose = /anthropic\.claude-code-([0-9][^/\\]*)/.exec(this.target);
    return loose ? loose[1] : "unknown";
  }

  /** True iff the live target currently carries our injected block. One
   *  cheap read; the debug reassert tick uses it so it only re-applies when
   *  the patch actually drifted (CC self-update / fresh load), never churning
   *  the loopback when already healthy. */
  isPatched(): boolean {
    try {
      return existsSync(this.target) &&
        readFileSync(this.target, "utf8").includes(BLOCK_START);
    } catch {
      return false;
    }
  }

  /** Ground-truth snapshot for the diagnose command. Never throws — every
   *  read is guarded so the report renders even on a half-broken install. */
  diagnose(): AdapterDiagnostics {
    const out: AdapterDiagnostics = {
      name: this.name, target: this.target, targetExists: existsSync(this.target),
      version: this.version(), compatible: false, isPatched: false,
      backup: { exists: false, path: null, hasArray: false, hasBlock: false },
      live: { hasArray: false, bareVerbPresent: false },
    };
    try {
      const pf = this.preflight();
      out.compatible = pf.compatible;
      out.reason = pf.reason;
      out.isPatched = this.isPatched();
      const bakPath = this.existingBackupPath();
      if (bakPath) {
        out.backup.exists = true;
        out.backup.path = bakPath;
        try {
          const b = readFileSync(bakPath, "utf8");
          out.backup.hasArray = this.findArray(b) !== null;
          out.backup.hasBlock = b.includes(BLOCK_START);
        } catch { /* leave defaults */ }
      }
      if (out.targetExists) {
        try {
          const live = readFileSync(this.target, "utf8");
          out.live.hasArray = this.findArray(live) !== null;
          // bare verb word present even if NOT inside a matchable array — the
          // tell that distinguishes "bundle format changed" from "file stripped".
          out.live.bareVerbPresent =
            ANCHORS.some((a) => live.includes(a.replace(/"/g, "")));
        } catch { /* leave defaults */ }
      }
    } catch { /* never throw */ }
    return out;
  }

  preflight(): PreflightResult {
    try {
      if (!existsSync(this.target))
        return { ok: true, compatible: false, version: null, reason: "target not found" };
      // Compatibility = the verb array is present in EITHER the pristine backup
      // OR the live file. We prefer the backup (an older Tier-0 swap could strip
      // the live anchor), but a STALE/TAINTED backup — a truncated capture, or a
      // crash / self-update race mid-write — must NOT dead-end activation: fall
      // back to the live file. The current patch only APPENDS a block and leaves
      // the verb array intact, so the live file is a safe fallback. Only when
      // NEITHER source carries the array is the build genuinely incompatible.
      // This breaks the "bad backup ⇒ permanent incompatible" trap, where
      // applyPatch's backup recapture never runs because preflight early-returns
      // first. The reason + source are logged so a field miss is diagnosable.
      const bak = this.existingBackupPath();
      const inBackup = bak !== null
        && this.findArray(readFileSync(bak, "utf8")) !== null;
      const inLive = inBackup
        || this.findArray(readFileSync(this.target, "utf8")) !== null;
      if (!inBackup && !inLive) {
        try {
          dlog("ext", "preflight.miss",
            { hadBackup: bak !== null, version: this.version() });
        } catch { /* dlog must never break preflight */ }
        return { ok: true, compatible: false, version: this.version(),
                 reason: bak !== null
                   ? "verb array not found (backup+live both stale)"
                   : "verb array not found (incompatible build)" };
      }
      return { ok: true, compatible: true, version: this.version() };
    } catch (e) {
      return { ok: false, compatible: false, version: null, reason: String(e) };
    }
  }

  private ensureBackup(): Buffer | null {
    const existing = this.existingBackupPath();
    if (existing) {
      const buf = readFileSync(existing);
      // Backup-integrity check. A backup is a valid pristine source only if it
      // (a) does NOT already contain our injected block AND (b) actually carries
      // the verb array. (a) guards a backup captured AFTER an earlier patch
      // leaked in (CC self-update mid-apply race) — reusing it would compound
      // the damage. (b) guards a truncated/mangled capture (the stale backup
      // that makes preflight read no array and dead-end) — patching from it
      // would inject into broken content and keep failing. Either defect ⇒
      // delete and recapture from the live file (the taint guard below refuses
      // the recapture when `target` itself is patched, so a poisoned backup is
      // never re-minted from a poisoned live file).
      const tainted = buf.indexOf(BLOCK_START) !== -1;
      const stale = this.findArray(buf.toString("utf8")) === null;
      if (tainted || stale) {
        try { dlog("ext", "backup.recapture",
          { path: existing, tainted, stale }); } catch { /* ignore */ }
        try { unlinkSync(existing); } catch { /* fall through */ }
      } else {
        return buf;
      }
    }
    const raw = readFileSync(this.target);
    // Taint guard (cross-window interleave): if the live file ALREADY carries
    // our block — e.g. another window re-patched right after this window's
    // restore() deleted the backup — capturing it would enshrine PATCHED bytes
    // as "pristine": a later restore() would write the ad block back, pass its
    // own sha check, delete the backup, and leave CC permanently patched even
    // after opt-out/kill. The patch is not byte-exactly strippable (applyPatch
    // collapses trailing whitespace before appending), so REFUSE to capture:
    // no backup is written, applyPatch treats it as apply-success-no-write,
    // and the next CC self-update delivers a fresh pristine file to capture.
    if (raw.indexOf(BLOCK_START) !== -1) {
      try { dlog("ext", "backup.refused",
        { reason: "live file already patched" }); } catch { /* ignore */ }
      return null;
    }
    writeFileSync(this.backupPath(), raw);
    return raw; // pristine
  }

  private renderBlock(p: PatchParams): string {
    const assetPath = resolveBlockAsset(dirname(__filename));
    let src = readFileSync(assetPath, "utf8");
    const subs: Record<string, string> = {
      __VIBE_ADS_TIER__: String(p.tier),
      __VIBE_ADS_AD__: JSON.stringify(p.adText),
      __VIBE_ADS_ICON__: JSON.stringify(p.iconRef),
      __VIBE_ADS_ICON_URL__: JSON.stringify(p.iconUrl),
      __VIBE_ADS_PORT__: String(p.loopbackPort),
      __VIBE_ADS_LBTOKEN__: JSON.stringify(p.loopbackToken),
      __VIBE_ADS_BASE__: JSON.stringify(p.loopbackBase ?? ""),
      __VIBE_ADS_DEBUG__: p.debug ? "true" : "false",
      __VIBE_ADS_CLICKTOKEN__: JSON.stringify(p.clickToken),
      __VIBE_ADS_CLICKURL__: JSON.stringify(p.clickUrl),
      __VIBE_ADS_CORR__: JSON.stringify(p.corr),
      // Mirror-of-spinner usage-banner ad gate (spec §4.1).
      __VIBE_ADS_BANNER_ON__: p.bannerOn ? "true" : "false",
      // W3: server-authoritative visible-time threshold (15 s default).
      __VIBE_ADS_VIEW_THRESHOLD_MS__:
        String(typeof p.viewThresholdMs === "number"
          && p.viewThresholdMs > 0 ? p.viewThresholdMs : 15000),
    };
    for (const [k, v] of Object.entries(subs))
      src = src.split(k).join(v);
    return src.trim();
  }

  applyPatch(p: PatchParams): OpResult {
    try {
      if (!existsSync(this.target)) return { ok: false, reason: "target not found" };
      const pristineBuf = this.ensureBackup();
      // Taint-guard refusal: target already patched and no pristine backup
      // exists to strip-and-reapply from. Do NOT write and do NOT capture —
      // serving continues off the on-disk block until a CC self-update
      // supplies a fresh pristine file. See ensureBackup.
      if (pristineBuf === null)
        return { ok: true, reason: "already patched; no pristine backup" };
      const pristine = pristineBuf.toString("utf8");
      // We still call findArray as a compatibility GATE — if the verb
      // array literal isn't where we expect, this CC build's spinner
      // layout has changed and our block's DOM selectors are likely
      // stale too. Refuse rather than silently inject into a build
      // we can't reliably target.
      if (this.findArray(pristine) === null)
        return { ok: false, reason: "verb array not found" };
      // We used to ALSO collapse the verb array to `[adText, ""]` so
      // a degraded run (block fails to load) would at least flash the
      // ad as plain text in the spinner. That backfired: it MASKED
      // block.desync — the user couldn't tell when our overlay
      // failed because the underlying spinner just rendered the ad
      // text directly. Leaving the array intact means a failed block
      // shows CC's normal "Discombobulating…" / "Baking…" verbs, a
      // clear signal that something is wrong. The overlay still
      // covers the verb via DOM when the block runs.
      let out = pristine.replace(BLOCK_RE, "").replace(/\s+$/, "");
      out = out + "\n" + this.renderBlock(p) + "\n";
      const outBuf = Buffer.from(out, "utf8");
      if (sha256(outBuf) !== sha256(readFileSync(this.target)))
        atomicWriteFile(this.target, outBuf);
      // approach C: revive the loopback (best-effort). Surface the outcome to
      // debug.log so a future CC CSP-template rename can't silently kill
      // billing telemetry again (see CSP_ANCHOR_RE comment).
      const cspResult = this.patchCspWithReason();
      try {
        dlog("ext", "csp.patch",
          { ok: cspResult.ok, reason: cspResult.reason || "ok" });
      } catch { /* dlog must never break applyPatch */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  // `keepCsp` keeps the sibling extension.js connect-src relaxation in place
  // while still byte-exact reverting the VISIBLE verb/block change in index.js.
  // Routine deactivate() passes this: Claude Code captures its webview CSP
  // template into memory at extension-host load (before our re-patch), so a
  // CSP reverted on every deactivate would NEVER be effective for the running
  // session and loopback telemetry (billing) stays CSP-blocked forever. The
  // relaxation is invisible and loopback-scoped; explicit restore / kill-
  // switch / sign-out still pass no opts and fully revert it (prime directive
  // for any user-initiated teardown).
  restore(opts?: { keepCsp?: boolean }): RestoreResult {
    try {
      const bak = this.existingBackupPath();
      if (bak === null) {
        // No visible-block backup — e.g. prime() relaxed the CSP on boot but
        // an ad never arrived to applyPatch a block. An explicit restore (no
        // keepCsp: kill-switch / sign-out / "Restore Claude Code") must STILL
        // revert the primed sibling CSP, or a primed-but-never-patched install
        // would leave CC's extension.js modified with no way back. Mirrors the
        // codex adapter's restore() (prime directive: opt-out fully reverts).
        if (!opts?.keepCsp) this.restoreCsp();
        return { ok: true, restored: false, reason: "no backup present" };
      }
      const pristine = readFileSync(bak);
      // Taint guard: a backup captured from an already-patched live file (a
      // pre-guard ensureBackup could mint one) carries our block — writing it
      // verbatim would REINSTATE the ad, pass the sha check below, and delete
      // the only backup. Strip our own block first so restore always removes
      // the ad (the stripped bytes are the closest-to-pristine we hold).
      let out = pristine;
      if (pristine.indexOf(BLOCK_START) !== -1) {
        try { dlog("ext", "restore.strip-tainted-backup", { path: bak }); }
        catch { /* ignore */ }
        out = Buffer.from(
          pristine.toString("utf8").replace(BLOCK_RE, ""), "utf8");
      }
      writeFileSync(this.target, out);
      const now = sha256(readFileSync(this.target));
      if (now !== sha256(out))
        return { ok: false, restored: false, reason: "sha256 mismatch after restore" };
      rmSync(bak);
      if (!opts?.keepCsp) this.restoreCsp(); // approach C: revert sibling CSP
      return { ok: true, restored: true };
    } catch (e) {
      return { ok: false, restored: false, reason: String(e) };
    }
  }
}
