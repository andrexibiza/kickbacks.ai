import { timeoutFetch } from "../util/http";

type Fetch = typeof fetch;

/** Which earning ceiling the user has hit (server-authoritative, tiered by
 *  account verification). Drives the red cap-warning status-bar pill. */
export interface EarningCap {
  scope: "hourly" | "daily";
  capUsd: string;
  resetSeconds: number;
}

export interface Earnings {
  lifetimeUsd: string;
  todayUsd: string;
  // Present only while a cap is hit; absent/undefined means "under both
  // ceilings" OR an older backend that doesn't send the field (back-compat).
  cap?: EarningCap | null;
}

/** Defensive parse of the optional `cap` field from /v1/earnings. Returns a
 *  well-typed EarningCap, or undefined for null / missing / malformed input —
 *  a bad cap must never poison the earnings readout (the bar just won't warn).
 *  Exported for direct unit testing. */
export function parseCap(raw: unknown): EarningCap | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as { scope?: unknown; cap_usd?: unknown; reset_seconds?: unknown };
  if ((c.scope !== "hourly" && c.scope !== "daily")
      || typeof c.cap_usd !== "string"
      || typeof c.reset_seconds !== "number"
      || !Number.isFinite(c.reset_seconds))
    return undefined;
  return { scope: c.scope, capUsd: c.cap_usd,
           resetSeconds: Math.max(0, Math.floor(c.reset_seconds)) };
}

/** Optional auth-recovery callback. When the first GET /v1/earnings
 *  returns 401, the client calls this to refresh the access token, then
 *  retries the request exactly once with the new bearer. Without this,
 *  a transient 401 (token rotated mid-poll) leaves the status bar's
 *  `lastUsd`/`lastToday` stale OR blank on the very first poll. */
export type EarningsAuthRecovery = () => Promise<boolean>;

/** GET /v1/earnings — the user's display-only 50/50 credit (today + lifetime),
 *  for the status bar. Fail-safe: any error / signed-out => null; the status
 *  bar then renders $0.00 (it never shows a bare label and never throws). */
export class EarningsClient {
  private f: Fetch;
  constructor(private base: string, private token: () => string | null,
              f: Fetch = timeoutFetch(15000),
              private onAuth401: EarningsAuthRecovery | null = null) {
    // audit-2026-06-09 #38: extension.ts passes bare global `fetch`
    // positionally (only to reach the onAuth401 arg), silently bypassing
    // the timeout default above. Re-wrap that one case so a black-holed
    // connection still aborts; injected test/custom fetches are untouched.
    this.f = f === globalThis.fetch ? timeoutFetch(15000) : f;
  }

  async fetch(): Promise<Earnings | null> {
    const r = await this.fetchDetailed();
    return r.outcome === "ok" ? r.earnings : null;
  }

  /** audit-2026-06-09 #34: like fetch() but preserves the failure KIND so
   *  callers can distinguish a real backend 401 (session expired) from a
   *  transient network / 5xx / malformed-body failure. "401" is only
   *  reported when the backend actually said 401 AND the one-shot
   *  refresh-retry did not recover (no recovery hook, refresh failed, or
   *  the retry 401'd again). */
  async fetchDetailed(): Promise<
    { outcome: "ok"; earnings: Earnings }
    | { outcome: "401" | "error" }
  > {
    try {
      const first = await this.fetchOnce();
      if (first.outcome === "ok") return first;
      // 401 path: refresh once + retry. Any other failure (network,
      // 5xx, malformed body) reports "error" without retry — fail-fast on
      // structural problems so the caller's `lastUsd` cache holds.
      if (first.outcome === "401") {
        if (this.onAuth401 && await this.onAuth401()) {
          // A transient failure on the retry is NOT a session expiry —
          // the refresh itself just succeeded, so pass `second` through.
          const second = await this.fetchOnce();
          return second;
        }
        return { outcome: "401" };
      }
      return { outcome: "error" };
    } catch { return { outcome: "error" }; }
  }

  private async fetchOnce(): Promise<
    { outcome: "ok"; earnings: Earnings }
    | { outcome: "401" | "error" }
  > {
    try {
      const t = this.token();
      if (!t) return { outcome: "error" };
      const r = await this.f(`${this.base}/v1/earnings`,
        { headers: { authorization: `Bearer ${t}` } });
      if (r.status === 401) return { outcome: "401" };
      if (!r.ok) return { outcome: "error" };
      const j = await r.json() as {
        lifetime_usd?: string; today_usd?: string; cap?: unknown };
      if (typeof j.lifetime_usd !== "string" || typeof j.today_usd !== "string")
        return { outcome: "error" };
      return { outcome: "ok",
        earnings: { lifetimeUsd: j.lifetime_usd, todayUsd: j.today_usd,
                    cap: parseCap(j.cap) } };
    } catch { return { outcome: "error" }; }
  }
}
