import type { KillState } from "./killswitch/client";
import type { EarningCap } from "./earnings/client";
import { parseCap } from "./earnings/client";

/** Fleet-chattiness fix (2026-06-12): the backend piggybacks the killswitch
 *  verdict (`kill`) and the status-bar earnings (`balances`, now incl. `cap`)
 *  on the portfolio + metrics responses the extension already fetches. This
 *  store receives those signals from the wire clients and lets the standalone
 *  GET /v1/killswitch and GET /v1/earnings pollers stand down while the
 *  piggybacked data is fresh — together those polls were ~60% of backend
 *  traffic at fleet scale.
 *
 *  Trust rules (the load-bearing part):
 *    - Only a FRESH 2xx with a parseable field may produce a signal. Carrier
 *      failures (401/5xx/network/missing field/warm-cache fallback) produce
 *      NOTHING here — in particular they must never set the kill `offline`
 *      posture; only the standalone fallback poller may do that. An auth
 *      failure is not evidence about the kill table.
 *    - A parsed kill verdict gets `confirmed: killed` (it came from a 200),
 *      matching KillSwitchClient's 200-path semantics exactly.
 *    - `capCapable` records whether the carrier had the `cap` KEY at all:
 *      key-present (even when null) = piggyback-capable backend; key-absent =
 *      old backend, so the earnings poller must keep running. */

/** How long a piggybacked kill verdict suppresses the standalone
 *  /v1/killswitch poll. 90s = one missed 60s portfolio refresh plus slack;
 *  an idle-but-open editor's worst-case kill latency becomes ~65s (60s
 *  portfolio + 5s server cache) with the fallback poll resuming inside 90s.
 *  Tuning knob — drop to 45_000 if that idle window ever matters more than
 *  the request savings. */
export const KILL_STALE_MS = 90_000;

/** How long piggybacked balances satisfy the status bar before showActive
 *  falls back to a real GET /v1/earnings. Same 90s logic as the kill gate. */
export const EARNINGS_STALE_MS = 90_000;

export interface EarningsSnapshot {
  lifetimeUsd: string;
  todayUsd: string;
  /** Defensive-parsed cap; undefined = under both ceilings or unparseable. */
  cap?: EarningCap;
  /** True when the carrier response had the `cap` key — the new-backend
   *  marker. While false the standalone /v1/earnings poll must continue
   *  (its response is the only source of the cap pill on old backends). */
  capCapable: boolean;
  updatedAt: number;
}

/** Defensive parse of a piggybacked `kill` field. Returns undefined for
 *  null / missing / malformed input — never a fail-safe verdict: an absent
 *  field only means "this carrier doesn't speak the protocol", which the
 *  staleness-gated fallback poller covers. Exported for unit tests. */
export function parseKillField(raw: unknown): KillState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const k = raw as { killed?: unknown; scope?: unknown; reason?: unknown };
  if (typeof k.killed !== "boolean") return undefined;
  return {
    killed: k.killed,
    confirmed: k.killed, // fresh 200 ⇒ same trust as KillSwitchClient's 200
    scope: typeof k.scope === "string" ? k.scope : undefined,
    reason: typeof k.reason === "string" ? k.reason : undefined,
    offline: false,
  };
}

/** Defensive parse of a piggybacked `balances` block. Returns undefined on
 *  anything malformed — a bad block must never poison the status bar. */
export function parseBalancesField(raw: unknown): EarningsSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as { lifetime_usd?: unknown; today_usd?: unknown };
  if (typeof b.lifetime_usd !== "string" || typeof b.today_usd !== "string")
    return undefined;
  return {
    lifetimeUsd: b.lifetime_usd,
    todayUsd: b.today_usd,
    cap: parseCap((raw as { cap?: unknown }).cap),
    capCapable: "cap" in (raw as Record<string, unknown>),
    updatedAt: Date.now(),
  };
}

// Sign-out hook, module-scoped to match noteMetricsSignOut /
// clearAdRotationOnSignOut: exactly one FleetSignals serves an extension
// host, and cmdSignOut must drop the old identity's balances so the next
// paint can't show the previous user's money.
let liveSignOutClear: (() => void) | null = null;
export function noteFleetSignalsSignOut(): void {
  liveSignOutClear?.();
}

export class FleetSignals {
  private lastKillVerdictAt = 0;
  private lastKillVerdict: KillState | null = null;
  private earnings: EarningsSnapshot | null = null;
  private killSink: ((ks: KillState) => void) | null = null;
  private earningsSink: (() => void) | null = null;

  constructor() {
    liveSignOutClear = () => this.clearEarnings();
  }

  /** Wire-client entry point: raw `kill` field off a fresh 2xx body. */
  noteKill(raw: unknown): void {
    const ks = parseKillField(raw);
    if (!ks) return;
    this.lastKillVerdictAt = Date.now();
    this.lastKillVerdict = ks;
    try { this.killSink?.(ks); } catch { /* sink must never break a fetch */ }
  }

  /** Wire-client entry point: raw `balances` field off a fresh AUTHED 2xx. */
  noteBalances(raw: unknown): void {
    const snap = parseBalancesField(raw);
    if (!snap) return;
    this.earnings = snap;
    try { this.earningsSink?.(); } catch { /* never break a fetch */ }
  }

  /** True while the standalone killswitch poll may stand down. */
  killFreshWithin(ms: number): boolean {
    return this.lastKillVerdictAt > 0
      && Date.now() - this.lastKillVerdictAt < ms;
  }

  earningsSnapshot(): EarningsSnapshot | null {
    return this.earnings;
  }

  earningsFreshWithin(ms: number): boolean {
    return !!this.earnings && Date.now() - this.earnings.updatedAt < ms;
  }

  /** Sign-out teardown: piggybacked balances belong to the old identity. */
  clearEarnings(): void {
    this.earnings = null;
  }

  /** Registers the verdict sink and immediately replays a buffered fresh
   *  verdict: activation fetches the first portfolio BEFORE the kill
   *  machinery exists, so without the replay that boot verdict would both
   *  suppress the standalone poll (fresh timestamp) AND never be applied. */
  onKillVerdict(sink: (ks: KillState) => void): void {
    this.killSink = sink;
    if (this.lastKillVerdict && this.killFreshWithin(KILL_STALE_MS)) {
      try { sink(this.lastKillVerdict); } catch { /* never break wiring */ }
    }
  }

  onEarningsUpdated(sink: () => void): void {
    this.earningsSink = sink;
  }
}
