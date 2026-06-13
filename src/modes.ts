import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BannerOverride } from "./banner";

/** Dev-only overrides for the three injection surfaces, backed by sentinel
 *  files under ~/.vibe-ads/ (headless parity with debug.enabled / banner.txt).
 *  Every function is guarded — fs failure ⇒ safe default, never throws. */
function dir(): string { return join(homedir(), ".vibe-ads"); }

function ensureDir(): void {
  try { mkdirSync(dir(), { recursive: true }); } catch { /* ignore */ }
}

/** Presence of <name> ⇒ true. */
function present(name: string): boolean {
  try { return existsSync(join(dir(), name)); } catch { return false; }
}

function setPresent(name: string, on: boolean): void {
  try {
    const p = join(dir(), name);
    if (on) { ensureDir(); writeFileSync(p, ""); }
    else rmSync(p, { force: true });
  } catch { /* ignore */ }
}

/** Default ON; ~/.vibe-ads/webview.off forces OFF. */
export function webviewMode(): "on" | "off" {
  return present("webview.off") ? "off" : "on";
}
export function setWebviewMode(on: boolean): void {
  setPresent("webview.off", !on);
}

/** Default ON; ~/.vibe-ads/cli.off forces OFF. */
export function cliMode(): "on" | "off" {
  return present("cli.off") ? "off" : "on";
}
export function setCliMode(on: boolean): void {
  setPresent("cli.off", !on);
}

/** Default "server"; ~/.vibe-ads/banner.mode content ∈ {server,on,off}. */
export function bannerOverride(): BannerOverride {
  try {
    const raw = readFileSync(join(dir(), "banner.mode"), "utf8").trim();
    return raw === "on" || raw === "off" || raw === "server" ? raw : "server";
  } catch { return "server"; }
}
export function setBannerOverride(o: BannerOverride): void {
  try {
    const p = join(dir(), "banner.mode");
    if (o === "server") rmSync(p, { force: true });
    else { ensureDir(); writeFileSync(p, o); }
  } catch { /* ignore */ }
}
