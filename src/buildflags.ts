// Typed accessors for the build-time constants baked in by esbuild.mjs from
// the repo-root .env. Every constant is `typeof`-guarded so unbundled
// callers (vitest, ts-node) never ReferenceError — the same pattern
// buildinfo.ts uses for __BUILD_TS__ / __BUILD_VERSION__.

declare const __DEVELOPER_MODE__: boolean | undefined;
declare const __ADMIN_URL__: string | undefined;
declare const __SITE_URL__: string | undefined;
declare const __BUILD_VERBOSE__: boolean | undefined;
declare const __BUILD_CODEX_OPTIN__: boolean | undefined;
declare const __BUILD_TEST_HOOKS_OPTIN__: boolean | undefined;

/** When true, the status-bar dropdown surfaces dev quick-links (admin portal,
 *  front-end website). OFF on shipped builds (the repo's .env.example default). */
export function developerMode(): boolean {
  return typeof __DEVELOPER_MODE__ === "boolean" ? __DEVELOPER_MODE__ : false;
}

/** URL opened by the dev-only "Open Admin Portal" item. Empty when unset. */
export function adminUrl(): string {
  return typeof __ADMIN_URL__ === "string" ? __ADMIN_URL__ : "";
}

/** URL opened by the dev-only "Open Front-end Website" item. Empty when unset. */
export function siteUrl(): string {
  return typeof __SITE_URL__ === "string" ? __SITE_URL__ : "";
}

/** Build-time equivalent of `~/.vibe-ads/debug.enabled` / `VIBE_ADS_DEBUG=1`.
 *  Consumed by log.ts::debugEnabled() so a build can ship pre-enabled without
 *  touching ~/.vibe-ads/ on the install host. */
export function verboseBuild(): boolean {
  return typeof __BUILD_VERBOSE__ === "boolean" ? __BUILD_VERBOSE__ : false;
}

/** Build-time equivalent of `VIBE_ADS_CODEX=1` / `~/.vibe-ads/codex.enabled`. */
export function codexBuildOptIn(): boolean {
  return typeof __BUILD_CODEX_OPTIN__ === "boolean" ? __BUILD_CODEX_OPTIN__ : false;
}

/** Build-time equivalent of `VIBE_ADS_TEST_HOOKS=1` /
 *  `~/.vibe-ads/test-hooks.enabled`. NEVER true on shipped builds. */
export function testHooksBuildOptIn(): boolean {
  return typeof __BUILD_TEST_HOOKS_OPTIN__ === "boolean"
    ? __BUILD_TEST_HOOKS_OPTIN__ : false;
}
