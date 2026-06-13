import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { TargetAdapter, PreflightResult, OpResult, RestoreResult, PatchParams }
  from "../types";
import { sha256 } from "../../util/crypto";
import { resolveAsset } from "../../util/asset";

// Strip a previously-injected block (current OR legacy markers) so re-apply
// never stacks and preflight evaluates the pristine shape — same reversibility
// contract as the Claude Code adapter.
const BLOCK_START = "/* VIBE-ADS-START */";
const BLOCK_END = "/* VIBE-ADS-END */";
// Codex injection is an INLINE wrapper `arg=(<block>)||arg;`, unlike the
// Claude Code adapter's appended standalone block. Stripping must remove the
// WHOLE wrapper, not just the comment-delimited body — else a re-derive from
// an already-patched file (no backup) leaves an empty `arg=()||arg;`, a hard
// syntax error that ACCUMULATES on every reassert (the "finnicky / stopped
// working" root cause). Three forms are stripped, in order:
//   1. current:  /* START */arg=(...)||arg;/* END */   (markers OUTSIDE)
//   2. legacy:   arg=(/* START */...../* END */)||arg;  (markers inside)
//   3. residue:  arg=()||arg;  (legacy form after a markers-only strip)
const ID = "[A-Za-z_$][\\w$]*";
const STRIP_RES: RegExp[] = [
  // 1 + 2: optional `ident=(` prefix and `)||ident;` suffix around the markers
  new RegExp(
    "(?:" + ID + "=\\()?" +
    "\\/\\* VIB(?:E-)?ADS-START \\*\\/[\\s\\S]*?\\/\\* VIB(?:E-)?ADS-END \\*\\/" +
    "(?:\\)\\|\\|" + ID + ";)?", "g"),
  // 3: empty-wrapper residue. `=()||ident;` cannot occur in valid minified JS
  // (`()` is not a valid expression), so matching it is safe and targeted.
  new RegExp(ID + "=\\(\\)\\|\\|" + ID + ";", "g"),
];
/** Remove every historical Vibe-Ads injection form so a re-derived pristine is
 *  byte-true to the original chunk (self-heals accumulated corruption). */
