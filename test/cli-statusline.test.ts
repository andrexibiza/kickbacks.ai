import { describe, it, expect } from "vitest";
import { ClaudeCliStatuslineAdapter }
  from "../src/adapters/claude-cli/adapter";
import { upsertStatusLine, upsertSpinnerVerbs, parseable, readTopLevel }
  from "../src/adapters/claude-cli/settingsEdit";
import { parseClaudeCliVersion, supportsSpinnerVerbs, gte, SPINNER_VERBS_FLOOR }
  from "../src/adapters/claude-cli/cliVersion";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, utimesSync,
         existsSync, rmSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCliAdCache, readCliAdCache, cliSessionActive, FRESH_MS,
         shouldCountCliImpression, shouldCountSpinnerImpression }
  from "../src/adapters/claude-cli/cliAd";
import { execFileSync } from "node:child_process";

const VAL = '{ "type": "command", "command": "node x", "padding": 0 }';

describe("settingsEdit.parseable", () => {
  it("true for plain JSON", () => {
    expect(parseable('{"a":1}')).toBe(true);
  });
  it("true for JSONC (line+block comments, trailing comma)", () => {
    expect(parseable('{\n // c\n "a":1, /* b */ "z":2,\n}')).toBe(true);
  });
  it("false for genuinely broken text", () => {
    expect(parseable('{ this is not json ')).toBe(false);
  });
});

describe("settingsEdit.upsertStatusLine", () => {
  it("inserts statusLine when absent, preserving other keys/format", () => {
    const src = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
    const out = upsertStatusLine(src, VAL);
    expect(out).toContain('"statusLine": ' + VAL);
    expect(out).toContain('"model": "opus"');
    expect(out).toContain('"theme": "dark"');
    expect(parseable(out)).toBe(true);
  });

  it("replaces ONLY the existing statusLine value, keeping comments intact", () => {
    const src =
      '{\n  // keep me\n  "statusLine": { "type":"command", "command":"old" },\n'
      + '  "model": "opus" /* and me */\n}\n';
    const out = upsertStatusLine(src, VAL);
    expect(out).toContain('"statusLine": ' + VAL);
    expect(out).not.toContain('"command":"old"');
    expect(out).toContain("// keep me");
    expect(out).toContain("/* and me */");
    expect(out).toContain('"model": "opus"');
    expect(parseable(out)).toBe(true);
  });

  it("idempotent: re-upsert with same value is a no-op", () => {
    const src = '{ "model": "x" }\n';
    const a = upsertStatusLine(src, VAL);
    const b = upsertStatusLine(a, VAL);
    expect(b).toBe(a);
  });

  it("throws on unparseable input (caller treats as ok:false)", () => {
    expect(() => upsertStatusLine("{ broken ", VAL)).toThrow();
  });
});

const SV = '{"mode":"replace","verbs":["Acme - Try Acme.com"]}';

describe("settingsEdit.upsertSpinnerVerbs", () => {
  it("inserts spinnerVerbs when absent, preserving other keys/format", () => {
    const src = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
    const out = upsertSpinnerVerbs(src, SV);
    expect(out).toContain('"spinnerVerbs": ' + SV);
    expect(out).toContain('"model": "opus"');
    expect(out).toContain('"theme": "dark"');
    expect(parseable(out)).toBe(true);
  });

  it("replaces ONLY the existing spinnerVerbs value, keeping comments intact", () => {
    const src =
      '{\n  // keep me\n  "spinnerVerbs": { "mode":"append", "verbs":["Old"] },\n'
      + '  "model": "opus" /* and me */\n}\n';
    const out = upsertSpinnerVerbs(src, SV);
    expect(out).toContain('"spinnerVerbs": ' + SV);
    expect(out).not.toContain('"Old"');
    expect(out).toContain("// keep me");
    expect(out).toContain("/* and me */");
    expect(out).toContain('"model": "opus"');
    expect(parseable(out)).toBe(true);
  });

  it("idempotent: re-upsert with same value is a no-op", () => {
    const src = '{ "model": "x" }\n';
    const a = upsertSpinnerVerbs(src, SV);
    const b = upsertSpinnerVerbs(a, SV);
    expect(b).toBe(a);
  });

  it("composes cleanly with upsertStatusLine (both keys land, both update)", () => {
    const src = '{\n  "model": "opus"\n}\n';
    let out = upsertStatusLine(src, VAL);
    out = upsertSpinnerVerbs(out, SV);
    expect(out).toContain('"statusLine": ' + VAL);
    expect(out).toContain('"spinnerVerbs": ' + SV);
    expect(out).toContain('"model": "opus"');
    expect(parseable(out)).toBe(true);
    // Replacing only spinnerVerbs leaves the statusLine untouched (no
    // accidental clobber across the two top-level upserts).
    const SV2 = '{"mode":"replace","verbs":["NewAd"]}';
    const out2 = upsertSpinnerVerbs(out, SV2);
    expect(out2).toContain('"statusLine": ' + VAL);
    expect(out2).toContain('"spinnerVerbs": ' + SV2);
    expect(out2).not.toContain('"Acme - Try Acme.com"');
  });
});

