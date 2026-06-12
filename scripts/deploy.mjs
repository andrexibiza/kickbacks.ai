#!/usr/bin/env node

/**
 * Canonical manifest signing payload used by the deployment producer and the
 * extension self-update verifier. Keep this byte-for-byte aligned with
 * src/update/client.ts::_verifyManifestSignature.
 */
export function manifestSignedString(version, sha256, url, rollbackTo = "") {
  return `${version}\n${sha256}\n${url}\n${rollbackTo ?? ""}`;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  console.log("deploy.mjs currently exposes manifestSignedString for tests/CI.");
}
