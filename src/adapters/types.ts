/** Result of a never-throwing real-install operation. */
export interface OpResult {
  ok: boolean;
  /** Human-readable reason on failure / status note. */
  reason?: string;
}

export interface PreflightResult extends OpResult {
  compatible: boolean;
  /** Target version string if locatable, else null. */
  version: string | null;
}

export interface RestoreResult extends OpResult {
  restored: boolean;
}

export interface PatchParams {
  tier: 0 | 1 | 2 | 3;
  adText: string;
  iconRef: string;
  iconUrl: string;
  clickToken: string;
  /** Advertiser landing URL. Rendered as the ad anchor's real `href` so the
   *  VS Code webview host opens it externally on click — the only click-out
   *  that survives Claude Code's `default-src 'none'` webview CSP (an in-page
   *  fetch to the loopback is CSP-blocked; postMessage reaches CC's extension,
   *  not ours). The loopback is used only for the fire-and-forget click metric
   *  (revived by the companion extension.js connect-src patch). */
  clickUrl: string;
  /** Correlation id minted at patch time (`<adId>.<rand>` / `debug.<rand>`);
   *  threaded into the block's loopback /click ping + relayed dlog lines and
   *  the X-Vibe-Corr metrics header so one grep reconstructs the event chain
   *  (webview → loopback → ext metric → backend ingest). */
  corr: string;
  loopbackPort: number;
  loopbackToken: string;
  /** Webview-reachable loopback base (scheme/host/port + /vibe-ads/<token>).
   *  On VS Code Remote/Server the webview runs on the client, so raw
   *  127.0.0.1 is unreachable — callers resolve this via
   *  vscode.env.asExternalUri before applyPatch. */
  loopbackBase: string;
  /** When true the injected block relays timestamped lifecycle events to the
   *  loopback /log route (→ ~/.vibe-ads/debug.log) for headless diagnosis.
   *  Resolved from VIBE_ADS_DEBUG / the debug.enabled sentinel at patch time. */
  debug?: boolean;
  /** When true the injected block also renders the auction ad in Claude
   *  Code's usage-limit banner (mirror of the spinner ad; spec §3). Resolved
   *  from the server bannerEnabled flag ⊕ the local debug override at patch
   *  time. Empty/false ⇒ the block never touches the banner. */
  bannerOn?: boolean;
  /** W3: cumulative-visible-time threshold (in ms) an ad must accumulate
   *  before it counts as "shown". Server-authoritative via
   *  /v1/portfolio.view_threshold_seconds; falls back to 15_000 ms when the
   *  server did not specify. Baked into the block as
   *  `__VIBE_ADS_VIEW_THRESHOLD_MS__`. */
  viewThresholdMs?: number;
}

/** Ground-truth snapshot for the `Kickbacks: Diagnose` command — everything
 *  needed to tell a cosmetic flash from a real miss without reading the bundle
 *  by hand. `bareVerbPresent` is the key tell: a verb word exists in the live
 *  file but `hasArray` is false ⇒ the bundle format changed (fix the regex);
 *  neither present ⇒ the file was stripped/corrupted (reinstall Claude Code). */
export interface AdapterDiagnostics {
  name: string;
  target: string;
  targetExists: boolean;
  version: string | null;
  compatible: boolean;
  reason?: string;
  isPatched: boolean;
  backup: { exists: boolean; path: string | null; hasArray: boolean; hasBlock: boolean };
  live: { hasArray: boolean; bareVerbPresent: boolean };
}

/** A patch target (Claude Code now; Codex later). All methods are
 *  absolute-path, never-throw, and return typed results. */
export interface TargetAdapter {
  readonly name: string;
  preflight(): PreflightResult;
  version(): string | null;
  applyPatch(p: PatchParams): OpResult;
  /** `keepCsp` (claude-code only) reverts the visible patch but keeps the
   *  loopback connect-src CSP relaxation — see ClaudeCodeAdapter.restore.
   *  Routine deactivate passes it; explicit teardown does not. */
  restore(opts?: { keepCsp?: boolean }): RestoreResult;
  /** True iff the target currently carries our injected block. Cheap
   *  (one file read); lets a reassert tick no-op when already applied so it
   *  only does work when the patch actually drifted (CC overwrite / fresh
   *  load). Optional: adapters without a meaningful notion may omit it. */
  isPatched?(): boolean;
  /** Ground-truth diagnostics for the user-facing diagnose command. Optional:
   *  adapters that don't implement it are simply summarised by preflight(). */
  diagnose?(): AdapterDiagnostics;
  /** Apply ONLY the invisible structural relaxation the loopback needs (the
   *  connect-src CSP insertion on the sibling extension.js) WITHOUT injecting
   *  any ad block. Lets activation prime the surface on every boot — even when
   *  no ad is in hand yet, even signed out — so loopback telemetry works the
   *  moment an ad arrives instead of waiting for a reassert tick or a manual
   *  reload. Idempotent, never throws, reversible via restore() (same keepCsp
   *  contract as applyPatch's CSP layer). A later applyPatch is a no-op on the
   *  CSP it already inserted. Optional: adapters with no structural layer may
   *  omit it. */
  prime?(): OpResult;
}
