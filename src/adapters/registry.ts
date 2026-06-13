import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import type { TargetAdapter } from "./types";
import { ClaudeCodeAdapter } from "./claude-code/adapter";
import { CodexAdapter } from "./codex/adapter";
import { compareClaudeCodeInstall } from "../util/claudeCodeVersion";

// Same host roots locate.ts scans for Claude Code (keep the lists in sync):
// local (.vscode/.vscode-insiders/.cursor) AND remote/server hosts
// (Remote-SSH, dev containers, vscode.dev) where extensions live under
// *-server/.
const ROOTS = [".vscode", ".vscode-insiders", ".vscode-server",
  ".vscode-server-insiders", ".cursor", ".cursor-server"]
  .map((d) => join(homedir(), d, "extensions"));

// An env override is AUTHORITATIVE when set (non-empty): return it iff it
// exists, else treat the target as absent — never silently fall back to a
// machine scan. Keeps the discovery matrix hermetic and makes an explicit
// S5/manual-smoke override predictable. `undefined` => env unset => scan.
function envTarget(name: string): string | null | undefined {
  const v = process.env[name];
  if (!v) return undefined;                 // unset/empty => fall through to scan
  return existsSync(v) ? v : null;          // set => authoritative (exists or absent)
}

// Newest `<root>/<prefix>*/<...sub>` across all host roots. Highest semantic
// Claude Code version wins; lexical ordering is only a fallback for unexpected
// names. Never throws.
function newestUnder(prefix: string, sub: string[]): string | null {
  for (const root of ROOTS) {
    try {
      if (!existsSync(root)) continue;
      const hits: string[] = [];
      for (const name of readdirSync(root)) {
        if (!name.startsWith(prefix)) continue;
        const p = join(root, name, ...sub);
        if (existsSync(p)) hits.push(p);
      }
      hits.sort(compareClaudeCodeInstall);
      if (hits.length) return hits[hits.length - 1];
    } catch { /* ignore this root */ }
  }
  return null;
}

// Codex ships the entry component in a content-hashed chunk:
// openai.chatgpt-<ver>/webview/assets/thinking-shimmer-<hash>.js — glob the
// assets dir for the prefix (newest extension dir, first matching chunk).
function newestCodexChunk(): string | null {
  for (const root of ROOTS) {
    try {
      if (!existsSync(root)) continue;
      const ext = readdirSync(root)
        .filter((n) => n.startsWith("openai.chatgpt-")).sort();
      for (let i = ext.length - 1; i >= 0; i--) {
        const assets = join(root, ext[i], "webview", "assets");
        if (!existsSync(assets)) continue;
        const cf = readdirSync(assets)
          .filter((n) => /^thinking-shimmer-.*\.js$/.test(n)).sort();
        if (cf.length) return join(assets, cf[0]);
      }
    } catch { /* ignore this root */ }
  }
  return null;
}

export interface TargetEntry {
  id: string;
  locate(): string | null;
  make(target: string): TargetAdapter;
}

// Order = precedence: claude-code is the "primary" (spec S9-5) — its version
// is the one reported to the backend / status bar.
export const REGISTRY: TargetEntry[] = [
  {
    id: "claude-code",
    locate: () => {
      const ev = envTarget("KICKBACKS_CC_TARGET")
        ?? envTarget("VIBE_ADS_CC_TARGET");
      if (ev !== undefined) return ev;        // authoritative when set
      return newestUnder("anthropic.claude-code-", ["webview", "index.js"]);
    },
    make: (t) => new ClaudeCodeAdapter(t),
  },
  {
    id: "codex",
    locate: () => {
      const ev = envTarget("KICKBACKS_CODEX_TARGET")
        ?? envTarget("VIBE_ADS_CODEX_TARGET");
      if (ev !== undefined) return ev;        // authoritative when set
      return newestCodexChunk();
    },
    make: (t) => new CodexAdapter(t),
  },
];

/** The Codex chunk target on this host (env override authoritative when set,
 *  else newest install), or null. Never throws — lets extension.ts wire Codex
 *  as a guarded, additive second target without duplicating the scan. */
export function locateCodexTarget(): string | null {
  try {
    return REGISTRY.find((e) => e.id === "codex")!.locate();
  } catch { return null; }
}

/** Every target present on this host, in registry (precedence) order. One bad
 *  locator never blocks the others (each guarded). */
export function discover(): { id: string; adapter: TargetAdapter }[] {
  const out: { id: string; adapter: TargetAdapter }[] = [];
  for (const e of REGISTRY) {
    try {
      const t = e.locate();
      if (t) out.push({ id: e.id, adapter: e.make(t) });
    } catch { /* one bad locator never blocks the other */ }
  }
  return out;
}