function stripInjection(s: string): string {
  for (const re of STRIP_RES) s = s.replace(re, "");
  return s;
}
// Whitespace-tolerant: the real chunk is minified (`export{v as n,...}`) but
// tolerating optional spaces is strictly safer against minifier variation and
// still matches the minified form.
const EXPORT_RE = /export\s*\{([^}]*)\}/;              // the chunk's export map
const JSX_RE = /\(0,\s*([A-Za-z0-9_$]+)\.jsxs?\)/;     // (0,d.jsx) | (0,d.jsxs)
const CSP_CONNECT_RE = /`connect-src\s+([^`]*)`/g;
const CSP_MARK = "connect-src http://127.0.0.1:*";
const CSP_INSERT = "http://127.0.0.1:* http://localhost:*";

/** Resolve the shipped Codex block asset relative to `baseDir` (= dirname of
 *  the running adapter file). Unbundled vitest: co-located. esbuild-bundled
 *  VSIX: dist/adapters/codex/. Try both; first existing wins — mirrors the
 *  Claude Code adapter's resolveBlockAsset contract (the S3 Wave-1 CRIT). */
export function resolveCodexBlockAsset(baseDir: string): string {
  return resolveAsset(baseDir, "adapters/codex", "block.asset.js");
}

export class CodexAdapter implements TargetAdapter {
  readonly name = "codex";
  private readonly target: string;
  constructor(target: string) { this.target = resolve(target); }

  private backupPath(): string { return this.target + ".vibe-ads-backup"; }
  // Pre-rename installs wrote ".vibads-backup"; prefer any existing backup so
  // we never overwrite the real pristine nor falsely report "no backup".
  private legacyBackupPath(): string { return this.target + ".vibads-backup"; }
  private existingBackupPath(): string | null {
    if (existsSync(this.backupPath())) return this.backupPath();
    if (existsSync(this.legacyBackupPath())) return this.legacyBackupPath();
    return null;
  }

  private extensionRoot(): string {
    // target = <ext>/webview/assets/thinking-shimmer-<hash>.js
    return dirname(dirname(dirname(this.target)));
  }
  private extTarget(): string | null {
    const root = this.extensionRoot();
    const candidates = [
      join(root, "out", "extension.js"),
      join(root, "extension.js"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  private extBackupPath(ext: string): string {
    return ext + ".vibe-ads-backup";
  }

  /** Codex's overlay can render while CSP blocks every loopback fetch. Add
   *  loopback hosts to Codex's existing connect-src template so impression,
   *  view_tick, click, and debug-log pings can leave the webview. */
  private patchCspWithReason():
    { ok: boolean; reason?: "no-sibling" | "already" | "anchor-missing" | "io-err" } {
    try {
      const ext = this.extTarget();
      if (!ext) return { ok: false, reason: "no-sibling" };
      const src = readFileSync(ext, "utf8");
      if (src.includes(CSP_MARK)) return { ok: true, reason: "already" };
      let changed = false;
      const patched = src.replace(CSP_CONNECT_RE, (_m, rest: string) => {
        changed = true;
        return "`connect-src " + CSP_INSERT + " " + rest.trim() + "`";
      });
      if (!changed) return { ok: false, reason: "anchor-missing" };
      const bak = this.extBackupPath(ext);
      if (!existsSync(bak))
        writeFileSync(bak, Buffer.from(src, "utf8"));
      writeFileSync(ext, Buffer.from(patched, "utf8"));
      return { ok: true };
    } catch {
      return { ok: false, reason: "io-err" };
    }
  }

  /** Prime the loopback connect-src CSP relaxation WITHOUT injecting a block.
   *  See TargetAdapter.prime. Idempotent + reversible (same keepCsp contract
   *  as applyPatch's CSP layer); a later applyPatch is a no-op on the CSP. */
  prime(): OpResult {
    const r = this.patchCspWithReason();
    return { ok: r.ok, reason: r.reason };
  }

  private restoreCsp(): void {
    try {
      const ext = this.extTarget();
      if (!ext) return;
      const bak = this.extBackupPath(ext);
      if (!existsSync(bak)) return;
      const pristine = readFileSync(bak);
      writeFileSync(ext, pristine);
      if (sha256(readFileSync(ext)) === sha256(pristine))
        rmSync(bak);
    } catch { /* best-effort */ }
  }

  /** The ThinkingShimmer entry: the identifier re-exported `as n`, plus its
   *  `function NAME(ARG){` site (insertion point is just past the `{`). */
  private locateEntry(src: string):
    { name: string; arg: string; at: number } | null {
    const ex = EXPORT_RE.exec(src);
    if (!ex) return null;
    const m = /([A-Za-z0-9_$]+)\s+as\s+n\b/.exec(ex[1]);
    if (!m) return null;
    const sig = new RegExp(
      "function\\s+" + m[1] + "\\s*\\(\\s*([A-Za-z0-9_$]+)\\s*\\)\\s*\\{"
    ).exec(src);
    if (!sig) return null;
    return { name: m[1], arg: sig[1], at: sig.index + sig[0].length };
  }
  private jsxName(src: string): string | null {
    const m = JSX_RE.exec(src);
    return m ? m[1] : null;
  }

  version(): string | null {
    // .../openai.chatgpt-<ver>/webview/assets/thinking-shimmer-<hash>.js
    const m = /openai\.chatgpt-([0-9][^/\\]*)/.exec(this.target);
    return m ? m[1] : "unknown";
  }

  /** True iff the live target currently carries our injected block. */
  isPatched(): boolean {
    try {
      return existsSync(this.target) &&
        readFileSync(this.target, "utf8").includes(BLOCK_START);
    } catch {
      return false;
    }
  }

  preflight(): PreflightResult {
    try {
      if (!existsSync(this.target))
        return { ok: true, compatible: false, version: null,
                 reason: "target not found" };
      // Evaluate against the pristine shape: a co-located backup means WE
      // patched this exact file, and our block strip-by-marker keeps the
      // anchor scan honest even on an already-patched live file.
      const bak = this.existingBackupPath();
      const raw = readFileSync(bak ?? this.target, "utf8");
      const src = stripInjection(raw);
      const ok = this.locateEntry(src) !== null
        && /defaultMessage:`Thinking`/.test(src)
        && this.jsxName(src) !== null;
      return ok
        ? { ok: true, compatible: true, version: this.version() }
        : { ok: true, compatible: false, version: this.version(),
            reason: "thinking-shimmer anchors not found (incompatible build)" };
    } catch (e) {
      return { ok: false, compatible: false, version: null, reason: String(e) };
    }
  }

  private renderBlock(p: PatchParams, arg: string, jsx: string): string {
    const assetPath = resolveCodexBlockAsset(dirname(__filename));
    let src = readFileSync(assetPath, "utf8").trim();
    const subs: Record<string, string> = {
      __VIBE_ADS_ARG__: arg,                       // bare identifier (e)
      __VIBE_ADS_JSX__: jsx,                       // bare identifier (d)
      __VIBE_ADS_AD__: JSON.stringify(p.adText),
      __VIBE_ADS_PORT__: String(p.loopbackPort),
      __VIBE_ADS_LBTOKEN__: JSON.stringify(p.loopbackToken),
      __VIBE_ADS_BASE__: JSON.stringify(p.loopbackBase ?? ""),
      __VIBE_ADS_CLICKTOKEN__: JSON.stringify(p.clickToken),
      __VIBE_ADS_CLICKURL__: JSON.stringify(p.clickUrl),
      __VIBE_ADS_CORR__: JSON.stringify(p.corr),
      __VIBE_ADS_DEBUG__: p.debug ? "true" : "false",
      __VIBE_ADS_VIEW_THRESHOLD_MS__: String(
        typeof p.viewThresholdMs === "number" && p.viewThresholdMs > 0
          ? p.viewThresholdMs : 15000),
    };
    for (const [k, v] of Object.entries(subs)) src = src.split(k).join(v);
    return src;
  }

  applyPatch(p: PatchParams): OpResult {
    try {
      if (!existsSync(this.target))
        return { ok: false, reason: "target not found" };
      // Validate anchors on the pristine shape BEFORE taking a backup, so an
      // incompatible build never leaves a stray .vibe-ads-backup behind.
      const live = readFileSync(this.target, "utf8");
      const bak = this.existingBackupPath();
      // Re-derive the TRUE pristine: strip every historical injection form
      // (current/legacy/residue) from the backup if present, else the live
      // file. stripInjection is byte-true to the original chunk, so this
      // self-heals a file corrupted by the old marker-only strip.
      const pristine = stripInjection(
        bak ? readFileSync(bak, "utf8") : live);
      const loc = this.locateEntry(pristine);
      const jsx = this.jsxName(pristine);
      if (!loc || !jsx) return { ok: false, reason: "anchors not found" };
      // One-time backup of the CLEAN pristine — never a patched/corrupted
      // snapshot (the old ensureBackup stored raw live bytes, which is how a
      // backup itself could become poisoned).
      if (!bak)
        writeFileSync(this.backupPath(), Buffer.from(pristine, "utf8"));
      const block = this.renderBlock(p, loc.arg, jsx);
      // Inject as the entry's first statement, BEFORE the props destructure +
      // React-Compiler memo cache. Markers wrap the WHOLE `arg=(IIFE)||arg;`
      // statement (OUTSIDE the wrapper) so a future strip removes it entirely
      // — no empty-wrapper residue can ever be left behind. The IIFE always
      // returns undefined (`arg = undefined || arg`) so Codex's component is
      // never altered; the ad renders via a body-level overlay.
      const out = pristine.slice(0, loc.at) +
        BLOCK_START + loc.arg + "=(" + block + ")||" + loc.arg + ";" +
        BLOCK_END + pristine.slice(loc.at);
      const buf = Buffer.from(out, "utf8");
      if (sha256(buf) !== sha256(readFileSync(this.target)))
        writeFileSync(this.target, buf);
      this.patchCspWithReason();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  // `keepCsp` is part of the shared TargetAdapter contract. Routine extension
  // deactivate keeps the invisible loopback-only CSP relaxation; explicit
  // restore / kill / sign-out fully reverts it.
  restore(opts?: { keepCsp?: boolean }): RestoreResult {
    try {
      const bak = this.existingBackupPath();
      if (bak === null) {
        if (!opts?.keepCsp) this.restoreCsp();
        return { ok: true, restored: false, reason: "no backup present" };
      }
      const pristine = readFileSync(bak);
      writeFileSync(this.target, pristine);
      if (sha256(readFileSync(this.target)) !== sha256(pristine))
        return { ok: false, restored: false,
                 reason: "sha256 mismatch after restore" };
      rmSync(bak);
      if (!opts?.keepCsp) this.restoreCsp();
      return { ok: true, restored: true };
    } catch (e) {
      return { ok: false, restored: false, reason: String(e) };
    }
  }
}

/** Spec §4.4 display gate (the tested mirror of the block-asset inline check).
 *  Codex's ThinkingShimmer entry receives `e.message`: null/undefined when it
 *  is about to render its own i18n "Thinking" placeholder, or a status element
 *  (`{props}`) the host wants shown instead. We override ONLY the generic
 *  thinking surface — every real tool / approval / reviewer / arbitrary status
 *  passes through untouched (prime directive: never mask real UI). */
export function isThinkingMessage(m: unknown): boolean {
  if (m == null) return true;
  if (typeof m !== "object") return false;
  const p = (m as { props?: Record<string, unknown> }).props;
  if (!p) return false;
  return p.id === "reasoningItem.thinking"
      || p.id === "thinkingShimmer.default"
      || p.defaultMessage === "Thinking";
}
