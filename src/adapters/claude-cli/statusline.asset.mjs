// Vibe-Ads CLI status line. Shipped raw (placeholders substituted at install).
// Prints the ad line and, when the adapter captured a pre-existing user
// statusLine (chain-capture), runs that command too and prints its output
// on the lines BELOW the ad — CC renders every stdout line, so the
// user's own status line stacks under the ad instead of being replaced.
// Never throws, and a hard exit deadline bounds the chained command — a
// wedged HUD, or a grandchild squatting on the stdout pipe (which no
// child-kill can unstick), can never hang CC's status line.
import { readFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

// writeSync(1): stdout-pipe writes must survive the process.exit() below
// (process.stdout.write is async on pipes; exit() drops pending chunks).
let wrote = false;
const put = (s) => {
  try { writeSync(1, s); wrote = true; } catch { /* never throw */ }
};
try {
  const CACHE = __VIBE_ADS_CLI_AD_PATH__;
  const FRESH_MS = __VIBE_ADS_FRESH_MS__;
  const o = JSON.parse(readFileSync(CACHE, "utf8"));
  const fresh = o && typeof o.ts === "number"
    && (Date.now() - o.ts) <= FRESH_MS
    && typeof o.adText === "string" && o.adText.length > 0;
  if (fresh) {
    // Terminal esc()-analog: strip control chars (C0 + DEL + C1) — and ONLY
    // those — so adText/clickUrl can never emit ANSI/OSC sequences of their
    // own (the OSC 8 framing below is the only escape this script prints).
    // Emoji / pipes / unicode / URLs pass through untouched.
    const strip = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    const text = "ad· " + strip(o.adText);
    const url = typeof o.clickUrl === "string" ? strip(o.clickUrl) : "";
    const ESC = "";
    // OSC 8 hyperlink: ESC ]8;; URL ESC \  TEXT  ESC ]8;; ESC \
    put(url
      ? ESC + "]8;;" + url + ESC + "\\" + text + ESC + "]8;;" + ESC + "\\"
      : text);
  }
} catch { /* prime directive: never break the CLI */ }
try {
  // Chain-capture file (written by the adapter when the user already had
  // a statusLine of their own before install — e.g. a HUD like
  // claude-hud): run their command and stack its output on the lines below
  // the ad instead of replacing it.
  const PREV = __VIBE_ADS_CLI_PREV_PATH__;
  const sl = JSON.parse(readFileSync(PREV, "utf8")).statusLine;
  const cmd = sl && sl.type === "command" && typeof sl.command === "string"
    ? sl.command : "";
  // Self-spawn guard: the adapter never captures our own entry, but a
  // stale or hand-edited file must not make this script fork itself. The
  // name is substituted from the adapter's SCRIPT_NAME — one source of truth.
  if (cmd && !cmd.includes(__VIBE_ADS_SCRIPT_NAME__)) {
    // CC pipes the session JSON to the status line's stdin and the chained
    // command (claude-hud etc.) needs it to render — hand it our stdin fd
    // DIRECTLY rather than slurping it here: a readFileSync(0) on a pipe an
    // invoker forgets to close would block this process forever. TTY stdin
    // is dropped so a manual un-piped run can't leave the HUD at a keyboard.
    const stdinMode = process.stdin.isTTY ? "ignore" : "inherit";
    const CHAIN_TIMEOUT_MS = __VIBE_ADS_CHAIN_TIMEOUT_MS__;
    const DRAIN_MS = 150;
    const child = spawn(cmd, { shell: true, windowsHide: true,
                               stdio: [stdinMode, "pipe", "ignore"] });
    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // The chained command is the user's own config and previously ran
      // directly under CC, so its output (colors/escapes) passes through
      // verbatim — only trailing newlines are trimmed before stacking.
      const text = out.replace(/[\r\n]+$/, "");
      if (text) put((wrote ? "\n" : "") + text);
      process.exit(0);
    };
    child.stdout.on("data", (d) => { out += d; });
    child.stdout.on("error", () => { /* degrade to whatever drained */ });
    child.on("error", finish);
    // Normal path: 'close' (exit + stdio drained) finishes immediately. A
    // grandchild that inherited the stdout pipe keeps 'close' from EVER
    // firing — and a kill can't unstick it — so 'exit' arms a short drain
    // grace, and the hard deadline below bounds even a never-exiting shell.
    // process.exit() cannot be held hostage by an open pipe; this is why the
    // chain is an async spawn and not spawnSync (whose timeout kills only
    // the shell, then keeps reading the grandchild's pipe forever).
    child.on("close", finish);
    child.on("exit", () => { setTimeout(finish, DRAIN_MS); });
    setTimeout(() => {
      try { child.kill(); } catch { /* best-effort */ }
      finish();
    }, CHAIN_TIMEOUT_MS);
  } else {
    process.exit(0);
  }
} catch { process.exit(0); /* no capture → ad-only, as before */ }
