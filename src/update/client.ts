import { createHash, verify } from "node:crypto";
import { dlog } from "../log";
import { errMsg } from "../util/errMsg";
import { timeoutFetch } from "../util/http";

type Fetch = typeof fetch;
type Installer = (vsix: ArrayBuffer) => Promise<void>;
/** Persistence hooks so a given manifest version is install-attempted AT
 *  MOST ONCE, ever. Without this, if installExtension+restartExtensionHost
 *  fails to actually swap the running version, isNewer stays true forever →
 *  download→install→restart→repeat = the endless restart loop. With it, a
 *  non-converging version is tried once then left alone (safe-degraded).
 *
 *  wave-2A-F05: distinguish "permanent install attempt" from "transient
 *  pre-install failure" (sha mismatch, body-read abort). The latter should
 *  be retried after a short cooldown rather than burning the full
 *  install-attempt slot (which would block recovery for 30 min). */
interface AttemptGuard {
  // The optional sha256 second arg is the manifest's pinned VSIX digest.
  // Wave-2P-F01: keying ONLY on `version` lets a manifest flap between two
  // artifacts that carry the same semver but different bytes (observed in
  // prod: 0.3.54 with two distinct BUILD_TS-stamped builds re-installing
  // each other every ~90s). Passing `sha256` lets the extension-side
  // implementation key on (version, sha) so the second flap is suppressed
  // until the cooldown expires. Optional + ignored-when-omitted to keep
  // every existing call site / test guard binary-compatible.
  attempted(version: string, sha256?: string): boolean;
  markAttempted(version: string, sha256?: string): void;
  /** Optional: SUCCESS record (trey-nag-loop 2026-06-11). `attempted` is
   *  cooldown-bounded so a FAILED install can retry — but that same cooldown
   *  re-ran SUCCESSFUL installs too: a user who dismissed the reload toast
   *  got the identical artifact re-downloaded, re-installed and re-toasted
   *  every ~31 min until they reloaded (observed: 20+ cycles / 10 h on one
   *  machine). An artifact that installed without throwing is recorded here
   *  and never re-attempted; only the wiring (selfUpdate.ts) clears the
   *  record, at activation, when the install visibly failed to converge. */
  installed?(version: string, sha256?: string): boolean;
  markInstalled?(version: string, sha256?: string): void;
  /** Optional: short cooldown for transient pre-install failures. When
   *  omitted, transient failures are NOT retried-throttled and the next
   *  90s poll re-tries immediately (pre-2A-F05 behavior). */
  transientFailed?(version: string, sha256?: string): boolean;
  markTransientFailed?(version: string, sha256?: string): void;
  /** Optional: wave-2K-F03 LKG VSIX recording. Called after a successful
   *  install so an activate.fatal bootstrap can restore the last-known-good
   *  bytes. Bytes may be persisted to a tmp file path; only the path needs
   *  to fit in globalState. */
  recordLkg?(version: string, vsix: Buffer): void;
}

export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// wave-2A-F01 — VSIX size sanity + signature scaffolding.
//
// A self-hosted manifest (no marketplace fallback) where the only integrity
// check is sha256 vs the manifest itself is integrity-vs-the-manifest, not
// authenticity. A backend compromise that controls the manifest also
// controls the sha → a malicious VSIX ships silently. Two layers of fix:
//
// 1. UNCONDITIONAL minimum-size sanity. Rejects empty/garbage downloads
//    (CDN partial response, ad-blocker stub, etc) before they reach the
//    installer. 10 KiB is far below any real VSIX (89 KB at audit time).
//
// 2. FLAG-GATED Ed25519 signature verification over the manifest blob.
//    When VIBE_ADS_REQUIRE_MANIFEST_SIG=1 and a public key is compiled in
//    via VIBE_ADS_MANIFEST_PUBKEY_PEM (esbuild --define), the manifest
//    MUST carry a base64 `signature` field that verifies against
//    `${version}\n${sha256}\n${url}\n${rollback_to}` under the embedded
//    public key (rollback_to is "" for a normal forward manifest).
//    The flag is OFF by default so existing deployments keep working
//    until a key story is set up (see docs/runbooks/extension-signing.md
//    when it lands as part of the wave-2A-F01 operational follow-up).
const MIN_VSIX_BYTES = 10 * 1024;

