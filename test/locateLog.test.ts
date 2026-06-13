import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// locate.ts reads join(homedir(), ".claude", "projects") — point homedir at a
// per-test temp root (everything else on node:os stays real).
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => h.home };
});

import { locateClaudeCodeLog, locateClaudeCliLog,
         transcriptEntrypoint } from "../src/locate";

function freshHome(): string {
  h.home = mkdtempSync(join(tmpdir(), "vibe-ads-locate-"));
  return h.home;
}
function projDir(home: string, name = "p1"): string {
  const d = join(home, ".claude", "projects", name);
  mkdirSync(d, { recursive: true });
  return d;
}
// One transcript record per call; `entrypoint` omitted when undefined
// (queue-operation lines / older CC builds carry no tag).
const rec = (entrypoint?: string, extra: object = {}): string =>
  JSON.stringify({ type: "user",
    message: { role: "user", content: "hi" },
    ...(entrypoint ? { entrypoint } : {}), ...extra }) + "\n";
function backdate(f: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(f, t, t);
}

beforeEach(() => {
  delete process.env.KICKBACKS_CC_LOG;
  delete process.env.VIBE_ADS_CC_LOG;
  delete process.env.KICKBACKS_CLI_LOG;
  freshHome();
});

describe("transcriptEntrypoint", () => {
  it('reads the first tagged record, skipping untagged head lines', () => {
    const d = projDir(h.home);
    const f = join(d, "s.jsonl");
    writeFileSync(f,
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }) + "\n"
      + rec("claude-vscode"), "utf8");
    expect(transcriptEntrypoint(f)).toBe("claude-vscode");
  });

  it("null for an untagged transcript (older CC builds)", () => {
    const d = projDir(h.home);
    const f = join(d, "s.jsonl");
    writeFileSync(f, rec(undefined), "utf8");
    expect(transcriptEntrypoint(f)).toBeNull();
  });

  it("null for a missing file (never throws)", () => {
    expect(transcriptEntrypoint(join(h.home, "nope.jsonl"))).toBeNull();
  });

  it("is not spoofed by message TEXT that quotes the tag", () => {
    const d = projDir(h.home);
    const f = join(d, "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "user",
      message: { role: "user", content: 'see "entrypoint":"cli" in docs' },
    }) + "\n", "utf8");
    expect(transcriptEntrypoint(f)).toBeNull();
  });
});

// Audit #24: the documented 'prefer entrypoint:"claude-vscode"' filter — a
// terminal-CLI transcript must not masquerade as VS Code panel activity.
describe("locateClaudeCodeLog entrypoint filter", () => {
  it("prefers the newest claude-vscode transcript over a NEWER terminal-CLI one", () => {
    const d = projDir(h.home);
    const vscode = join(d, "vscode.jsonl");
    const cli = join(d, "cli.jsonl");
    writeFileSync(vscode, rec("claude-vscode"), "utf8");
    writeFileSync(cli, rec("cli"), "utf8");
    backdate(vscode, 60_000);                  // CLI session moved last
    expect(locateClaudeCodeLog()).toBe(vscode);
  });

  it("falls back to the newest UNTAGGED transcript (older CC builds)", () => {
    const d = projDir(h.home);
    const older = join(d, "older.jsonl");
    const newer = join(d, "newer.jsonl");
    writeFileSync(older, rec(undefined), "utf8");
    writeFileSync(newer, rec(undefined), "utf8");
    backdate(older, 60_000);
    expect(locateClaudeCodeLog()).toBe(newer);
  });

  it('returns "" (no signal) when every candidate is a terminal-CLI session', () => {
    const d = projDir(h.home);
    writeFileSync(join(d, "a.jsonl"), rec("cli"), "utf8");
    writeFileSync(join(d, "b.jsonl"), rec("cli"), "utf8");
    expect(locateClaudeCodeLog()).toBe("");
  });

  it('returns "" when no transcripts exist at all', () => {
    expect(locateClaudeCodeLog()).toBe("");
  });
});

// The terminal-side mirror (the Steven fix): the statusbar/statusline billing
// signal for TUI-only users, where locateClaudeCodeLog correctly returns "".
describe("locateClaudeCliLog", () => {
  it("returns the newest cli-tagged transcript", () => {
    const d = projDir(h.home);
    const older = join(d, "older.jsonl");
    const newer = join(d, "newer.jsonl");
    writeFileSync(older, rec("cli"), "utf8");
    writeFileSync(newer, rec("cli"), "utf8");
    backdate(older, 60_000);
    expect(locateClaudeCliLog()).toBe(newer);
  });

  it("skips claude-vscode transcripts even when they are newer", () => {
    const d = projDir(h.home);
    const vscode = join(d, "vscode.jsonl");
    const cli = join(d, "cli.jsonl");
    writeFileSync(cli, rec("cli"), "utf8");
    writeFileSync(vscode, rec("claude-vscode"), "utf8");
    backdate(cli, 60_000);                     // panel session moved last
    expect(locateClaudeCliLog()).toBe(cli);
  });

  // 2026-06-11 launch-day cohort fix: untagged transcripts (older CC builds)
  // are now claimed as a FALLBACK — pre-fix the strict tag filter left TUI
  // users on untagged builds with impressions-but-zero-ticks (26 users at $0
  // while cliSessionActive counted their sessions fail-open).
  it("falls back to the newest UNTAGGED transcript when no cli tag exists", () => {
    const d = projDir(h.home);
    const older = join(d, "older.jsonl");
    const newer = join(d, "newer.jsonl");
    writeFileSync(older, rec(undefined), "utf8");
    writeFileSync(newer, rec(undefined), "utf8");
    backdate(older, 60_000);
    expect(locateClaudeCliLog()).toBe(newer);
  });

  it("prefers a cli-tagged transcript over a NEWER untagged one", () => {
    const d = projDir(h.home);
    const cli = join(d, "cli.jsonl");
    const untagged = join(d, "untagged.jsonl");
    writeFileSync(cli, rec("cli"), "utf8");
    writeFileSync(untagged, rec(undefined), "utf8");
    backdate(cli, 60_000);                     // untagged moved last
    expect(locateClaudeCliLog()).toBe(cli);
  });

  it('returns "" when only panel transcripts exist', () => {
    const d = projDir(h.home);
    writeFileSync(join(d, "a.jsonl"), rec("claude-vscode"), "utf8");
    expect(locateClaudeCliLog()).toBe("");
  });

  it("never claims OTHER positively-tagged transcripts (sdk/desktop sessions render no statusline)", () => {
    const d = projDir(h.home);
    writeFileSync(join(d, "sdk.jsonl"), rec("sdk-ts"), "utf8");
    writeFileSync(join(d, "desktop.jsonl"), rec("desktop"), "utf8");
    expect(locateClaudeCliLog()).toBe("");
  });

  it("honours the KICKBACKS_CLI_LOG override", () => {
    const d = projDir(h.home);
    const f = join(d, "explicit.jsonl");
    writeFileSync(f, rec("cli"), "utf8");
    process.env.KICKBACKS_CLI_LOG = f;
    expect(locateClaudeCliLog()).toBe(f);
  });
});