describe("settingsEdit.readTopLevel", () => {
  it("returns the parsed value of a top-level key (JSONC tolerated)", () => {
    const src = '{\n  // hud\n  "statusLine": { "type": "command",'
      + ' "command": "node hud.js", "padding": 0 },\n}\n';
    expect(readTopLevel(src, "statusLine"))
      .toEqual({ type: "command", command: "node hud.js", padding: 0 });
  });
  it("returns undefined when the key is absent", () => {
    expect(readTopLevel('{ "model": "x" }', "statusLine")).toBeUndefined();
  });
  it("returns undefined for unparseable text (never throws)", () => {
    expect(readTopLevel("{ broken ", "statusLine")).toBeUndefined();
  });
});

function tmp(): string { return mkdtempSync(join(tmpdir(), "vibe-cli-")); }

describe("cliAd cache", () => {
  it("writeCliAdCache then readCliAdCache round-trips with a ts", () => {
    const home = tmp();
    writeCliAdCache(home, { adText: "Acme", iconRef: "i", iconUrl: "", clickUrl: "https://a/x" });
    const c = readCliAdCache(home);
    expect(c?.adText).toBe("Acme");
    expect(c?.clickUrl).toBe("https://a/x");
    expect(typeof c?.ts).toBe("number");
  });
  it("readCliAdCache returns null when absent", () => {
    expect(readCliAdCache(tmp())).toBeNull();
  });
  it("writeCliAdCache strips control chars (ESC/OSC/BEL/CSI) from every persisted field", () => {
    const home = tmp();
    const ESC = "\u001b", BEL = "\u0007", CSI = "\u009b";
    writeCliAdCache(home, {
      adText: "Acme" + ESC + "]8;;https://evil" + BEL + " deploys" + CSI + "31m",
      iconRef: "i" + ESC, iconUrl: "u" + BEL,
      clickUrl: "https://a/x" + ESC + "]8;;" });
    const c = readCliAdCache(home);
    expect(c?.adText).toBe("Acme]8;;https://evil deploys31m");
    expect(c?.iconRef).toBe("i");
    expect(c?.iconUrl).toBe("u");
    expect(c?.clickUrl).toBe("https://a/x]8;;");
  });
  it("writeCliAdCache is PERMISSIVE: emoji/pipes/unicode/URLs round-trip byte-identical", () => {
    const home = tmp();
    const line = "Déployez 🚀 | ai.dev — détails: https://a/?q=1&r=2";
    writeCliAdCache(home, { adText: line, iconRef: "i", iconUrl: "",
      clickUrl: "https://a/x" });
    expect(readCliAdCache(home)?.adText).toBe(line);
  });
});

// Transcript line tagged with a CC `entrypoint` ("cli" = terminal session,
// "claude-vscode" = the VS Code panel's own; untagged = older CC builds).
const taggedRec = (entrypoint: string): string =>
  JSON.stringify({ type: "user",
    message: { role: "user", content: "hi" }, entrypoint }) + "\n";

