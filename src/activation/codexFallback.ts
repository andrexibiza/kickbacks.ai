/** Codex discovery policy ("codex fallback").
 *
 *  Codex targeting turns on when the user opted in, OR when there is no
 *  compatible Claude Code target on this machine. The S9 prime-directive
 *  guard ("crashed Claude Code once" — see log.ts::codexEnabled) protects
 *  machines RUNNING a compatible Claude Code, so they stay opt-in-only and
 *  behave exactly as before. Where no compatible Claude Code exists there is
 *  nothing of ours to crash it with — and without the fallback, Kickbacks on
 *  a Codex-only machine is dead weight: a red "incompatible" status bar, no
 *  sign-in, no serving (the bug a public-mirror PR reported).
 *
 *  An explicit opt-out always wins (support remediation: codex.disabled
 *  sentinel / KICKBACKS_CODEX=0 — see log.ts::codexDisabled).
 *
 *  Pure on purpose: no fs/env reads here. extension.ts composes the inputs
 *  (log.ts opt-in/opt-out primitives + the Claude adapter preflight), so the
 *  whole policy is unit-testable as a truth table. */
export function codexDiscoveryEnabled(i: {
  optIn: boolean;
  optOut: boolean;
  claudeCompatible: boolean;
}): boolean {
  if (i.optOut) return false;
  if (i.optIn) return true;
  return !i.claudeCompatible;
}
