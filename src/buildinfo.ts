// Build identity. `__BUILD_TS__` is text-substituted by esbuild's `define` at
// bundle time (see esbuild.mjs). Outside the bundle (vitest, ts-node) it is
// undefined — guarded with `typeof` so it never ReferenceErrors. This is the
// ONLY truthful place a *live* relative build age can come from: the VS Code
// "Installation" panel (Identifier/Version/Source) is rendered by VS Code from
// the manifest and is NOT author-extensible.
declare const __BUILD_TS__: string | undefined;
// Installed extension semver, text-substituted by esbuild's `define` from
// package.json `version` (see esbuild.mjs). Undefined outside the bundle
// (vitest/ts-node) — `typeof`-guarded so it never ReferenceErrors.
declare const __BUILD_VERSION__: string | undefined;

export const BUILD_TS: string =
  (typeof __BUILD_TS__ === "string" && __BUILD_TS__) || "";

/** Installed extension semver, or a safe "0.0.0" when unbundled so the reload
 *  decision (sentinel-version vs running-version) degrades to "always differs"
 *  rather than throwing on an undefined global. */
export function buildVersion(): string {
  return (typeof __BUILD_VERSION__ === "string" && __BUILD_VERSION__) || "0.0.0";
}

/** Compact, non-misleading relative age ("47s ago" / "3h ago" / "2d ago").
 *  Returns "unknown" for an unparseable/empty stamp rather than a wrong number. */
export function humanAge(fromIso: string, now: number = Date.now()): string {
  const t = Date.parse(fromIso);
  if (!fromIso || Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "build 2026-05-17T01:11Z (3h ago)" for status surfaces; "build dev" when
 *  unbundled so a dev run is never misreported as a stale published build. */
export function buildLabel(now: number = Date.now()): string {
  return BUILD_TS ? `build ${BUILD_TS} (${humanAge(BUILD_TS, now)})` : "build dev";
}
