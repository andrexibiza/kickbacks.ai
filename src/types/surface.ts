export type AdSurface = "overlay" | "banner" | "codex_overlay" | "statusline" | "statusbar" | "spinner";
export const AD_SURFACES: readonly AdSurface[] = ["overlay", "banner", "codex_overlay", "statusline", "statusbar", "spinner"] as const;
export function parseAdSurface(raw: string): AdSurface | undefined {
  return (AD_SURFACES as readonly string[]).includes(raw) ? (raw as AdSurface) : undefined;
}
