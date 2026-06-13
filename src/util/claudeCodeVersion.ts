const CC_VERSION_RE =
  /anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)(?:[-/\\]|$)/;

type Semver = [number, number, number];

function parseClaudeCodeVersion(value: string): Semver | null {
  const m = CC_VERSION_RE.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Ascending comparator for Claude Code extension dirs/paths.
 *
 * VS Code leaves older extension directories behind. A plain lexicographic
 * sort treats 2.1.99 as newer than 2.1.162, so locate by semver when the
 * standard anthropic.claude-code-* shape is present and fall back to lexical
 * ordering only for unexpected names.
 */
export function compareClaudeCodeInstall(a: string, b: string): number {
  const av = parseClaudeCodeVersion(a);
  const bv = parseClaudeCodeVersion(b);
  if (av && bv) {
    for (let i = 0; i < 3; i++) {
      if (av[i] !== bv[i]) return av[i] - bv[i];
    }
    return a.localeCompare(b);
  }
  if (av) return 1;
  if (bv) return -1;
  return a.localeCompare(b);
}
