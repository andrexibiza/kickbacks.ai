import { existsSync, statSync, readSync, openSync, closeSync } from "node:fs";

export interface Activity {
  tool: string;
  elapsedMs: number;
  ts: number;
  /** True when the latest assistant turn has finished (stop_reason set and
   *  not "tool_use") — drives the in-slot completion freeze. */
  done: boolean;
}

/** Best-effort, read-only tail of Claude Code's live JSONL session transcript
 *  (`~/.claude/projects/<sanitized-cwd>/<session>.jsonl`). Each line is a JSON
 *  record; assistant lines carry `message.content[]` (with `tool_use` blocks),
 *  a `timestamp`, and `message.stop_reason`. Any error/miss yields null so the
 *  injected block self-simulates. NEVER throws. The format is version-fragile
 *  and deliberately non-load-bearing (spec §4.5) — the S5 matrix flags drift. */
const IDLE_STALE_MS = 90_000;
/** Min gap between resolver re-runs while the pinned file sits idle-stale, so
 *  a simply-idle user doesn't re-glob the transcript tree on every poll. */
const RERESOLVE_MIN_MS = 15_000;

export class LogTail {
  private firstSeen = Date.now();
  private lastTool = "";
  private path: string;
  private lastReresolveAt = 0;
  private readonly resolvePath?: () => string;

  constructor(pathOrResolver: string | (() => string)) {
    if (typeof pathOrResolver === "function") {
      this.path = "";
      this.resolvePath = pathOrResolver;
    } else {
      this.path = pathOrResolver;
    }
  }

  private currentPath(): string {
    try {
      if (this.path && existsSync(this.path)) {
        if (!this.resolvePath) return this.path;
        // Transcripts are never deleted: a NEW chat session writes a NEW
        // .jsonl while the pinned one just goes quiet. Once the pinned file
        // is idle-stale, re-resolve (throttled) and adopt any newer
        // transcript — otherwise the pin is forever (audit #2: dead statusbar
        // ad, overlay txnIdle suppression, blind desync watchdog).
        const age = Date.now() - statSync(this.path).mtimeMs;
        if (age <= IDLE_STALE_MS) return this.path;
        if (Date.now() - this.lastReresolveAt < RERESOLVE_MIN_MS) {
          return this.path;
        }
        this.lastReresolveAt = Date.now();
      }
      const next = this.resolvePath?.() || "";
      if (next && next !== this.path) {
        this.path = next;
        this.lastTool = "";
        this.firstSeen = Date.now();
      }
      return this.path;
    } catch { return this.path; }
  }

  /** Age in ms since Claude Code last wrote its session transcript, or null
   *  when there's no readable transcript. An INDEPENDENT activity signal: it
   *  reflects real CC usage (the user firing sessions), NOT our injected
   *  overlay. The desync watchdog uses it to tell "user is using CC but our
   *  ads aren't rendering" (heal) from "user is simply idle" (leave alone).
   *  Cheaper than current() (a single stat, no read). Never throws. */
  activityAgeMs(): number | null {
    try {
      const path = this.currentPath();
      if (!path || !existsSync(path)) return null;
      // Clamp: a just-written file's mtime can be a hair ahead of Date.now()
      // (fs timestamp precision / clock skew), which would otherwise yield a
      // nonsensical negative age.
      return Math.max(0, Date.now() - statSync(path).mtimeMs);
    } catch { return null; }
  }

  current(): Activity | null {
    try {
      const path = this.currentPath();
      if (!path || !existsSync(path)) return null;
      const st = statSync(path);
      const size = st.size;
      const staleMs = Date.now() - st.mtimeMs;
      const want = Math.min(size, 128 * 1024);
      if (want === 0) return null;
      const fd = openSync(path, "r");
      let text: string;
      try {
        const buf = Buffer.alloc(want);
        readSync(fd, buf, 0, want, size - want);
        text = buf.toString("utf8");
      } finally { closeSync(fd); }

      // A *partial* (mid-file) read may slice the first line — drop it.
      // A full read (want === size, offset 0) has no partial line: keep all.
      const lines = text.split("\n");
      if (want < size) lines.shift();

      let tool = "";
      let done: boolean | null = null;   // null until we see an assistant line
      let pendingUserAfterAssistant = false;
      // Walk newest → oldest: first assistant line decides `done`; first
      // tool_use block is the current/most-recent tool.
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln) continue;
        let o: Record<string, unknown>;
        try { o = JSON.parse(ln); } catch { continue; }
        const msg = o.message as Record<string, unknown> | undefined;
        if (done === null && o.type === "user") {
          pendingUserAfterAssistant = true;
          continue;
        }
        if (o.type === "assistant" && msg) {
          if (done === null) {
            if (pendingUserAfterAssistant) {
              // A fresh user prompt after the latest assistant line means the
              // next assistant response has not landed yet. Treat it as active
              // instead of inheriting the prior completed turn.
              done = false;
            } else {
              const sr = msg.stop_reason as string | null | undefined;
              // Set + not "tool_use" => the turn ended (end_turn/stop_sequence).
              done = !!sr && sr !== "tool_use";
            }
          }
          if (!tool && Array.isArray(msg.content)) {
            for (const b of msg.content as Array<Record<string, unknown>>) {
              if (b && b.type === "tool_use" && typeof b.name === "string") {
                tool = b.name; break;
              }
            }
          }
        }
        if (tool && done !== null) break;
      }

      if (done === null && pendingUserAfterAssistant) done = false;
      if (!tool && done === null) return null;   // nothing usable in the tail
      if (tool && tool !== this.lastTool) {
        this.lastTool = tool; this.firstSeen = Date.now();
      }
      const isDone = done === true || staleMs > IDLE_STALE_MS;
      return { tool, elapsedMs: Date.now() - this.firstSeen,
               ts: Date.now(), done: isDone };
    } catch { return null; }
  }
}