describe("cliSessionActive", () => {
  it("true when a recent transcript exists in <projectsRoot>", () => {
    const root = tmp();
    const proj = join(root, "p1"); mkdirSync(proj, { recursive: true });
    const f = join(proj, "s.jsonl"); writeFileSync(f, "{}");
    expect(cliSessionActive(Date.now(), FRESH_MS, root)).toBe(true);
  });
  it("false when newest transcript is older than the window", () => {
    const root = tmp();
    const proj = join(root, "p1"); mkdirSync(proj, { recursive: true });
    const f = join(proj, "s.jsonl"); writeFileSync(f, "{}");
    const old = (Date.now() - FRESH_MS - 60_000) / 1000;
    utimesSync(f, old, old);
    expect(cliSessionActive(Date.now(), FRESH_MS, root)).toBe(false);
  });
  it("false when projects root is absent", () => {
    expect(cliSessionActive(Date.now(), FRESH_MS, join(tmp(), "nope"))).toBe(false);
  });
  // Audit #30: the VS Code panel writes the SAME tree (entrypoint
  // "claude-vscode") — editor turns must not count as a live CLI session,
  // else statusline/spinner impressions are recorded for an unrendered surface.
  it("false when the only recent transcript is the VS Code panel's own", () => {
    const root = tmp();
    const proj = join(root, "p1"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s.jsonl"), taggedRec("claude-vscode"));
    expect(cliSessionActive(Date.now(), FRESH_MS, root)).toBe(false);
  });
  it("true for a recent genuine terminal-CLI transcript (entrypoint cli)", () => {
    const root = tmp();
    const proj = join(root, "p1"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s.jsonl"), taggedRec("cli"));
    expect(cliSessionActive(Date.now(), FRESH_MS, root)).toBe(true);
  });
  it("true when a recent CLI transcript coexists with a recent vscode one", () => {
    const root = tmp();
    const proj = join(root, "p1"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "vscode.jsonl"), taggedRec("claude-vscode"));
    writeFileSync(join(proj, "cli.jsonl"), taggedRec("cli"));
    expect(cliSessionActive(Date.now(), FRESH_MS, root)).toBe(true);
  });
  it("false when the CLI transcript is stale and only the vscode one is recent", () => {
    const root = tmp();
    const proj = join(root, "p1"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "vscode.jsonl"), taggedRec("claude-vscode"));
    const cli = join(proj, "cli.jsonl"); writeFileSync(cli, taggedRec("cli"));
    const old = (Date.now() - FRESH_MS - 60_000) / 1000;
    utimesSync(cli, old, old);
    expect(cliSessionActive(Date.now(), FRESH_MS, root)).toBe(false);
  });
  // 2026-06-11: headless SDK / desktop-agent sessions write the same tree
  // with their own entrypoint tags. They render no statusline — counting
  // them emitted impressions for an unseen surface while the tick loop
  // (strictly cli-or-untagged) stayed silent. Both signals now accept the
  // same set: "cli" | untagged.
  it("false when the only recent transcripts carry other positive tags (sdk/desktop)", () => {
    const root = tmp();
    const proj = join(root, "p1"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "sdk.jsonl"), taggedRec("sdk-ts"));
    writeFileSync(join(proj, "desktop.jsonl"), taggedRec("desktop"));
    expect(cliSessionActive(Date.now(), FRESH_MS, root)).toBe(false);
  });
});

function renderScript(cachePath: string, freshMs: number,
                      prevPath = join(tmpdir(), "vibe-prev-absent.json"),
                      chainTimeoutMs = 5000): string {
  const tpl = readFileSync(join(__dirname,
    "../src/adapters/claude-cli/statusline.asset.mjs"), "utf8");
  return tpl
    .split("__VIBE_ADS_CLI_AD_PATH__").join(JSON.stringify(cachePath))
    .split("__VIBE_ADS_CLI_PREV_PATH__").join(JSON.stringify(prevPath))
    .split("__VIBE_ADS_FRESH_MS__").join(String(freshMs))
    .split("__VIBE_ADS_SCRIPT_NAME__")
    .join(JSON.stringify("vibe-ads-statusline.mjs"))
    .split("__VIBE_ADS_CHAIN_TIMEOUT_MS__").join(String(chainTimeoutMs));
}
function runScript(body: string, input?: string): string {
  const d = tmp();
  const p = join(d, "s.mjs");
  writeFileSync(p, body, "utf8");
  return execFileSync(process.execPath, [p],
    input === undefined ? { encoding: "utf8" } : { encoding: "utf8", input });
}

