/** Backup/restore safety regressions (audit 2026-06-09 findings #12, #13, #18).
 *
 *  Prime-directive territory: these pin the protocol that protects the two
 *  files Kickbacks does not own — Claude Code's webview/index.js and the
 *  user's ~/.claude/settings.json — against the cross-window interleave
 *  (tainted-backup recapture) and the stale-snapshot whole-file rollback. */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync,
         mkdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";
import { ClaudeCliStatuslineAdapter } from "../src/adapters/claude-cli/adapter";
import { upsertStatusLine, upsertSpinnerVerbs, removeTopLevel, parseable }
  from "../src/adapters/claude-cli/settingsEdit";

const FIX = readFileSync(join(__dirname, "fixtures/synthetic-index.js"), "utf8");

function tmpTarget(): string {
  const d = mkdtempSync(join(tmpdir(), "vibe-ads-bsafe-"));
  const p = join(d, "index.js");
  writeFileSync(p, FIX, "utf8");
  return p;
}
const params = {
  tier: 3 as const, adText: "Ramp corporate cards & expense mgmt",
  iconRef: "icon.r", iconUrl: "", clickToken: "ck",
  clickUrl: "https://ramp.example/lp", corr: "ad1.tst",
  loopbackPort: 5555, loopbackToken: "lt",
  loopbackBase: "http://127.0.0.1:5555",
};

// ---------------------------------------------------------------------------
// Finding #12/#18 — tainted-backup recapture (ClaudeCodeAdapter)
// ---------------------------------------------------------------------------
describe("ClaudeCodeAdapter taint guard (audit #12/#18)", () => {
  let target: string;
  let bak: string;
  beforeEach(() => { target = tmpTarget(); bak = target + ".kickbacks-backup"; });

  it("ensureBackup REFUSES to capture a patched live file: applyPatch is"
    + " success-no-write, no tainted backup is minted", () => {
    const a = new ClaudeCodeAdapter(target);
    expect(a.applyPatch(params).ok).toBe(true);     // normal first apply
    // Cross-window interleave: window B's restore() deleted the backup while
    // the live file stayed patched (window A re-patched after the restore).
    rmSync(bak);
    const patched = readFileSync(target, "utf8");
    const r = a.applyPatch({ ...params, adText: "Different ad text" });
    expect(r.ok).toBe(true);                        // apply-success-no-write
    expect(r.reason).toMatch(/already patched/i);
    expect(existsSync(bak)).toBe(false);            // refused the capture
    expect(readFileSync(target, "utf8")).toBe(patched); // byte-identical
    expect(readFileSync(target, "utf8")).not.toContain("Different ad text");
  });

  it("after a refused capture, restore() is honest (no backup) and never"
    + " touches the live file", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params);
    rmSync(bak);
    const patched = readFileSync(target, "utf8");
    a.applyPatch(params);                           // refused, no capture
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(/no backup/i);
    expect(readFileSync(target, "utf8")).toBe(patched); // untouched
  });

  it("stale-backup recapture also refuses when the live file is patched"
    + " (never re-mints a poisoned backup from a poisoned live file)", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params);                           // live now patched
    writeFileSync(bak, "garbage without the anchor", "utf8"); // stale backup
    const live = readFileSync(target, "utf8");
    const r = a.applyPatch(params);
    expect(r.ok).toBe(true);
    expect(existsSync(bak)).toBe(false);            // stale deleted, NOT replaced
    expect(readFileSync(target, "utf8")).toBe(live); // no write
  });

  it("restore() STRIPS our block from a tainted backup instead of reinstating"
    + " it (pre-guard field backups)", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params);
    const patchedBytes = readFileSync(target);
    // Simulate a pre-guard tainted capture: backup holds the PATCHED bytes.
    writeFileSync(bak, patchedBytes);
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(true);
    const after = readFileSync(target, "utf8");
    expect(after).not.toContain("VIBE-ADS-START");  // ad block NOT reinstated
    expect(after).toContain('"Discombobulating"');  // verb array intact
    expect(a.isPatched()).toBe(false);
    expect(existsSync(bak)).toBe(false);            // consumed after verify
  });

  it("normal restore stays byte-exact (taint strip never fires on a clean"
    + " backup)", () => {
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch(params);
    expect(a.restore().restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(FIX);
  });
});

// ---------------------------------------------------------------------------
// Finding #13 — key-scoped settings.json restore (ClaudeCliStatuslineAdapter)
// ---------------------------------------------------------------------------
const P = { tier: 0 as const, adText: "Acme", iconRef: "i", iconUrl: "",
  clickToken: "", clickUrl: "https://acme/x", corr: "cli.abc", loopbackPort: 0,
  loopbackToken: "", loopbackBase: "" };

