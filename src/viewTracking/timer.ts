/** W3 ad-viewership tracker.
 *
 *  WARNING — NOT SHIPPED (verified 2026-06-10, audit #23 / wave-1 EXT-03):
 *  no production code imports this class. The esbuild bundle (entry
 *  src/extension.ts) never reaches it; its only consumer is
 *  test/viewTimer.test.ts. The LIVE view timers are block.asset.js (`_vt`,
 *  CC overlay/banner), codex/block.asset.js, and statusBarAd.ts's inline
 *  interval — all of which now END sessions on hide and CLAMP suspend/wake
 *  poll gaps (see SUSPEND_GAP_MS in block.asset.js and the contract pinned
 *  by test/cc-viewtimer.test.ts). This class still has the PRE-FIX
 *  semantics by design of its 2026-05-22 refactor (no-op hide()/pause(),
 *  unbounded wall-clock catch-up loop in emitTickIfDue — a laptop suspend
 *  would replay the whole sleep gap as a billable tick burst on wake).
 *  Do NOT wire it into a billing surface without first porting the
 *  suspend-gap clamp + hide-ends-session semantics from block.asset.js.
 *
 *  An ad must accumulate `thresholdMs` of cumulative ELAPSED TIME on a
 *  surface before it counts as "shown" and is eligible for credit. As of
 *  the absolute-epoch baseline refactor, elapsed time is computed as
 *  `now() - sessionStartedAt` on every poll — no accumulator, no
 *  show/hide-driven pause. Rationale: the prior accumulator-with-pause
 *  model dropped time whenever the 250 ms poll skipped (throttled tab,
 *  CPU pressure) and produced "stuck session never bills" log signatures.
 *  An absolute baseline is immune to poll-cadence drift, at the cost of
 *  no longer pausing while the webview is hidden — bounded in practice
 *  by mutual exclusion below + the server-side cooldown gate.
 *
 *  Two surfaces are tracked independently: the spinner-verb `overlay` and
 *  the usage-banner `banner`. The same ad can be shown on both surfaces in
 *  one session and each accumulates separately (it's a different visual
 *  impression).
 *
 *  Hooks:
 *    onTick(...)       — fired every `tickMs` of elapsed time (default
 *                        5000 ms). Used to send `view_tick` metrics.
 *    onThresholdMet()  — fired exactly once per (adId, surface, session)
 *                        when elapsed crosses `thresholdMs`.
 *    onErrorImpression() — fired at EVERY `maxSessionMs` boundary of
 *                        elapsed time. Default 5 s, so a 30 s stuck
 *                        session fires 6 events (at 5/10/15/20/25/30 s).
 *                        Backend cooldown gate (cooldown_view_seconds)
 *                        decides which of those actually credit. Mutually
 *                        exclusive with onThresholdMet: if any
 *                        error_impression has fired this session,
 *                        threshold_met is suppressed — in practice this
 *                        means threshold_met only fires when the cap is
 *                        disabled (`maxSessionMs: 0`) or when
 *                        `thresholdMs < maxSessionMs` (threshold-first
 *                        config). */

import { type AdSurface } from "../types/surface";

export type { AdSurface };

export interface TickEvent {
  adId: string;
  surface: AdSurface;
  sessionNonce: string;
  visibleMs: number;          // elapsed since session start (now - sessionStartedAt)
}

export interface ThresholdEvent extends TickEvent {
  thresholdMs: number;
}

export interface ErrorImpressionEvent extends TickEvent {
  maxSessionMs: number;
}

export interface ViewTimerOptions {
  thresholdMs: number;                              // default 15_000
  tickMs?: number;                                  // default 5_000
  // MAX_SESSION_MS safety-net cap: if elapsed crosses this without a
  // natural close, fire onErrorImpression exactly once so a stuck ad
  // still bills. Default 5_000 ms (matches block.asset.js).
  maxSessionMs?: number;
  now?: () => number;                               // injectable for tests
  onTick?: (e: TickEvent) => void;
  onThresholdMet?: (e: ThresholdEvent) => void;
  onErrorImpression?: (e: ErrorImpressionEvent) => void;
}

interface Session {
  adId: string;
  surface: AdSurface;
  sessionNonce: string;
  sessionStartedAt: number;     // absolute epoch when session started; never resets within a session
  lastTickAtMs: number;         // last tick emitted at this elapsed total
  thresholdMet: boolean;
  // Count of error_impression events fired so far this session. Used to
  // gate the *next* fire (at `(count+1) * maxSessionMs`) AND as the mutex
  // signal for threshold_met (suppressed once any error_impression has
  // fired this session).
  errorImpressionCount: number;
}

export class ViewTimer {
  private sessions = new Map<string, Session>();
  private readonly thresholdMs: number;
  private readonly tickMs: number;
  private readonly maxSessionMs: number;
  private readonly now: () => number;
  private readonly onTick?: (e: TickEvent) => void;
  private readonly onThresholdMet?: (e: ThresholdEvent) => void;
  private readonly onErrorImpression?: (e: ErrorImpressionEvent) => void;

