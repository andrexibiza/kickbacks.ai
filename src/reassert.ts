/** Whether the injected webview patch should be (re)asserted on this timer
 *  tick. The extension reapplies the block on an interval so a Claude Code
 *  self-update / relaunch that silently overwrites index.js is healed without
 *  the user doing a manual reload — but ONLY while the extension is healthy:
 *  an ad in hand and not kill-switched. Pure; the single source of truth for
 *  the reassert health gate. applyPatch itself is idempotent (writes only when
 *  the file actually drifted), so a steady state is a cheap no-op and this
 *  never fights the kill-switch (gated on `killed`).
 *
 *  Sign-in is intentionally NOT part of the gate: a signed-out user holding a
 *  DEMO ad must reassert too, so the preview self-heals like the real product.
 *  `haveAd` already implies an ad is in hand (real or demo) — when signed out
 *  with no demo ad it is false, so the prior signed-out behaviour is preserved.
 */
export function shouldReassert(s: {
  haveAd: boolean;
  killed: boolean;
}): boolean {
  return s.haveAd && !s.killed;
}

/** Tiered self-heal policy for the "patched file on disk but the webview
 *  cached the pre-patch module" desync (block.desync) — the failure mode
 *  where ads silently stop rendering even though `isPatched()` is true, so
 *  the cheap drift-only reasserts (reassertWebview / reassertTick) can't see
 *  it. THIS is the case that forced a manual "Re-apply patch now".
 *
 *  Escalation ladder, cheapest + least disruptive first, and ONLY when there
 *  is positive evidence the user is actively using Claude Code (recent
 *  transcript writes) yet our overlay telemetry has gone silent. When the
 *  user is simply idle there is NO block.start to expect — that is not a
 *  desync, so we must not disrupt. Pure + the single source of truth so the
 *  cadence stays testable and deliberately non-aggressive. */
export const DESYNC_DEFAULTS = {
  // CC transcript written within this window => the user is actively using
  // Claude Code right now (independent of our overlay).
  ccActiveMs: 120_000,
  // Overlay silent at least this long (while CC is active) => treat as a
  // real desync worth healing. Patience knob: high enough that a briefly
  // unfocused panel or a normal lull never trips it.
  silenceMs: 300_000,
  toastCooldownMs: 30 * 60_000,
} as const;

export type DesyncAction = "none" | "cycle" | "reload" | "toast";

export function desyncDecision(i: {
  now: number;
  startedAt: number;            // detector start (activation) — the silence floor
  lastApplyAt: number;
  lastBlockStartAt: number;     // last overlay render = our telemetry heartbeat
  ccActivityAgeMs: number | null; // age of last CC transcript write; null = unknown
  healthy: boolean;             // shouldReassert(): signed-in + have-ad + not-killed
  cyclePatchTried: boolean;
  reloadTried: boolean;
  toastShownAt: number;
  /** True while CC is in an active tool_use turn (e.g. a long-running
   *  sub-agent the orchestrator is waiting on). Disruptive escalation
   *  (reload, toast) is deferred until the turn completes so we never
   *  interrupt an ongoing task. cycle (file-identity nudge only) is still
   *  allowed. null/undefined = unknown → treated as not active. */
  ccTurnActive?: boolean | null;
}, k: { ccActiveMs: number; silenceMs: number; toastCooldownMs: number } = DESYNC_DEFAULTS):
  { action: DesyncAction; reason: string } {
  if (!i.healthy) return { action: "none", reason: "unhealthy" };
  if (i.lastApplyAt === 0) return { action: "none", reason: "no-apply" };
  // Overlay rendered since the last apply => in sync, nothing to heal.
  if (i.lastBlockStartAt >= i.lastApplyAt) return { action: "none", reason: "in-sync" };
  // Idle gate (the key non-aggression rule): act ONLY when CC is actively in
  // use. No/unknown activity => a missing block.start is EXPECTED, not a desync.
  if (i.ccActivityAgeMs == null || i.ccActivityAgeMs > k.ccActiveMs)
    return { action: "none", reason: "cc-idle" };
  // Patience: require sustained overlay silence before any disruption.
  const silentMs = i.now - Math.max(i.lastBlockStartAt, i.startedAt);
  if (silentMs < k.silenceMs) return { action: "none", reason: "within-grace" };
  // Escalation ladder: cheap file-identity nudge, then webview reload, then
  // (last resort, user-consented) a window reload.
  if (!i.cyclePatchTried) return { action: "cycle", reason: "escalate" };
  // Defer disruptive actions while a CC turn is actively running (sub-agent).
  // reloadWebviewContent would interrupt the task; the toast would mislead
  // the user into thinking a reload is safe right now. cycle (already fired)
  // only touches the file identity — non-disruptive. When the turn finishes,
  // the next tick re-evaluates and escalates to reload if still needed.
  if (i.ccTurnActive === true) return { action: "none", reason: "cc-turn-active" };
  if (!i.reloadTried) return { action: "reload", reason: "escalate" };
  if (i.now - i.toastShownAt >= k.toastCooldownMs) return { action: "toast", reason: "escalate" };
  return { action: "none", reason: "cooldown" };
}
