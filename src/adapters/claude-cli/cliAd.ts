import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
         statSync } from "node:fs";
import { transcriptEntrypoint } from "../../locate";

/** Ad considered fresh for 10 minutes after the extension last wrote it. */
export const FRESH_MS = 10 * 60 * 1000;

export interface CliAd { adText: string; iconRef: string; iconUrl: string;
                         clickUrl: string; ts: number; }

export function vibeAdsDir(home = homedir()): string {
  return join(home, ".vibe-ads");
}
export function cliAdPath(home = homedir()): string {
  return join(vibeAdsDir(home), "cli-ad.json");
}

/** Terminal esc()-analog: strip control chars (C0 + DEL + C1) — and ONLY
 *  those — so cached fields can never smuggle ANSI/OSC bytes into a terminal
 *  surface. Emoji / pipes / unicode / URLs pass through untouched. */
export function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function writeCliAdCache(
  home: string,
  ad: { adText: string; iconRef: string; iconUrl: string; clickUrl: string },
): void {
  const dir = vibeAdsDir(home);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const rec: CliAd = {
    adText: stripControlChars(ad.adText),
    iconRef: stripControlChars(ad.iconRef),
    iconUrl: stripControlChars(ad.iconUrl),
    clickUrl: stripControlChars(ad.clickUrl),
    ts: Date.now(),
  };
  writeFileSync(cliAdPath(home), JSON.stringify(rec), "utf8");
}

export function readCliAdCache(home: string): CliAd | null {
  try {
    const raw = readFileSync(cliAdPath(home), "utf8");
    const o = JSON.parse(raw) as CliAd;
    if (typeof o.adText === "string" && typeof o.ts === "number") return o;
    return null;
  } catch { return null; }
}

/** Evidence that a `claude` CLI session is plausibly live: a
 *  ~/.claude/projects/ ** /*.jsonl transcript was modified within `windowMs`
 *  AND is tagged entrypoint:"cli" or untagged (older CC builds stay fail-open
 *  as CLI-plausible). Any OTHER positive tag is excluded — the VS Code
 *  panel's "claude-vscode" (editor turns write the same tree; counting them
 *  inflated statusline/spinner impression counts for a surface that never
 *  rendered, audit #30) and equally sdk/desktop/agent tags (2026-06-11:
 *  a `!== "claude-vscode"` filter counted headless-SDK activity as a live
 *  TUI, emitting statusline impressions nobody saw while the tick loop —
 *  strictly "cli"-tagged — stayed silent; the two signals must accept the
 *  SAME set: "cli" | untagged, mirroring locateClaudeCliLog).
 *  `root` overridable for tests. Never throws. */
export function cliSessionActive(
  now: number, windowMs: number, root = join(homedir(), ".claude", "projects"),
): boolean {
  try {
    if (!existsSync(root)) return false;
    const recent: { p: string; m: number }[] = [];
    for (const proj of readdirSync(root)) {
      let entries: string[];
      try { entries = readdirSync(join(root, proj)); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(root, proj, f);
        try {
          const m = statSync(p).mtimeMs;
          if (m > 0 && (now - m) <= windowMs) recent.push({ p, m });
        } catch { /* ignore */ }
      }
    }
    // Newest-first so the common case (one live transcript) probes one head.
    recent.sort((a, b) => b.m - a.m);
    return recent.some((c) => {
      const tag = transcriptEntrypoint(c.p);
      return tag === "cli" || tag === null;
    });
  } catch { return false; }
}

export function shouldCountCliImpression(s: {
  signedIn: boolean; haveAd: boolean; sessionActive: boolean;
  adId: string; lastCountedAdId: string | null;
}): boolean {
  return s.signedIn && s.haveAd && s.sessionActive
    && s.adId.length > 0 && s.adId !== s.lastCountedAdId;
}

/** Pure predicate: should we count the CLI spinner-verb impression this tick?
 *  Same dedup-per-adId rule as the statusline (`shouldCountCliImpression`),
 *  gated ADDITIONALLY on `supportConfirmed` — true only once `claude --version`
 *  has positively confirmed the CLI honours `spinnerVerbs` (CC >= 2.1.143).
 *  This is distinct from the adapter's fail-open `spinnerVerbsSupported` RENDER
 *  flag (which defaults true so the verb is written optimistically before
 *  detection resolves): billing must wait for confirmation, else the first
 *  synchronous activation sync on an old CLI bills for a verb that never
 *  renders. */
export function shouldCountSpinnerImpression(s: {
  supportConfirmed: boolean;
  signedIn: boolean; haveAd: boolean; sessionActive: boolean;
  adId: string; lastCountedAdId: string | null;
}): boolean {
  return s.supportConfirmed && shouldCountCliImpression(s);
}
