// Generates media/icon.png — the VS Code Marketplace icon. The mark is the "K$"
// wordmark (Montserrat 800, white) on a vertical green gradient rounded square,
// rasterized with headless Chromium (Montserrat is a real typeface, so it can't
// be drawn procedurally). Requires playwright-core (resolved from the repo's e2e
// install — see _brand.mjs). Run: `npm run icon`.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderAssets } from "./_brand.mjs";

const SIZE = 256; // crisp; Marketplace displays ~128
const { icons } = await renderAssets({ sizes: [SIZE] });
const png = icons.get(SIZE);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}×${SIZE})`);
