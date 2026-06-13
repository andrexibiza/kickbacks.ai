/** Detect the terminal `claude` CLI version so we only write the
 *  `spinnerVerbs` settings.json override on builds that actually honour it.
 *
 *  spinnerVerbs support landed in CC 2.1.143 (decoded from the Bun-compiled
 *  binary: a Zod schema read via the iTH() selector). On older builds the
 *  key is silently ignored and CC shows its stock verb pool — writing it
 *  there is harmless but leaves a dead key in the user's settings.json AND
 *  would make us count a "spinner" impression for an ad that never rendered,
 *  so we gate on it.
 *
 *  NOTE: this is the CLI version, NOT the VS Code Claude Code webview
 *  extension version (the `ccVersion` from the webview adapter preflight).
 *  The two installs are independent and can differ — the spinnerVerbs key
 *  is read by the terminal CLI, so the terminal CLI's version is the one
 *  that matters. */
import { execFile } from "node:child_process";

export type SemVer = [number, number, number];

/** spinnerVerbs support floor: Claude Code 2.1.143. */
export const SPINNER_VERBS_FLOOR: SemVer = [2, 1, 143];

/** Parse a `claude --version` line like "2.1.158 (Claude Code)" into a
 *  [major, minor, patch] tuple, or null if no semver is present. */
export function parseClaudeCliVersion(stdout: string): SemVer | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True iff `a` >= `b` under semver ordering (major, then minor, then patch). */
export function gte(a: SemVer, b: SemVer): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** True iff this CLI version honours the spinnerVerbs settings key. A null
 *  version (unparseable output) is treated as UNsupported here; callers that
 *  want fail-open behaviour on a failed *spawn* apply that policy themselves
 *  (see detectClaudeCliSpinnerSupport). */
export function supportsSpinnerVerbs(v: SemVer | null): boolean {
  return v ? gte(v, SPINNER_VERBS_FLOOR) : false;
}

/** Spawn `claude --version` (PATH-resolved) and return its parsed semver, or
 *  null if claude is absent / errors / times out / prints something we can't
 *  parse. Never throws. */
export function detectClaudeCliVersion(): Promise<SemVer | null> {
  return new Promise((res) => {
    try {
      execFile("claude", ["--version"],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) return res(null);
          res(parseClaudeCliVersion(String(stdout ?? "")));
        });
    } catch { res(null); }
  });
}

/** Result of resolving local-CLI spinnerVerbs support. */
export interface SpinnerSupport {
  /** Whether to write/count the spinner verb. Fail-OPEN (see below). */
  ok: boolean;
  /** The positively-detected CLI version, or null if detection failed/absent. */
  version: SemVer | null;
  /** True iff a version was POSITIVELY detected AND it is below the floor —
   *  i.e. the case worth warning the user about. Distinct from `!ok`, which is
   *  also false on a failed detection (the fail-open path). */
  outdated: boolean;
}

/** Resolve whether to write spinnerVerbs for the local CLI. Fail-OPEN: if we
 *  cannot detect a version (claude not on the extension host's PATH, spawn
 *  error, unparseable output) we assume support, because writing the key is
 *  harmless on a build that ignores it and we'd rather show the ad on a
 *  supported build that flaked detection than silently suppress it. Only a
 *  POSITIVELY detected pre-2.1.143 version turns the surface off — and the
 *  impression counter is guarded on the same flag, so a flaked detection
 *  never bills for a verb that didn't render on a genuinely old CLI (we just
 *  accept the small risk on the rare unknown-version case).
 *
 *  Returns the detected `version` and an `outdated` flag too, so callers can
 *  warn the user ONLY on a positively-detected old CLI — never on the
 *  fail-open (null) path, which would nag installs we can't even probe. */
export async function detectClaudeCliSpinnerSupport(): Promise<SpinnerSupport> {
  const version = await detectClaudeCliVersion();
  const ok = version === null ? true : supportsSpinnerVerbs(version);
  return { ok, version, outdated: version !== null && !ok };
}