declare const __MANIFEST_PUBKEY_PEM__: string | undefined;

function _embeddedPubkeyPem(): string | null {
  try {
    // esbuild --define replaces __MANIFEST_PUBKEY_PEM__ at build time.
    // When undefined the typeof guard short-circuits without ReferenceError.
    if (typeof __MANIFEST_PUBKEY_PEM__ === "string" && __MANIFEST_PUBKEY_PEM__.length > 0) {
      return __MANIFEST_PUBKEY_PEM__;
    }
  } catch { /* swallow; treated as unset */ }
  return null;
}

export function _verifyManifestSignature(
  m: { version: string; sha256: string; url: string; signature?: string;
       rollback_to?: string },
  pubkeyPem: string,
): boolean {
  if (!m.signature) return false;
  try {
    // Locked signed-payload format: `version\nsha256\nurl\nrollback_to`.
    // rollback_to is "" for a normal forward manifest (deploy.mjs signs it
    // empty); including it in the signed bytes prevents a compromised manifest
    // from grafting an unsigned `rollback_to` to force a downgrade to an old
    // (genuinely signed but known-vuln) version.
    return verify(
      null,
      Buffer.from(`${m.version}\n${m.sha256}\n${m.url}\n${m.rollback_to ?? ""}`),
      pubkeyPem,
      Buffer.from(m.signature, "base64"),
    );
  } catch { return false; }
}

// wave-2A-F01 layer 3 — VSIX download-origin pin. The sha256 above proves the
// downloaded bytes match the manifest, but a compromised manifest controls
// BOTH `url` AND `sha256`, so on its own the pin can be redirected to an
// attacker-controlled host (supply-chain RCE on every install). Restrict the
// download origin to the published `kickbacks-vsix` GCS bucket in production,
// while still allowing a self-hosted DEV manifest to serve the VSIX from its
// OWN origin (same host as `base`) or loopback — if an attacker can MITM that
// they already control the manifest + sha, so it grants no new capability. An
// out-of-allowlist url is rejected BEFORE the fetch (safe-degraded: the
// self-update no-ops rather than fetching/installing an untrusted artifact).
export function _vsixUrlAllowed(rawUrl: string, base: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  const host = u.hostname.toLowerCase();
  // Dev / self-host escape hatches.
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  try {
    if (host === new URL(base).hostname.toLowerCase()) return true;
  } catch { /* base isn't a URL — fall through to the prod allowlist */ }
  // Production: HTTPS to the published kickbacks-vsix GCS bucket only.
  if (u.protocol !== "https:") return false;
  if (host === "kickbacks-vsix.storage.googleapis.com") return true;
  if (host === "kickbacks-vsix.storage.cloud.google.com") return true;
  if ((host === "storage.googleapis.com" || host === "storage.cloud.google.com")
      && u.pathname.startsWith("/kickbacks-vsix/")) return true;
  return false;
}

/** Polls /v1/ext/manifest; sha256-verifies the VSIX before install. Returns
 *  true iff an install happened. Never throws. */