  constructor(opts: ViewTimerOptions) {
    this.thresholdMs = Math.max(0, opts.thresholdMs);
    this.tickMs = Math.max(100, opts.tickMs ?? 5_000);
    this.maxSessionMs = Math.max(0, opts.maxSessionMs ?? 5_000);
    this.now = opts.now ?? (() => Date.now());
    this.onTick = opts.onTick;
    this.onThresholdMet = opts.onThresholdMet;
    this.onErrorImpression = opts.onErrorImpression;
  }

  private key(adId: string, surface: AdSurface): string {
    return `${surface}:${adId}`;
  }

  private elapsedFor(s: Session): number {
    return Math.max(0, this.now() - s.sessionStartedAt);
  }

  /** Mark an ad as currently visible on a surface. Idempotent on the same
   *  sessionNonce — the absolute baseline is sticky and does NOT restart
   *  on repeated show() calls. A new sessionNonce resets the session. */
  show(adId: string, surface: AdSurface, sessionNonce: string): void {
    const k = this.key(adId, surface);
    const existing = this.sessions.get(k);
    if (!existing) {
      this.sessions.set(k, { adId, surface, sessionNonce,
        sessionStartedAt: this.now(), lastTickAtMs: 0,
        thresholdMet: false, errorImpressionCount: 0 });
      return;
    }
    if (existing.sessionNonce !== sessionNonce) {
      // Fresh session — restart the baseline + clear all gate flags.
      existing.sessionNonce = sessionNonce;
      existing.sessionStartedAt = this.now();
      existing.lastTickAtMs = 0;
      existing.thresholdMet = false;
      existing.errorImpressionCount = 0;
    }
    // Same nonce — sticky baseline; nothing to update.
  }

  /** No-op under the absolute-epoch baseline. The elapsed counter is
   *  driven by wall clock from sessionStartedAt; a hidden ad still counts
   *  toward billing because we cannot reliably re-anchor across poll
   *  cadence drops (Page Visibility blur, tab throttling). Kept as a
   *  public method so callers don't need to be rewritten. */
  hide(_adId: string, _surface: AdSurface): void { /* no-op */ }

  /** No-op under the absolute-epoch baseline. See hide(). */
  pause(): void { /* no-op */ }

  /** No-op under the absolute-epoch baseline. See hide(). */
  resume(): void { /* no-op */ }

  /** Drive the periodic emissions. Production calls this every ~250 ms;
   *  tests advance the clock and call it directly. Safe to call multiple
   *  times per "real" wall-clock tick: emissions are idempotent (each
   *  session's threshold-met / error_impression fires at most once). */
  poll(): void {
    for (const s of this.sessions.values()) {
      const elapsed = this.elapsedFor(s);
      this.emitTickIfDue(s, elapsed);
      this.emitThresholdIfMet(s, elapsed);
      this.emitErrorImpressionIfStuck(s, elapsed);
    }
  }

  private emitTickIfDue(s: Session, elapsed: number): void {
    if (!this.onTick) { s.lastTickAtMs = elapsed; return; }
    while (elapsed - s.lastTickAtMs >= this.tickMs) {
      s.lastTickAtMs += this.tickMs;
      this.onTick({ adId: s.adId, surface: s.surface,
        sessionNonce: s.sessionNonce, visibleMs: s.lastTickAtMs });
    }
  }

  private emitThresholdIfMet(s: Session, elapsed: number): void {
    if (s.thresholdMet) return;
    // Mutual exclusion: if ANY error_impression has fired this session,
    // suppress the natural threshold-met event. With default cap=5s and
    // threshold=15s this means threshold_met effectively never fires;
    // when the cap is disabled (maxSessionMs=0) threshold_met still works.
    if (s.errorImpressionCount > 0) return;
    if (elapsed < this.thresholdMs) return;
    s.thresholdMet = true;
    this.onThresholdMet?.({
      adId: s.adId, surface: s.surface, sessionNonce: s.sessionNonce,
      visibleMs: elapsed, thresholdMs: this.thresholdMs,
    });
  }

  private emitErrorImpressionIfStuck(s: Session, elapsed: number): void {
    // Mutex: once threshold_met has billed this session, do not also fire
    // error_impression — preserves the codex-rescue "one bill per session"
    // contract for the threshold-first config (maxSessionMs > thresholdMs).
    if (s.thresholdMet) return;
    if (this.maxSessionMs <= 0) return;        // disabled
    // Fire at every maxSessionMs boundary of elapsed time. A `nextFireAt`
    // computed from `errorImpressionCount` keeps the cadence exact even
    // when poll() skips: if 11 s elapsed since the last fire, the next
    // single poll fires once and advances the marker; we do NOT fire
    // twice to "catch up" (that would burst-bill on a throttled tab).
    const nextFireAt = (s.errorImpressionCount + 1) * this.maxSessionMs;
    if (elapsed < nextFireAt) return;
    s.errorImpressionCount += 1;
    this.onErrorImpression?.({
      adId: s.adId, surface: s.surface, sessionNonce: s.sessionNonce,
      visibleMs: elapsed, maxSessionMs: this.maxSessionMs,
    });
  }

  /** Inspection helpers (used by tests + diagnostics). */
  visibleMsFor(adId: string, surface: AdSurface): number {
    const s = this.sessions.get(this.key(adId, surface));
    return s ? this.elapsedFor(s) : 0;
  }
  hasMetThreshold(adId: string, surface: AdSurface): boolean {
    return this.sessions.get(this.key(adId, surface))?.thresholdMet === true;
  }
}