describe("statusline.asset script", () => {
  it("prints a real OSC 8 hyperlink (ESC bytes) + marker + adText for a fresh cache", () => {
    const d = tmp();
    const cache = join(d, "cli-ad.json");
    writeFileSync(cache, JSON.stringify({ adText: "Acme deploys",
      iconRef: "i", iconUrl: "", clickUrl: "https://acme/x", ts: Date.now() }));
    const out = runScript(renderScript(cache, FRESH_MS));
    const ESC = "";
    expect(out).toContain("ad· Acme deploys");                       // visible text + marker
    expect(out).toContain(ESC + "]8;;https://acme/x" + ESC + "\\");  // hyperlink open + ST
    expect(out).toContain(ESC + "]8;;" + ESC + "\\");                // hyperlink close + ST
    expect(out.startsWith(ESC + "]8;;")).toBe(true);                 // begins with the escape
  })
  it("prints nothing for a stale cache", () => {
    const d = tmp();
    const cache = join(d, "cli-ad.json");
    writeFileSync(cache, JSON.stringify({ adText: "Old", iconRef: "i",
      clickUrl: "https://a/x", ts: Date.now() - FRESH_MS - 1000 }));
    expect(runScript(renderScript(cache, FRESH_MS)).trim()).toBe("");
  });
  it("prints nothing when cache missing", () => {
    expect(runScript(renderScript(join(tmp(), "nope.json"),
      FRESH_MS)).trim()).toBe("");
  });
  it("prints nothing (exit 0) for malformed cache", () => {
    const d = tmp();
    const cache = join(d, "cli-ad.json");
    writeFileSync(cache, "{ not json");
    expect(runScript(renderScript(cache, FRESH_MS)).trim()).toBe("");
  });
  it("strips control bytes from adText/clickUrl before the OSC 8 wrap (defense-in-depth vs tampered cache)", () => {
    const d = tmp();
    const cache = join(d, "cli-ad.json");
    const ESC = "\u001b", BEL = "\u0007";
    // Bypass writeCliAdCache: simulate a tampered/legacy cache carrying raw
    // escape bytes in BOTH fields (write boundary defeated).
    writeFileSync(cache, JSON.stringify({
      adText: "Acme" + ESC + "]8;;https://evil" + ESC + "\\spoof" + BEL,
      iconRef: "i", iconUrl: "",
      clickUrl: "https://acme/x" + ESC + "]8;;", ts: Date.now() }));
    const out = runScript(renderScript(cache, FRESH_MS));
    // The ONLY escapes emitted are the script's own 4 OSC 8 framing bytes…
    expect(out.split(ESC).length - 1).toBe(4);
    // …the injected sequences survive only as inert de-escaped text.
    expect(out).toContain("ad· Acme]8;;https://evil\\spoof");
    expect(out).toContain(ESC + "]8;;https://acme/x]8;;" + ESC + "\\");
  });
  it("passes emoji / pipes / unicode through byte-identical (strip is control-chars ONLY)", () => {
    const d = tmp();
    const cache = join(d, "cli-ad.json");
    const line = "Déployez 🚀 | ai.dev — vite";
    writeFileSync(cache, JSON.stringify({ adText: line, iconRef: "i",
      iconUrl: "", clickUrl: "https://acme/x", ts: Date.now() }));
    const out = runScript(renderScript(cache, FRESH_MS));
    expect(out).toContain("ad· " + line);
  });
});

function prevFileWith(cmd: string): string {
  const p = join(tmp(), "cli-prev-statusline.json");
  writeFileSync(p, JSON.stringify(
    { statusLine: { type: "command", command: cmd, padding: 0 } }));
  return p;
}
function freshCache(): string {
  const cache = join(tmp(), "cli-ad.json");
  writeFileSync(cache, JSON.stringify({ adText: "Acme deploys", iconRef: "i",
    iconUrl: "", clickUrl: "https://acme/x", ts: Date.now() }));
  return cache;
}