export class UpdateClient {
  // wave-2A-M4: surface when self-update has been silently failing for a
  // while. Pre-fix, a peer left on a stale build had zero signal — every
  // failure path returns false with no log. Counter resets on success; at
  // each 3-poll multiple we emit a dlog so an operator running with
  // debugMode: true can see "self-update is wedged" without instrumenting
  // anything else.
  private consecutiveFails = 0;
  /** Optional user-facing "new version detected" notifier. Fires AFTER
   *  the version + sig + sha gates pass and BEFORE the install starts —
   *  so the user sees "Kickbacks: v0.3.85 available, installing…" while
   *  the install runs, not after the extension host has restarted on
   *  top of them. Never throws (best-effort). */
  private onUpdateAvailable?: (info: { version: string;
                                       current: string;
                                       rollback: boolean }) => void;
  constructor(private base: string, private current: string,
              private f: Fetch = timeoutFetch(120000), private install: Installer = async () => {},
              private guard?: AttemptGuard,
              onUpdateAvailable?: (info: { version: string;
                                            current: string;
                                            rollback: boolean }) => void) {
    this.onUpdateAvailable = onUpdateAvailable;
  }

  private noteFail(reason: string, extra: Record<string, unknown> = {}): false {
    this.consecutiveFails++;
    if (this.consecutiveFails > 0 && this.consecutiveFails % 3 === 0) {
      dlog("ext", "selfupdate.failed",
        { reason, base: this.base, current: this.current,
          consecutiveFails: this.consecutiveFails, ...extra });
    }
    return false;
  }

  // audit-2026-06-09 #31: single-flight guard. checkOnce is driven by a
  // fire-and-forget 90s setInterval (selfUpdate.ts); the attempt fence is
  // only written AFTER the download completes (markAttempted below), so a
  // VSIX download slower than the poll period let the next tick re-enter,
  // double-download and double-install the same artifact. An overlapping
  // poll now returns false immediately; cooldown/attempt-guard semantics
  // for SEQUENTIAL polls are unchanged.
  private inFlight = false;

