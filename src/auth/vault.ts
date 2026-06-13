import { execFile } from "node:child_process";

/** Cross-platform credential at-rest protection.
 *
 *  WHY THIS EXISTS: VS Code `ctx.secrets` is durable on macOS (Keychain) and
 *  Windows (DPAPI) but a coin-flip on Linux (no Secret Service on headless /
 *  WSL / devcontainer / code-server / Remote-SSH). Any design that *depends*
 *  on it is broken on Linux. So the universal floor is a file on disk; this
 *  module upgrades the at-rest protection of that file's payload using an
 *  OS-native primitive when one is reachable, with ZERO native npm deps:
 *
 *    macOS   → `security` Keychain CLI            (store model)
 *    Windows → DPAPI via PowerShell ProtectedData (encrypt-blob model)
 *    Linux   → `secret-tool` (libsecret) if present
 *    any     → plaintext (the always-available floor)
 *
 *  Every operation is best-effort and NEVER throws or blocks (prime
 *  directive). On ANY failure `seal()` returns a `plain:` envelope so the
 *  caller still has a durable credential — degraded, never broken. */

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (
  cmd: string,
  args: string[],
  opts?: { input?: string; env?: Record<string, string> },
) => Promise<RunResult>;

export type VaultScheme = "keychain" | "dpapi" | "libsecret" | "plain";

export interface SecretVault {
  /** Best guess of the durable scheme for this platform (actual durability is
   *  re-validated at seal() time — this is for status/diagnostics only). */
  scheme(): VaultScheme;
  /** Persist `secret` for `account`; returns an opaque envelope to store in
   *  the universal file. Never throws. */
  seal(account: string, secret: string): Promise<string>;
  /** Recover the secret from an envelope, or null if unrecoverable (entry
   *  wiped externally, tool missing, garbage). Never throws. */
  open(envelope: string): Promise<string | null>;
  /** Best-effort removal of any OS-store-held secret. Never throws. */
  clear(envelope: string): Promise<void>;
}

const SERVICE = "vibe-ads";
const V = "1"; // envelope version

// --- default production runner (never throws; ENOENT => code 127) ----------
export const defaultRun: Run = (cmd, args, opts) =>
  new Promise<RunResult>((resolve) => {
    try {
      const child = execFile(cmd, args, {
        timeout: 4000, windowsHide: true, maxBuffer: 1 << 20,
        env: { ...process.env, ...(opts?.env || {}) },
      }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
      child.on("error", () => resolve({ code: 127, stdout: "", stderr: "spawn" }));
      if (opts?.input != null) { try { child.stdin?.end(opts.input); } catch { /* */ } }
    } catch { resolve({ code: 127, stdout: "", stderr: "throw" }); }
  });

const stripNL = (s: string): string => s.replace(/\r?\n$/, "");
const env = (e: string): { s: VaultScheme | string; p: string } | null => {
  const i1 = e.indexOf(":"); if (i1 < 0) return null;
  const i2 = e.indexOf(":", i1 + 1); if (i2 < 0) return null;
  if (e.slice(i1 + 1, i2) !== V) return null; // unknown version => unrecoverable
  return { s: e.slice(0, i1), p: e.slice(i2 + 1) };
};
const plainEnv = (secret: string) => `plain:${V}:${secret}`;

// PowerShell DPAPI (CurrentUser). Secret is passed via env (NOT argv — argv is
// world-readable in the process list); `Add-Type` covers PS Core where the
// System.Security assembly isn't auto-loaded.
const PS_PROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$b=[Text.Encoding]::UTF8.GetBytes($env:VIBE_ADS_SECRET);" +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const PS_UNPROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$e=[Convert]::FromBase64String($env:VIBE_ADS_SECRET);" +
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser'))";

export function createVault(
  platform: NodeJS.Platform | string,
  run: Run = defaultRun,
): SecretVault {
  const scheme: VaultScheme =
    platform === "darwin" ? "keychain" :
    platform === "win32" ? "dpapi" :
    platform === "linux" ? "libsecret" : "plain";

  const safe = async <T>(fn: () => Promise<T>, fb: T): Promise<T> => {
    try { return await fn(); } catch { return fb; }
  };

  async function sealKeychain(acct: string, secret: string): Promise<string | null> {
    // NOTE: `security` has no stdin password input; `-w <secret>` is briefly
    // visible in argv to the SAME user only (sub-second). Accepted vs. the
    // alternative of plaintext-at-rest. `-U` upserts.
    const r = await run("security", ["add-generic-password", "-U",
      "-s", SERVICE, "-a", acct, "-w", secret]);
    return r.code === 0 ? `keychain:${V}:${acct}` : null;
  }
  async function sealDpapi(secret: string): Promise<string | null> {
    const r = await run("powershell",
      ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT],
      { env: { VIBE_ADS_SECRET: secret } });
    const ct = stripNL(r.stdout).trim();
    return r.code === 0 && ct ? `dpapi:${V}:${ct}` : null;
  }
  async function sealLibsecret(acct: string, secret: string): Promise<string | null> {
    const r = await run("secret-tool",
      ["store", "--label", SERVICE, "service", SERVICE, "account", acct],
      { input: secret }); // secret via stdin — no argv leak
    return r.code === 0 ? `libsecret:${V}:${acct}` : null;
  }

  return {
    scheme: () => scheme,

    async seal(account, secret) {
      const got = await safe<string | null>(async () => {
        if (scheme === "keychain") return sealKeychain(account, secret);
        if (scheme === "dpapi") return sealDpapi(secret);
        if (scheme === "libsecret") return sealLibsecret(account, secret);
        return null;
      }, null);
      return got ?? plainEnv(secret); // any failure => universal plaintext floor
    },

    async open(envelope) {
      const e = env(envelope);
      if (!e) return null;
      if (e.s === "plain") return e.p; // no exec — works even with no tools
      return safe<string | null>(async () => {
        if (e.s === "keychain") {
          const r = await run("security", ["find-generic-password",
            "-s", SERVICE, "-a", e.p, "-w"]);
          const v = stripNL(r.stdout);
          return r.code === 0 && v ? v : null;
        }
        if (e.s === "dpapi") {
          const r = await run("powershell",
            ["-NoProfile", "-NonInteractive", "-Command", PS_UNPROTECT],
            { env: { VIBE_ADS_SECRET: e.p } });
          const v = stripNL(r.stdout);
          return r.code === 0 && v ? v : null;
        }
        if (e.s === "libsecret") {
          const r = await run("secret-tool",
            ["lookup", "service", SERVICE, "account", e.p]);
          const v = stripNL(r.stdout);
          return r.code === 0 && v ? v : null;
        }
        return null; // unknown scheme
      }, null);
    },

    async clear(envelope) {
      const e = env(envelope);
      if (!e || e.s === "plain") return; // plain: nothing OS-side to remove
      await safe(async () => {
        if (e.s === "keychain")
          await run("security", ["delete-generic-password", "-s", SERVICE, "-a", e.p]);
        else if (e.s === "libsecret")
          await run("secret-tool", ["clear", "service", SERVICE, "account", e.p]);
        // dpapi ciphertext lives only in the file — caller drops the file.
        return null;
      }, null);
    },
  };
}
