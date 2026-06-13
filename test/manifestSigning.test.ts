import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { manifestSignedString } from "../scripts/deploy.mjs";
import { _verifyManifestSignature } from "../src/update/client";

// The producer (deploy.mjs::manifestSignedString) and the consumer
// (client.ts::_verifyManifestSignature) must agree on the signed-payload format
// byte-for-byte, or signature verification silently breaks once a pubkey-
// embedded client requires it ("Step C"). These tests sign with the REAL
// producer string and verify with the REAL consumer so a divergence fails CI.
describe("manifest signing contract (deploy.mjs producer <-> client.ts consumer)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const SHA = "a".repeat(64);
  const URL = "https://storage.googleapis.com/kickbacks-vsix/kickbacks.vsix";

  // Sign exactly what deploy.mjs would sign for a given manifest shape.
  const signFor = (m: { version: string; sha256: string; url: string; rollback_to?: string }) =>
    sign(null, Buffer.from(
      manifestSignedString(m.version, m.sha256, m.url, m.rollback_to ?? "")), privateKey)
      .toString("base64");

  it("forward manifest (rollback_to empty) verifies", () => {
    const m = { version: "0.3.200", sha256: SHA, url: URL };
    expect(_verifyManifestSignature({ ...m, signature: signFor(m) }, pubPem)).toBe(true);
  });

  it("signed rollback (rollback_to set) verifies", () => {
    const m = { version: "0.3.150", sha256: SHA, url: URL, rollback_to: "0.3.200" };
    expect(_verifyManifestSignature({ ...m, signature: signFor(m) }, pubPem)).toBe(true);
  });

  it("missing signature -> false", () => {
    expect(_verifyManifestSignature({ version: "0.3.200", sha256: SHA, url: URL }, pubPem))
      .toBe(false);
  });

  it("tampered sha256 -> false", () => {
    const m = { version: "0.3.200", sha256: SHA, url: URL };
    expect(_verifyManifestSignature(
      { ...m, signature: signFor(m), sha256: "b".repeat(64) }, pubPem)).toBe(false);
  });

  it("tampered url (attacker-host swap) -> false", () => {
    const m = { version: "0.3.200", sha256: SHA, url: URL };
    expect(_verifyManifestSignature(
      { ...m, signature: signFor(m), url: "https://evil.example.com/x.vsix" }, pubPem))
      .toBe(false);
  });

  it("grafted rollback_to onto a forward signature -> false (downgrade-graft defense)", () => {
    const m = { version: "0.3.200", sha256: SHA, url: URL };
    const forwardSig = signFor(m); // signed with rollback_to=""
    expect(_verifyManifestSignature(
      { ...m, signature: forwardSig, rollback_to: "0.3.100" }, pubPem)).toBe(false);
  });

  it("signature from a different key -> false", () => {
    const other = generateKeyPairSync("ed25519");
    const otherPem = other.publicKey.export({ type: "spki", format: "pem" }) as string;
    const m = { version: "0.3.200", sha256: SHA, url: URL };
    expect(_verifyManifestSignature({ ...m, signature: signFor(m) }, otherPem)).toBe(false);
  });

  it("malformed base64 signature -> false (never throws)", () => {
    expect(_verifyManifestSignature(
      { version: "0.3.200", sha256: SHA, url: URL, signature: "!!!not-base64!!!" }, pubPem))
      .toBe(false);
  });
});