describe("statusline.asset script — chained previous statusLine", () => {
  it("prints the ad line ABOVE the chained command's output", () => {
    const prev = prevFileWith("echo HUD-LINE");
    const out = runScript(renderScript(freshCache(), FRESH_MS, prev), "");
    const nl = out.indexOf("\n");
    expect(nl).toBeGreaterThan(0);
    expect(out.slice(0, nl)).toContain("ad· Acme deploys");
    expect(out.slice(nl + 1)).toBe("HUD-LINE");
  });
  it("prints ONLY the chained output when the ad cache is stale or missing", () => {
    const prev = prevFileWith("echo HUD-LINE");
    const out = runScript(
      renderScript(join(tmp(), "nope.json"), FRESH_MS, prev), "");
    expect(out).toBe("HUD-LINE");
  });
  it("forwards stdin to the chained command (CC pipes the session JSON)", () => {
    const prev = prevFileWith(
      `node -e "process.stdout.write(require('fs').readFileSync(0,'utf8'))"`);
    const json = JSON.stringify({ model: { display_name: "Opus" } });
    const out = runScript(renderScript(freshCache(), FRESH_MS, prev), json);
    expect(out.slice(out.indexOf("\n") + 1)).toBe(json);
  });
  it("ad-only when the prev file is malformed (never breaks the CLI)", () => {
    const p = join(tmp(), "cli-prev-statusline.json");
    writeFileSync(p, "{ not json");
    const out = runScript(renderScript(freshCache(), FRESH_MS, p), "");
    expect(out).toContain("ad· Acme deploys");
    expect(out).not.toContain("\n");
  });
  it("ad-only when the captured command points at ourselves (self-spawn guard)", () => {
    const prev = prevFileWith("node /x/vibe-ads-statusline.mjs");
    const out = runScript(renderScript(freshCache(), FRESH_MS, prev), "");
    expect(out).toContain("ad· Acme deploys");
    expect(out).not.toContain("\n");
  });
  it("ad-only when the chained command exits nonzero with no output", () => {
    const prev = prevFileWith(`node -e "process.exit(3)"`);
    const out = runScript(renderScript(freshCache(), FRESH_MS, prev), "");
    expect(out).toContain("ad· Acme deploys");
    expect(out).not.toContain("\n");
  });
  it("exits with ad-only when the chained command outlives the deadline " +
     "(wedged HUD must not hang CC)", () => {
    // Chained command sleeps far past the 400ms deadline; the script must
    // exit at the deadline with the ad line, not wait for the child.
    const prev = prevFileWith(`node -e "setTimeout(()=>{}, 30000)"`);
    const t0 = Date.now();
    const out = runScript(
      renderScript(freshCache(), FRESH_MS, prev, 400), "");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(out).toContain("ad· Acme deploys");
    expect(out).not.toContain("\n");
  });

  it("exits promptly when a GRANDCHILD squats on the stdout pipe after the " +
     "shell exits (spawnSync-hang regression guard)", () => {
    // Shell spawns a detached long-lived grandchild inheriting stdio, prints
    // one line, and exits. 'close' never fires while the grandchild holds
    // the pipe; the exit-drain grace must still flush the HUD line and exit.
    const grand = "const cp=require('node:child_process');"
      + "cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],"
      + "{detached:true,stdio:'inherit'}).unref();"
      + "console.log('HUD-LINE');";
    const prev = prevFileWith(
      `node -e ${JSON.stringify(grand)}`);
    const t0 = Date.now();
    const out = runScript(
      renderScript(freshCache(), FRESH_MS, prev, 5000), "");
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(out.split("\n")[1]).toBe("HUD-LINE");
  });

  it("prints nothing when there is no ad AND no captured command", () => {
    const out = runScript(
      renderScript(join(tmp(), "no-cache.json"), FRESH_MS), "");
    expect(out).toBe("");
  });
});

const P = { tier: 0 as const, adText: "Acme", iconRef: "i", iconUrl: "",
  clickToken: "", clickUrl: "https://acme/x", corr: "cli.abc", loopbackPort: 0,
  loopbackToken: "", loopbackBase: "" };

function homeWithClaude(): { home: string; settings: string } {
  const home = tmp();
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = join(home, ".claude", "settings.json");
  return { home, settings };
}
function parseableFile(p: string): boolean {
  try { JSON.parse(readFileSync(p, "utf8")); return true; } catch { return false; }
}