  async checkOnce(): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try { return await this.checkOnceInner(); }
    finally { this.inFlight = false; }
  }

  private async checkOnceInner(): Promise<boolean> {
    try {
      const m = await (await this.f(`${this.base}/v1/ext/manifest`)).json() as
        { version: string; sha256: string; url: string; signature?: string;
          rollback_to?: string };
      // wave-2K-F02: rollback contract. When the server-published manifest
      // sets `rollback_to: <currently-running-version>`, this client treats
      // the manifest version as installable even when it's <= current --
      // overriding isNewer() so a true downgrade is possible. Sha pin still
      // applies; the attempt-guard still applies.
      const isRollbackForUs = !!m.rollback_to
        && m.rollback_to === this.current
        && m.version !== this.current;
      if (!isRollbackForUs && !isNewer(m.version, this.current)) return false;
      // Already-installed artifact (success record): the running version
      // only changes on window reload, so "manifest newer than current"
      // stays true indefinitely after a successful install. Without this
      // gate the attempted-cooldown below re-installs + re-toasts the SAME
      // artifact every time it expires (the Trey nag loop). Checked before
      // the cooldown slots so success suppression is not time-bounded.
      if (this.guard?.installed?.(m.version, m.sha256)) return false;
      // One install attempt per (version, sha), ever — the restart-loop
      // guard. Wave-2P-F01: previously keyed on version only, which let a
      // manifest carrying the same semver with a different VSIX flap-install
      // every poll. Threading m.sha256 to every guard call site means the
      // *artifact* is what the cooldown actually fences; manifests that
      // genuinely re-serve the same bytes still hit the existing slot.
      if (this.guard && this.guard.attempted(m.version, m.sha256)) return false;
      // wave-2A-F05 — short transient cooldown for pre-install failures
      // (sha mismatch, body-read abort). The 90s poll means a flapping CDN
      // would otherwise burn bandwidth + CPU every 90s indefinitely.
      if (this.guard?.transientFailed?.(m.version, m.sha256)) return false;
      // wave-2A-F01: flag-gated manifest signature verification.
      const pubkey = _embeddedPubkeyPem();
      const requireSig = !!pubkey
        || process.env.KICKBACKS_REQUIRE_MANIFEST_SIG === "1"
        || process.env.VIBE_ADS_REQUIRE_MANIFEST_SIG === "1";
      if (requireSig) {
        if (!pubkey) {                          // flag on but no embedded key
          this.guard?.markTransientFailed?.(m.version, m.sha256);
          return this.noteFail("missing-pubkey", { version: m.version });
        }
        if (!_verifyManifestSignature(m, pubkey)) {
          this.guard?.markTransientFailed?.(m.version, m.sha256);
          return this.noteFail("sig-verify", { version: m.version });
        }
      }
      // Supply-chain pin: never fetch a VSIX from an origin outside the
      // published bucket (or a dev self-host). Transient so a later corrected
      // manifest still recovers, but the download itself is refused here.
      if (!_vsixUrlAllowed(m.url, this.base)) {
        this.guard?.markTransientFailed?.(m.version, m.sha256);
        return this.noteFail("vsix-url-blocked", { version: m.version, url: m.url });
      }
      let ab: ArrayBuffer;
      try {
        ab = await (await this.f(m.url)).arrayBuffer();
      } catch {
        // Body-read abort: transient. wave-2A-M4: this is the canonical
        // "manifest URL unreachable" case — a peer pointing at a manifest
        // that has localhost:6080 will hit this every poll and silently
        // stay stale forever pre-fix.
        this.guard?.markTransientFailed?.(m.version, m.sha256);
        return this.noteFail("vsix-fetch", { version: m.version, url: m.url });
      }
      // wave-2A-F01: minimum-size sanity, unconditional. Transient — a
      // partial/CDN-stub response should be retried after backoff, not
      // burn the permanent install slot.
      if (ab.byteLength < MIN_VSIX_BYTES) {
        this.guard?.markTransientFailed?.(m.version, m.sha256);
        return this.noteFail("vsix-too-small",
          { version: m.version, bytes: ab.byteLength });
      }
      const got = createHash("sha256").update(Buffer.from(ab)).digest("hex");
      if (got !== m.sha256) {
        // tamper / corruption -> transient (a flapping CDN or in-flight
        // corruption should recover; a persistent attacker still burns
        // only the cooldown rate, not the network).
        this.guard?.markTransientFailed?.(m.version, m.sha256);
        return this.noteFail("sha-mismatch", { version: m.version });
      }
      // Notify the user a new version is about to install (toast). Fires
      // BEFORE markAttempted/install so the user sees the notice in the
      // few seconds the install + restart take. Best-effort: a thrown
      // notifier never blocks the install path.
      try {
        this.onUpdateAvailable?.(
          { version: m.version, current: this.current, rollback: isRollbackForUs });
      } catch { /* notifier is best-effort */ }
      // Mark BEFORE installing/restarting: install() triggers an ext-host
      // restart that can kill this context before a post-install write
      // lands, so a non-converging restart must be fenced here. The guard
      // is cooldown-bounded (see extension.ts) so a TRANSIENT install
      // failure still retries on a later poll instead of bricking forever.
      if (this.guard) this.guard.markAttempted(m.version, m.sha256);
      await this.install(ab);
      // install() resolved without throwing -> record success so this
      // artifact is never re-attempted (the attempted slot above only
      // rate-limits FAILED installs, which skip this line by throwing).
      try { this.guard?.markInstalled?.(m.version, m.sha256); }
      catch { /* best-effort */ }
      // wave-2K-F03: stash the freshly-installed VSIX bytes as last-known-
      // good so an `activate.fatal` (wave-2A-F03 dlog) bootstrap can roll
      // back to it without operator intervention. Persisted by the
      // extension's wired guard (extension.ts); ignored if the guard
      // doesn't implement the hook (older callers).
      try { this.guard?.recordLkg?.(m.version, Buffer.from(ab)); } catch { /* obs only */ }
      this.consecutiveFails = 0;       // wave-2A-M4: success resets counter
      return true;
    } catch (e) {
      // Outer catch: manifest fetch threw (most common case for the M4
      // silent-degradation finding — peer can't reach the manifest URL).
      return this.noteFail("manifest-fetch",
        { msg: errMsg(e) });
    }
  }
}
