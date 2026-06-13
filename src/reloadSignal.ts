import { join } from "node:path";
import { homedir } from "node:os";

export interface ReloadSentinel { version: string; ts: string; }

/** Fixed sentinel path shared by the deploy script and the extension watcher. */
export function reloadSentinelPath(): string {
  return join(homedir(), ".vibe-ads", "reload");
}

/** Parse the sentinel payload. Returns null for any malformed/half-written
 *  input or a payload missing `version` — callers must never throw on this. */
export function parseSentinel(raw: string): ReloadSentinel | null {
  try {
    const o = JSON.parse(raw) as Partial<ReloadSentinel>;
    if (!o || typeof o.version !== "string" || o.version.length === 0) return null;
    return { version: o.version, ts: typeof o.ts === "string" ? o.ts : "" };
  } catch { return null; }
}

export type ReloadDecision = "reload-now" | "nudge" | "none";

/** Pure decision: act only when the sentinel was touched strictly after this
 *  activation (armedAt) AND its version differs from the running build. Both
 *  actionable results ("reload-now"/"nudge") now map to the same soft
 *  ext-host restart in the consumer (no window reload, no prompt); the enum
 *  is kept for back-compat with existing callers/tests. "none" = no-op. */
export function decideReload(p: {
  mtimeMs: number; armedAt: number;
  sentinelVersion: string; runningVersion: string; debug: boolean;
}): ReloadDecision {
  if (p.mtimeMs <= p.armedAt) return "none";
  if (p.sentinelVersion === p.runningVersion) return "none";
  return p.debug ? "reload-now" : "nudge";
}
