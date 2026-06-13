import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync, statSync, openSync, readSync,
         closeSync } from "node:fs";
import { compareClaudeCodeInstall } from "./util/claudeCodeVersion";

// readdir-based glob for `<root>/anthropic.claude-code-*/webview/index.js`.
// Swapped from `node:fs`'s `globSync` (the installed @types/node@20 lacks the
// declaration though Node 22 has it at runtime). Returns absolute paths; never throws.
export function globClaudeCode(root: string): string[] {
  try {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const name of readdirSync(root)) {
      if (!name.startsWith("anthropic.claude-code-")) continue;
      const idx = join(root, name, "webview", "index.js");
      if (existsSync(idx)) out.push(idx);
    }
    return out;
  } catch { return []; }
}

export function locateClaudeCode(): string | null {
  // Explicit escape hatch for S5 matrix / manual smoke / portable installs.
  const explicit = process.env.KICKBACKS_CC_TARGET
    || process.env.VIBE_ADS_CC_TARGET;
  if (explicit && existsSync(explicit)) return explicit;
  // Covers local (.vscode/.vscode-insiders/.cursor) AND remote/server hosts
  // (Remote-SSH, dev containers, vscode.dev) where extensions live under
  // *-server/. Keep in sync with ROOTS in adapters/registry.ts.
  for (const root of [join(homedir(), ".vscode", "extensions"),
                       join(homedir(), ".vscode-insiders", "extensions"),
                       join(homedir(), ".vscode-server", "extensions"),
                       join(homedir(), ".vscode-server-insiders", "extensions"),
                       join(homedir(), ".cursor", "extensions"),
                       join(homedir(), ".cursor-server", "extensions")]) {
    try {
      const hits = globClaudeCode(root).sort(compareClaudeCodeInstall);
      if (hits.length) return hits[hits.length - 1];
    } catch { /* ignore */ }
  }
  return null;
}

/** Best-effort `entrypoint` tag of a session transcript: "claude-vscode" for
 *  the interactive VS Code panel, "cli" for terminal sessions. Reads the head
 *  of the file and returns the first record's top-level `entrypoint` string,
 *  or null when untagged/unreadable (older CC builds; queue-operation lines
 *  carry no tag, so we scan past them). Line-parsed JSON — a transcript whose
 *  message TEXT merely quotes `"entrypoint":"cli"` cannot spoof the tag.
 *  Never throws. */
export function transcriptEntrypoint(path: string): string | null {
  const hit = entrypointCache.get(path);
  if (hit !== undefined) return hit;
  const tag = readTranscriptEntrypoint(path);
  if (tag !== null) {
    if (entrypointCache.size >= ENTRYPOINT_CACHE_MAX) {
      const oldest = entrypointCache.keys().next().value as string;
      entrypointCache.delete(oldest);
    }
    entrypointCache.set(path, tag);
  }
  return tag;
}

// Per-path tag memo: a transcript's entrypoint tag is written once at session
// start and never changes, so a TAGGED result is cacheable for the process
// lifetime — this keeps the repeated locate/cliSessionActive probes (statusbar
// poll, 60s cliSync tick) from re-reading the same heads. Untagged (null)
// results are NOT cached: a brand-new session's head may not be flushed yet.
const entrypointCache = new Map<string, string>();
const ENTRYPOINT_CACHE_MAX = 256;

function readTranscriptEntrypoint(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString("utf8", 0, n);
    } finally { closeSync(fd); }
    for (const ln of text.split("\n")) {
      if (!ln) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(ln) as Record<string, unknown>; }
      catch { continue; }                  // sliced tail line / junk
      if (typeof o.entrypoint === "string") return o.entrypoint;
    }
    return null;
  } catch { return null; }
}

// Mtime-sorted (newest first) scan of every transcript under
// ~/.claude/projects — shared by the per-surface resolvers below.
function scanTranscripts(): { p: string; m: number }[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const cands: { p: string; m: number }[] = [];
  for (const proj of readdirSync(root)) {
    let entries: string[];
    try { entries = readdirSync(join(root, proj)); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(root, proj, f);
      try { cands.push({ p, m: statSync(p).mtimeMs }); } catch { /* ignore */ }
    }
  }
  cands.sort((a, b) => b.m - a.m);
  return cands;
}

// Discover Claude Code's live JSONL transcript. CRITICAL: multiple Claude
// sessions can share a cwd (e.g. an interactive VS Code session AND a CLI/
// agent session). "Newest jsonl" alone tails whichever moved last — often the
// wrong one, so `done`/tool track a different session. We therefore prefer the
// newest transcript whose `entrypoint` is "claude-vscode" (the interactive VS
// Code instance whose webview we patch); fall back to newest-overall only if
// none are tagged (older CC builds). VIBE_ADS_CC_LOG overrides. "" => LogTail
// yields null => block self-simulates.
export function locateClaudeCodeLog(): string {
  const explicit = process.env.KICKBACKS_CC_LOG
    || process.env.VIBE_ADS_CC_LOG;
  if (explicit && existsSync(explicit)) return explicit;
  try {
    const cands = scanTranscripts();
    if (!cands.length) return "";
    // Documented filter (audit #24): newest transcript positively tagged
    // entrypoint:"claude-vscode" wins; fall back to the newest UNTAGGED one
    // (older CC builds); when every probed candidate is tagged as another
    // surface (e.g. "cli") return "" — no signal beats a wrong signal (a
    // terminal session would feed the desync watchdog a false "CC active").
    // Probes are bounded to the newest few: anything older isn't live.
    // NOTE: when multiple VS Code sessions share a cwd they're all tagged
    // "claude-vscode" with NO filesystem signal identifying which belongs to
    // this window — newest-mtime stays the best available proxy among them.
    let newestUntagged = "";
    for (const c of cands.slice(0, 20)) {
      const tag = transcriptEntrypoint(c.p);
      if (tag === "claude-vscode") return c.p;
      if (tag === null && !newestUntagged) newestUntagged = c.p;
    }
    return newestUntagged;
  } catch { return ""; }
}

// The TERMINAL-side mirror of locateClaudeCodeLog: newest transcript
// positively tagged entrypoint:"cli" (a `claude` TUI session); falls back to
// the newest UNTAGGED transcript when no "cli" tag is found (older CC builds
// write no tag — pre-fix this resolver refused them, so a TUI user on an
// untagged build saw statusline/spinner ads all day and NEVER earned: the
// 2026-06-11 launch-day cohort, 26 users at $0. The impression counter
// (cliSessionActive) was already fail-open for untagged, so the books showed
// impressions-without-ticks — exactly the Steven signature). Positively
// OTHER-tagged transcripts (sdk-*, desktop, claude-vscode…) are still never
// claimed: those sessions render no statusline, so ticking them would bill a
// surface nobody sees. Untagged MAY double-claim with locateClaudeCodeLog's
// own untagged fallback; that is financially safe — billable view events
// share the server-side per-(user,ad) cooldown bucket across surfaces, so a
// cross-surface double-tick is written as a zero-debit audit row.
// Consumers: the statusline view-tick loop (cliTick).
export function locateClaudeCliLog(): string {
  const explicit = process.env.KICKBACKS_CLI_LOG;
  if (explicit && existsSync(explicit)) return explicit;
  try {
    const cands = scanTranscripts();
    let newestUntagged = "";
    for (const c of cands.slice(0, 20)) {
      const tag = transcriptEntrypoint(c.p);
      if (tag === "cli") return c.p;
      if (tag === null && !newestUntagged) newestUntagged = c.p;
    }
    return newestUntagged;
  } catch { return ""; }
}
