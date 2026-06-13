import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo-root .env reader (mirrors scripts/deploy.mjs::readEnvFile so build &
// publish stay consistent). Trivial KEY=value parser; quotes / blanks /
// comments tolerated; missing file ⇒ all build flags fall back to safe
// defaults below. Pulling dotenv as a dep would be overkill here.
function readDotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"'))
        || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
const isTrue = (v) => v === "true" || v === "1" || v === "yes" || v === "on";

// extension/ sits one level below the repo root.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = readDotenv(resolve(HERE, "..", ".env"));
const BUILD_FLAGS = {
  developer: isTrue(ROOT_ENV.KICKBACKS_DEVELOPER ?? "false"),
  adminUrl: ROOT_ENV.KICKBACKS_ADMIN_URL ?? "",
  siteUrl: ROOT_ENV.KICKBACKS_SITE_URL ?? "",
  verbose: isTrue(ROOT_ENV.KICKBACKS_VERBOSE ?? "false"),
  codex: isTrue(ROOT_ENV.KICKBACKS_CODEX ?? "false"),
  testHooks: isTrue(ROOT_ENV.KICKBACKS_TEST_HOOKS ?? "false"),
  manifestPubkeyPem: ROOT_ENV.KICKBACKS_MANIFEST_PUBKEY_PEM
    ?? ROOT_ENV.VIBE_ADS_MANIFEST_PUBKEY_PEM
    ?? "",
};

function copyAsset(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
// Captured from package.json `version` below and baked into the bundle so the
// running extension can compare its own semver against the deploy sentinel.
let pkgVersion = "0.0.0";
{
  const pj = JSON.parse(readFileSync("package.json", "utf8"));
  pkgVersion = String(pj.version || "0.0.0");
}
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true, platform: "node", format: "cjs",
  external: ["vscode"], outfile: "dist/extension.js", target: "node18",
  // Bake the build epoch into the bundle so the extension can show a LIVE
  // "built Nh ago" at runtime (the VS Code Installation panel is not author-
  // extensible — this is the only place a truthful relative age can live).
  define: { __BUILD_TS__: JSON.stringify(stamp),
            __BUILD_VERSION__: JSON.stringify(pkgVersion),
            // Build-time flags from the repo-root .env. Runtime sentinels /
            // process.env still take precedence at call time (see log.ts +
            // buildflags.ts) — these change the SHIPPED default only.
            __DEVELOPER_MODE__: JSON.stringify(BUILD_FLAGS.developer),
            __ADMIN_URL__: JSON.stringify(BUILD_FLAGS.adminUrl),
            __SITE_URL__: JSON.stringify(BUILD_FLAGS.siteUrl),
            __BUILD_VERBOSE__: JSON.stringify(BUILD_FLAGS.verbose),
            __BUILD_CODEX_OPTIN__: JSON.stringify(BUILD_FLAGS.codex),
            __BUILD_TEST_HOOKS_OPTIN__: JSON.stringify(BUILD_FLAGS.testHooks),
            __MANIFEST_PUBKEY_PEM__: JSON.stringify(BUILD_FLAGS.manifestPubkeyPem) },
});
// The injected block is a shipped raw asset (NOT bundled).
copyAsset("src/adapters/claude-code/block.asset.js",
          "dist/adapters/claude-code/block.asset.js");
// The CLI status-line script is a shipped raw asset (NOT bundled).
copyAsset("src/adapters/claude-cli/statusline.asset.mjs",
          "dist/adapters/claude-cli/statusline.asset.mjs");
// The Codex thinking-shimmer injection is a shipped raw asset (NOT bundled).
copyAsset("src/adapters/codex/block.asset.js",
          "dist/adapters/codex/block.asset.js");
// Codex CLI wrapper templates (Windows .cmd + POSIX shell). Shipped raw.
copyAsset("src/adapters/codex-cli/wrapper.cmd.asset",
          "dist/adapters/codex-cli/wrapper.cmd.asset");
copyAsset("src/adapters/codex-cli/wrapper.sh.asset",
          "dist/adapters/codex-cli/wrapper.sh.asset");
// Generate the DETAILS-pane readme under dist. scripts/package.mjs copies it
// into the temporary VSCE package root as README.md. The tracked source of
// record is readme_extension.md; there is intentionally no bare README.md in
// extension/ (only the repo-root README.md keeps that name).
try {
  const rd = readFileSync("readme_extension.md", "utf8")
    .replace(/<!-- BUILD -->.*$/m, "")
    .replace(/(<\/h1>)/i, `$1\n\n<!-- BUILD --> <p align="center"><sub>build ${stamp}</sub></p>`);
  writeFileSync("dist/README.md", rd);
} catch { /* readme is best-effort; never fail the build */ }
console.log(`built dist/extension.js + CC & Codex block assets + dist/README.md (build ${stamp})`);
console.log(`  build flags: developer=${BUILD_FLAGS.developer}`
  + ` verbose=${BUILD_FLAGS.verbose} codex=${BUILD_FLAGS.codex}`
  + ` testHooks=${BUILD_FLAGS.testHooks}`
  + (BUILD_FLAGS.developer
      ? `  admin=${BUILD_FLAGS.adminUrl || "<unset>"} site=${BUILD_FLAGS.siteUrl || "<unset>"}`
      : ""));