describe("ClaudeCliStatuslineAdapter", () => {
  it("preflight: compatible for parseable, absent, JSONC; incompatible for broken", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings, '{ "model":"x" }');
    expect(new ClaudeCliStatuslineAdapter(settings).preflight().compatible).toBe(true);
    rmSync(settings);
    expect(new ClaudeCliStatuslineAdapter(settings).preflight().compatible).toBe(true);
    writeFileSync(settings, '{ /* c */ "a":1, }');
    expect(new ClaudeCliStatuslineAdapter(settings).preflight().compatible).toBe(true);
    writeFileSync(settings, '{ broken ');
    const pf = new ClaudeCliStatuslineAdapter(settings).preflight();
    expect(pf.compatible).toBe(false);
    expect(pf.reason).toMatch(/not parseable/);
  });

  it("applyPatch installs statusLine + script, backs up pristine, idempotent", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings, '{\n  "model": "opus"\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.applyPatch(P).ok).toBe(true);
    const s = readFileSync(settings, "utf8");
    expect(s).toContain('"statusLine"');
    expect(s).toContain('"model": "opus"');
    expect(existsSync(settings + ".vibe-ads-backup")).toBe(true);
    expect(readFileSync(settings + ".vibe-ads-backup", "utf8"))
      .toBe('{\n  "model": "opus"\n}\n');
    expect(existsSync(join(home, ".vibe-ads",
      "vibe-ads-statusline.mjs"))).toBe(true);
    const after1 = readFileSync(settings, "utf8");
    a.applyPatch(P);
    expect(readFileSync(settings, "utf8")).toBe(after1);
  });

  it("applyPatch installs BOTH statusLine AND spinnerVerbs when supported", () => {
    // The CLI adapter writes two surfaces: statusLine (OSC 8 clickable
    // hyperlink) and spinnerVerbs (the ad text in the thinking-shimmer verb
    // slot). spinnerVerbs is gated on `spinnerVerbsSupported`, which defaults
    // to true (fail-open) until async version detection resolves.
    const { settings } = homeWithClaude();
    writeFileSync(settings, '{\n  "model": "opus"\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.spinnerVerbsSupported).toBe(true);
    expect(a.applyPatch(P).ok).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.spinnerVerbs).toBeDefined();
    expect(parsed.spinnerVerbs.mode).toBe("replace");
    expect(parsed.spinnerVerbs.verbs).toEqual(["Acme"]);
    expect(parsed.statusLine?.type).toBe("command");
    expect(parsed.model).toBe("opus");
  });

  it("applyPatch REPLACES any pre-existing spinnerVerbs with current ad", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings,
      '{\n  "spinnerVerbs": { "mode": "replace", "verbs": ["StaleAd"] }\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.applyPatch(P).ok).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.spinnerVerbs.mode).toBe("replace");
    expect(parsed.spinnerVerbs.verbs).toEqual(["Acme"]);
    expect(parsed.spinnerVerbs.verbs).not.toContain("StaleAd");
    expect(parsed.statusLine?.type).toBe("command");
  });

  it("applyPatch EVICTS spinnerVerbs when the CLI does not support it", () => {
    // On a pre-2.1.143 CLI (spinnerVerbsSupported=false) the key is a dead
    // no-op, so we remove it (and heal any stale entry) — statusLine only.
    const { settings } = homeWithClaude();
    writeFileSync(settings,
      '{\n  "spinnerVerbs": { "mode": "replace", "verbs": ["StaleAd"] }\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.spinnerVerbsSupported = false;
    expect(a.applyPatch(P).ok).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.spinnerVerbs).toBeUndefined();
    expect(parsed.statusLine?.type).toBe("command");
  });

  it("applyPatch refuses to touch an unparseable settings.json", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings, "{ broken ");
    const r = new ClaudeCliStatuslineAdapter(settings).applyPatch(P);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not parseable/);
    expect(readFileSync(settings, "utf8")).toBe("{ broken ");
    expect(existsSync(settings + ".vibe-ads-backup")).toBe(false);
  });

  it("creates settings.json + ~/.claude when absent; restore deletes it", () => {
    const home = tmp();
    const settings = join(home, ".claude", "settings.json");
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.applyPatch(P).ok).toBe(true);
    expect(existsSync(settings)).toBe(true);
    expect(parseableFile(settings)).toBe(true);
    const r = a.restore();
    expect(r.restored).toBe(true);
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(settings + ".vibe-ads-backup")).toBe(false);
  });

  it("restore reverts an existing file byte-exact and removes script", () => {
    const { home, settings } = homeWithClaude();
    const pristine = '{\n  "model": "opus"\n}\n';
    writeFileSync(settings, pristine);
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    const patched = readFileSync(settings, "utf8");
    expect(patched).toContain('"statusLine"');
    expect(patched).toContain('"spinnerVerbs"');
    expect(a.restore().restored).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(pristine);
    expect(existsSync(join(home, ".vibe-ads",
      "vibe-ads-statusline.mjs"))).toBe(false);
    expect(existsSync(settings + ".vibe-ads-backup")).toBe(false);
  });

  it("restore is a no-op when no backup present", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings, "{}");
    const r = new ClaudeCliStatuslineAdapter(settings).restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(/no backup/);
  });

  it("spinnerVerbs value reflects the PatchParams adText", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings, '{\n  "model": "opus"\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    const customP = { ...P, adText: "Try Ramp.com — Free for 30 days" };
    expect(a.applyPatch(customP).ok).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.spinnerVerbs.mode).toBe("replace");
    expect(parsed.spinnerVerbs.verbs).toEqual(["Try Ramp.com — Free for 30 days"]);
  });

  it("applyPatch is idempotent: second call with same ad does not re-write", () => {
    const { settings } = homeWithClaude();
    writeFileSync(settings, '{\n  "model": "opus"\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    const after1 = readFileSync(settings, "utf8");
    expect(after1).toContain('"spinnerVerbs"');
    a.applyPatch(P);
    expect(readFileSync(settings, "utf8")).toBe(after1);
  });
});

const HUD = '{ "type": "command", "command": "node /x/hud.js", "padding": 1 }';

