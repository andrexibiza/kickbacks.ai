/** Local debug override for the usage-banner ad. "server" (default) follows
 *  the backend bannerEnabled flag; "on"/"off" force either way (dev). */
export type BannerOverride = "server" | "on" | "off";

/** Resolve whether the banner ad renders. Pure; the single source of truth
 *  for the server-flag ⊕ local-override decision (spec §4.1). */
export function resolveBannerOn(
  serverFlag: boolean, override: BannerOverride | undefined): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return serverFlag; // "server" or undefined ⇒ follow backend
}
