import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTail } from "../src/activity/logTail";

// Mirrors Claude Code's JSONL transcript: one JSON record per line; assistant
// lines carry message.content[] (tool_use blocks) + message.stop_reason.
function jsonl(records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
const asst = (blocks: object[], stop: string | null) => ({
  type: "assistant", timestamp: "2026-05-16T22:54:24.104Z",
  message: { role: "assistant", stop_reason: stop, content: blocks },
});
const tmp = () => join(mkdtempSync(join(tmpdir(), "vibe-ads-log-")), "s.jsonl");

describe("LogTail (JSONL)", () => {
  it("returns null when no log file (best-effort, never throws)", () => {
    expect(new LogTail("/no/such/file.jsonl").current()).toBeNull();
  });

  it("can resolve the transcript lazily after activation", () => {
    let f = "";
    const tail = new LogTail(() => f);
    expect(tail.current()).toBeNull();
    f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Edit" }], "tool_use"),
    ]), "utf8");
    expect(tail.current()?.tool).toBe("Edit");
    expect(tail.activityAgeMs()).not.toBeNull();
  });

  it("extracts the most-recent tool_use name + numeric ts", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      asst([{ type: "tool_use", name: "Read" }], "tool_use"),
      asst([{ type: "tool_use", name: "Bash" }], "tool_use"),
    ]), "utf8");
    const a = new LogTail(f).current();
    expect(a?.tool).toBe("Bash");
    expect(typeof a?.ts).toBe("number");
    expect(a?.done).toBe(false);          // stop_reason "tool_use" => not done
  });

  it("done=true when the latest assistant turn ended (stop_reason=end_turn)", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Grep" }], "tool_use"),
      asst([{ type: "text", text: "all set." }], "end_turn"),
    ]), "utf8");
    const a = new LogTail(f).current();
    expect(a?.done).toBe(true);
    expect(a?.tool).toBe("Grep");         // last tool still reported for context
  });

  it("done=false when a user prompt is newer than the latest assistant", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Grep" }], "tool_use"),
      asst([{ type: "text", text: "done" }], "end_turn"),
      { type: "queue-operation", operation: "enqueue" },
      { type: "user", message: { role: "user", content: "next" } },
      { type: "file-history-snapshot", messageId: "u1" },
    ]), "utf8");
    const a = new LogTail(f).current();
    expect(a?.done).toBe(false);
    expect(a?.tool).toBe("Grep");
  });

  it("keeps done=true when only a stop hook is newer than the assistant", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Grep" }], "tool_use"),
      asst([{ type: "text", text: "done" }], "end_turn"),
      { type: "system", subtype: "stop_hook_summary" },
    ]), "utf8");
    expect(new LogTail(f).current()?.done).toBe(true);
  });

  it("malformed / non-JSON content yields null, never throws", () => {
    const f = tmp();
    writeFileSync(f, "\x00\x01 not json at all\n{ broken", "utf8");
    expect(new LogTail(f).current()).toBeNull();
  });

  it("skips a sliced first line and still parses the rest", () => {
    const f = tmp();
    writeFileSync(f, '{"partial":  \n' +
      JSON.stringify(asst([{ type: "tool_use", name: "Edit" }], "tool_use")) +
      "\n", "utf8");
    expect(new LogTail(f).current()?.tool).toBe("Edit");
  });

  it("activityAgeMs: null when no transcript (idle/unknown)", () => {
    expect(new LogTail("/no/such/file.jsonl").activityAgeMs()).toBeNull();
  });

  it("activityAgeMs: small age right after a transcript write (CC in use)", () => {
    const f = tmp();
    writeFileSync(f, "{}\n", "utf8");
    const age = new LogTail(f).activityAgeMs();
    expect(age).not.toBeNull();
    expect(age as number).toBeGreaterThanOrEqual(0);
    expect(age as number).toBeLessThan(60_000);
  });
});

// Backdate a file's mtime by `ms` (utimes takes SECONDS).
function backdate(f: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(f, t, t);
}

// Audit #2: transcripts are never deleted, so a new chat session writes a NEW
// .jsonl while the pinned one merely goes quiet. The pin must not be forever.
describe("LogTail re-resolution (new-session adoption)", () => {
  it("adopts a newer transcript once the pinned one goes idle-stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibe-ads-log-"));
    const a = join(dir, "old-session.jsonl");
    const b = join(dir, "new-session.jsonl");
    writeFileSync(a, jsonl([
      asst([{ type: "tool_use", name: "Read" }], "end_turn"),
    ]), "utf8");
    let resolved = a;
    const tail = new LogTail(() => resolved);
    expect(tail.current()?.done).toBe(true);   // pinned to A, turn ended
    // A goes quiet past IDLE_STALE_MS; the user's NEW session writes to B.
    backdate(a, 120_000);
    writeFileSync(b, jsonl([
      { type: "user", message: { role: "user", content: "next" } },
      asst([{ type: "tool_use", name: "Bash" }], "tool_use"),
    ]), "utf8");
    resolved = b;
    const act = tail.current();
    expect(act?.tool).toBe("Bash");            // NEW session's activity…
    expect(act?.done).toBe(false);             // …live, not stale done:true
    const age = tail.activityAgeMs();          // watchdog signal follows too
    expect(age).not.toBeNull();
    expect(age as number).toBeLessThan(90_000);
  });

  it("does NOT invoke the resolver while the pinned transcript is fresh", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Edit" }], "tool_use"),
    ]), "utf8");
    let calls = 0;
    const tail = new LogTail(() => { calls++; return f; });
    tail.current();
    tail.current();
    tail.activityAgeMs();
    expect(calls).toBe(1);                     // only the initial resolve
  });

  it("throttles stale re-resolution (not re-globbed on every poll)", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Edit" }], "end_turn"),
    ]), "utf8");
    backdate(f, 120_000);
    let calls = 0;
    const tail = new LogTail(() => { calls++; return f; });
    tail.current();                            // initial resolve (empty path)
    expect(calls).toBe(1);
    tail.current();                            // stale → one re-resolve…
    expect(calls).toBe(2);
    tail.current();                            // …then throttled
    tail.activityAgeMs();
    expect(calls).toBe(2);
  });

  it("keeps the pinned transcript when the resolver finds no candidate", () => {
    const f = tmp();
    writeFileSync(f, jsonl([
      asst([{ type: "tool_use", name: "Edit" }], "end_turn"),
    ]), "utf8");
    let resolved = f;
    const tail = new LogTail(() => resolved);
    expect(tail.current()?.tool).toBe("Edit");
    backdate(f, 120_000);
    resolved = "";                             // e.g. all candidates filtered
    const act = tail.current();
    expect(act?.tool).toBe("Edit");           // pinned path retained
    expect(act?.done).toBe(true);             // stale ⇒ done (idle)
  });
});
