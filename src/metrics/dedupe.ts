/** One impression per (kind, surface, adId) for the lifetime of a loopback
 *  session. Same ad on overlay vs banner vs codex_overlay vs statusline are
 *  distinct visual impressions and each fires once. Server-side credit_gate
 *  (keyed by user+ad+event_type) still prevents the user from being
 *  double-credited if the same ad shows on multiple surfaces. Clicks are NOT
 *  routed through this. */
export class ImpressionDedupe {
  private readonly seen = new Set<string>();
  shouldSend(kind: string, adId: string, surface?: string): boolean {
    const key = kind + ":" + (surface || "default") + ":" + adId;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  reset(): void { this.seen.clear(); }
}