function homeWithClaude(): { home: string; settings: string } {
  const home = mkdtempSync(join(tmpdir(), "vibe-cli-bsafe-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return { home, settings: join(home, ".claude", "settings.json") };
}

describe("ClaudeCliStatuslineAdapter key-scoped restore (audit #13)", () => {
  it("restore preserves user edits made AFTER first apply (no stale-snapshot"
    + " rollback)", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings, '{\n  "model": "opus"\n}\n', "utf8");
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.applyPatch(P).ok).toBe(true);
    // Days later: the user adds a hooks config while the patch is applied.
    const cur = readFileSync(settings, "utf8");
    writeFileSync(settings, cur.replace("{\n",
      '{\n  "hooks": { "PostToolUse": [{ "command": "fmt" }] },\n'), "utf8");
    const r = a.restore();
    expect(r.restored).toBe(true);
    const out = readFileSync(settings, "utf8");
    expect(parseable(out)).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.hooks).toBeDefined();             // user edit SURVIVES
    expect(parsed.model).toBe("opus");
    expect(parsed.statusLine).toBeUndefined();      // our keys removed
    expect(parsed.spinnerVerbs).toBeUndefined();
  });

  it("restore on the ABSENT sentinel keeps the file when the user added"
    + " content since (only our keys removed)", () => {
    const { settings } = homeWithClaude();          // no settings.json yet
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.applyPatch(P).ok).toBe(true);          // we created the file
    const cur = readFileSync(settings, "utf8");
    writeFileSync(settings,
      cur.replace("{\n", '{\n  "model": "sonnet",\n'), "utf8");
    const r = a.restore();
    expect(r.restored).toBe(true);
    expect(existsSync(settings)).toBe(true);        // NOT deleted
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.model).toBe("sonnet");            // user content survives
    expect(parsed.statusLine).toBeUndefined();
    expect(parsed.spinnerVerbs).toBeUndefined();
  });

  it("restore on the ABSENT sentinel deletes the untouched empty shell we"
    + " created", () => {
    const { settings } = homeWithClaude();
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.applyPatch(P).ok).toBe(true);
    const r = a.restore();
    expect(r.restored).toBe(true);
    expect(existsSync(settings)).toBe(false);       // shell removed
    expect(existsSync(settings + ".vibe-ads-backup")).toBe(false);
  });

  it("restore round-trips a never-edited settings.json byte-exact", () => {
    const { settings } = homeWithClaude();
    const pristine = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
    writeFileSync(settings, pristine, "utf8");
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    expect(a.restore().restored).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(pristine);
  });

  it("restore refuses (and keeps the backup) when the current settings.json"
    + " is unparseable — never clobbers a user-broken file", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings, '{\n  "model": "opus"\n}\n', "utf8");
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    writeFileSync(settings, "{ broken ", "utf8");   // user breaks the file
    const r = a.restore();
    expect(r.ok).toBe(false);
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(/not parseable/);
    expect(readFileSync(settings, "utf8")).toBe("{ broken "); // untouched
    expect(existsSync(settings + ".vibe-ads-backup")).toBe(true); // retryable
  });

  it("applyPatch script write is idempotent (no per-tick rewrite) but heals"
    + " a corrupted script", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings, "{}\n", "utf8");
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    const script = join(home, ".vibe-ads", "vibe-ads-statusline.mjs");
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(script, old, old);
    const before = statSync(script).mtimeMs;
    a.applyPatch(P);                                // 60s cliSync tick
    expect(statSync(script).mtimeMs).toBe(before);  // byte-identical → no write
    writeFileSync(script, "corrupted", "utf8");
    a.applyPatch(P);
    expect(readFileSync(script, "utf8")).not.toBe("corrupted"); // healed
  });
});

// removeTopLevel must round-trip upsertTopLevel byte-exact (whitespace-aware
// trailing-comma removal) — the property the key-scoped restore stands on.
describe("settingsEdit.removeTopLevel round-trip (audit #13)", () => {
  it("upsert x2 then remove x2 returns the original text byte-exact", () => {
    const src = '{\n  "model": "opus"\n}\n';
    const VAL = '{ "type": "command", "command": "node x", "padding": 0 }';
    const SV = '{"mode":"replace","verbs":["Acme"]}';
    let out = upsertStatusLine(src, VAL);
    out = upsertSpinnerVerbs(out, SV);
    out = removeTopLevel(out, "statusLine");
    out = removeTopLevel(out, "spinnerVerbs");
    expect(out).toBe(src);
  });

  it("never consumes a comment between the previous token and the key", () => {
    const src = '{\n  // user comment\n  "spinnerVerbs": { "mode": "replace",'
      + ' "verbs": ["Old"] },\n  "model": "opus"\n}\n';
    const out = removeTopLevel(src, "spinnerVerbs");
    expect(out).toContain("// user comment");
    expect(out).toContain('"model": "opus"');
    expect(out).not.toContain('"verbs"');
    expect(parseable(out)).toBe(true);
  });
});