describe("ClaudeCliStatuslineAdapter chain-capture", () => {
  const prevFile = (home: string): string =>
    join(home, ".vibe-ads", "cli-prev-statusline.json");

  it("applyPatch captures a pre-existing foreign statusLine", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings,
      '{\n  "model": "opus",\n  "statusLine": ' + HUD + '\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    expect(a.applyPatch(P).ok).toBe(true);
    const prev = JSON.parse(readFileSync(prevFile(home), "utf8"));
    expect(prev.statusLine)
      .toEqual({ type: "command", command: "node /x/hud.js", padding: 1 });
    // The live slot now holds OUR command…
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.statusLine.command).toContain("vibe-ads-statusline.mjs");
    // …and the installed script points at the capture file.
    const script = readFileSync(join(home, ".vibe-ads",
      "vibe-ads-statusline.mjs"), "utf8");
    expect(script).toContain("cli-prev-statusline.json");
  });

  it("re-apply over our own slot leaves the capture untouched (60s tick)", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings, '{ "statusLine": ' + HUD + ' }');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    a.applyPatch(P);
    const prev = JSON.parse(readFileSync(prevFile(home), "utf8"));
    expect(prev.statusLine.command).toBe("node /x/hud.js");
  });

  it("writes no capture file when there was no pre-existing statusLine", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings, '{ "model": "opus" }');
    new ClaudeCliStatuslineAdapter(settings).applyPatch(P);
    expect(existsSync(prevFile(home))).toBe(false);
  });

  it("restore puts the captured statusLine BACK instead of dropping the key", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings,
      '{\n  "model": "opus",\n  "statusLine": ' + HUD + '\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    expect(a.restore().restored).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.statusLine)
      .toEqual({ type: "command", command: "node /x/hud.js", padding: 1 });
    expect(parsed.model).toBe("opus");
    expect(parsed.spinnerVerbs).toBeUndefined();
    expect(existsSync(prevFile(home))).toBe(false);
  });

  it("KEEPS the capture when the statusLine key vanishes (deleting the ad " +
     "entry must not forget the HUD)", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings, '{ "statusLine": ' + HUD + ' }');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    expect(existsSync(prevFile(home))).toBe(true);
    // While installed the slot holds OUR command — a deleted key means the
    // user removed the AD entry, not their own HUD.
    writeFileSync(settings, '{ "model": "opus" }');
    a.applyPatch(P);
    expect(existsSync(prevFile(home))).toBe(true);
    // …so restore still puts their HUD back.
    expect(a.restore().restored).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.statusLine.command).toBe("node /x/hud.js");
  });

  it("keeps the capture when settings.json is transiently ABSENT at a tick", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings, '{ "statusLine": ' + HUD + ' }');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    rmSync(settings);                      // mid-rewrite / sync-tool window
    a.applyPatch(P);
    expect(existsSync(prevFile(home))).toBe(true);
    const prev = JSON.parse(readFileSync(prevFile(home), "utf8"));
    expect(prev.statusLine.command).toBe("node /x/hud.js");
  });

  it("restore falls back to the first-apply snapshot when the capture file " +
     "is missing", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings,
      '{\n  "model": "opus",\n  "statusLine": ' + HUD + '\n}\n');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    rmSync(prevFile(home));                // cleared ~/.vibe-ads, AV tooling…
    expect(a.restore().restored).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.statusLine)
      .toEqual({ type: "command", command: "node /x/hud.js", padding: 1 });
  });

  it("restore leaves a FOREIGN statusLine untouched (user hand-installed a " +
     "newer one after capture)", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings, '{ "statusLine": ' + HUD + ' }');
    const a = new ClaudeCliStatuslineAdapter(settings);
    a.applyPatch(P);
    // User replaces our entry with HUD-B before any re-capture tick runs.
    const hudB = '{ "type": "command", "command": "node /x/hud-b.js" }';
    writeFileSync(settings, '{ "statusLine": ' + hudB + ' }');
    expect(a.restore().restored).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.statusLine.command).toBe("node /x/hud-b.js");
    expect(existsSync(prevFile(home))).toBe(false);   // capture still cleaned
  });

  it("END-TO-END: the installed script stacks the ad above the captured HUD", () => {
    const { home, settings } = homeWithClaude();
    writeFileSync(settings,
      '{ "statusLine": { "type": "command", "command": "echo HUD-LINE" } }');
    new ClaudeCliStatuslineAdapter(settings).applyPatch(P);
    writeCliAdCache(home, { adText: "Acme deploys", iconRef: "i",
      iconUrl: "", clickUrl: "https://acme/x" });
    const out = execFileSync(process.execPath,
      [join(home, ".vibe-ads", "vibe-ads-statusline.mjs")],
      { encoding: "utf8", input: "{}" });
    const nl = out.indexOf("\n");
    expect(out.slice(0, nl)).toContain("ad· Acme deploys");
    expect(out.slice(nl + 1)).toBe("HUD-LINE");
  });
});

describe("shouldCountCliImpression", () => {
  const base = { signedIn: true, haveAd: true, sessionActive: true,
                 adId: "ad1", lastCountedAdId: null as string | null };
  it("true when signed-in + ad + active session + new adId", () => {
    expect(shouldCountCliImpression(base)).toBe(true);
  });
  it("false when not signed in", () => {
    expect(shouldCountCliImpression({ ...base, signedIn: false })).toBe(false);
  });
  it("false when no active CLI session", () => {
    expect(shouldCountCliImpression({ ...base, sessionActive: false })).toBe(false);
  });
  it("false when this adId was already counted", () => {
    expect(shouldCountCliImpression({ ...base, lastCountedAdId: "ad1" }))
      .toBe(false);
  });
  it("true again for a different adId", () => {
    expect(shouldCountCliImpression({ ...base, lastCountedAdId: "ad0" }))
      .toBe(true);
  });
});

describe("shouldCountSpinnerImpression", () => {
  const base = { supportConfirmed: true, signedIn: true, haveAd: true,
                 sessionActive: true, adId: "ad1",
                 lastCountedAdId: null as string | null };
  it("true when support confirmed + signed-in + ad + active + new adId", () => {
    expect(shouldCountSpinnerImpression(base)).toBe(true);
  });
  it("false when support is NOT confirmed, even if all else is satisfied", () => {
    // The over-count guard: the first synchronous activation sync runs before
    // `claude --version` resolves, so spinner billing must stay off until
    // support is positively confirmed — never bill for an unrendered verb.
    expect(shouldCountSpinnerImpression({ ...base, supportConfirmed: false }))
      .toBe(false);
  });
  it("false when not signed in", () => {
    expect(shouldCountSpinnerImpression({ ...base, signedIn: false }))
      .toBe(false);
  });
  it("false when no active CLI session", () => {
    expect(shouldCountSpinnerImpression({ ...base, sessionActive: false }))
      .toBe(false);
  });
  it("false when this adId was already counted (dedup)", () => {
    expect(shouldCountSpinnerImpression({ ...base, lastCountedAdId: "ad1" }))
      .toBe(false);
  });
  it("true again for a different adId", () => {
    expect(shouldCountSpinnerImpression({ ...base, lastCountedAdId: "ad0" }))
      .toBe(true);
  });
  it("is independent of the statusline counter (separate dedup keys)", () => {
    // statusline already counted ad1; spinner counter still null → spinner
    // should still fire for ad1 (two distinct surfaces, two counters).
    expect(shouldCountCliImpression({ signedIn: true, haveAd: true,
      sessionActive: true, adId: "ad1", lastCountedAdId: "ad1" })).toBe(false);
    expect(shouldCountSpinnerImpression({ ...base, lastCountedAdId: null }))
      .toBe(true);
  });
});

describe("cliVersion.parseClaudeCliVersion", () => {
  it("parses a real `claude --version` line", () => {
    expect(parseClaudeCliVersion("2.1.158 (Claude Code)")).toEqual([2, 1, 158]);
  });
  it("parses a bare semver", () => {
    expect(parseClaudeCliVersion("2.1.143")).toEqual([2, 1, 143]);
  });
  it("returns null when no semver is present", () => {
    expect(parseClaudeCliVersion("Claude Code")).toBeNull();
    expect(parseClaudeCliVersion("")).toBeNull();
  });
});

describe("cliVersion.gte / supportsSpinnerVerbs", () => {
  it("floor is 2.1.143", () => {
    expect(SPINNER_VERBS_FLOOR).toEqual([2, 1, 143]);
  });
  it("gte orders by major, minor, patch", () => {
    expect(gte([2, 1, 143], [2, 1, 143])).toBe(true);   // equal
    expect(gte([2, 1, 158], [2, 1, 143])).toBe(true);   // patch higher
    expect(gte([2, 2, 0], [2, 1, 143])).toBe(true);     // minor higher
    expect(gte([3, 0, 0], [2, 1, 143])).toBe(true);     // major higher
    expect(gte([2, 1, 142], [2, 1, 143])).toBe(false);  // patch lower
    expect(gte([2, 0, 999], [2, 1, 143])).toBe(false);  // minor lower
  });
  it("supportsSpinnerVerbs gates on the floor", () => {
    expect(supportsSpinnerVerbs([2, 1, 158])).toBe(true);   // Andrew's CLI
    expect(supportsSpinnerVerbs([2, 1, 143])).toBe(true);   // exact floor
    expect(supportsSpinnerVerbs([2, 1, 142])).toBe(false);  // just below
    expect(supportsSpinnerVerbs([2, 0, 44])).toBe(false);   // 2.0.x
    expect(supportsSpinnerVerbs(null)).toBe(false);         // unparseable
  });
});
