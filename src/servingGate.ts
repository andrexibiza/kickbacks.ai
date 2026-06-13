/** Central serving gate — the ONE predicate every ad-patch writer consults
 *  before touching user files or handing an ad to a webview (wave 2, audit
 *  2026-06-09 findings #3/#4/#6/#9/#14/#19).
 *
 *  Pre-fix, several independent timers (the 60s debug reassert, the rotation
 *  tick, the 60s cliSync loop, boot-canary patching, the webview reasserts,
 *  the live loopback /ad route) each re-applied the ad patch without
 *  consulting the global gates, so a killed or user-disabled install
 *  oscillated restore→re-patch forever. The gate owns the three inputs and
 *  every writer asks it first:
 *
 *    1. kill posture — "clear" (healthy), "confirmed" (a 200 from
 *       /v1/killswitch said killed:true), or "offline" (the endpoint was
 *       unreachable / non-200 — we genuinely don't know). The split is the
 *       kill HYSTERESIS: confirmed ⇒ restore everything; offline ⇒ FREEZE
 *       (no restore, no new writes) so a wifi blip never churns the user's
 *       Claude Code install while staying fail-closed for new writes.
 *    2. the user master toggle — wired by extension.ts to the
 *       DebugController's persisted intent. A deliberate "Disable Kickbacks"
 *       / Restore command reads disabled here; the sign-out pause (K_ON
 *       forced false but K_PRESIGNOUT remembered) stays ENABLED so the
 *       signed-out demo flow keeps working (the Wave-1 sign-out contract).
 *    3. crash-canary suspension — "skip automatic patch this run". Session-
 *       scoped; lifted only by an explicit user re-enable (setOn(true)),
 *       matching the canary toast's wording.
 *
 *  Module-scoped singleton (same idiom as adRotation's sign-out hook):
 *  exactly one serving posture exists per extension host, and the writers
 *  live in modules that don't all share an ActivationContext. activate()
 *  resets it; tests reset via resetServingGate(). Every read is guarded —
 *  the gate itself can never throw into a writer (prime directive). */

export type KillPosture = "clear" | "confirmed" | "offline";

/** What a periodic writer should do this tick:
 *    "write"   — healthy + enabled + not suspended ⇒ normal apply path.
 *    "freeze"  — offline-unsure or canary-suspended ⇒ neither write NOR
 *                restore (keep the current on-disk state, keep checking).
 *    "restore" — confirmed kill or user-disabled ⇒ tear the patch down. */
export type ServingVerdict = "write" | "freeze" | "restore";

const state = {
  kill: "clear" as KillPosture,
  enabled: (() => true) as () => boolean,
  suspended: false,
};

function safeEnabled(): boolean {
  try { return state.enabled(); } catch { return false; }
}

/** Back to the boot defaults (healthy, enabled, not suspended). Called at
 *  the top of activate() so a reloaded host never inherits stale posture. */
export function resetServingGate(): void {
  state.kill = "clear";
  state.enabled = () => true;
  state.suspended = false;
}

/** Wire the user-master-toggle input (extension.ts: the DebugController's
 *  persisted intent). Defaults to "enabled" so unit tests that exercise a
 *  single subsystem in isolation see today's behavior unless they opt in. */
export function wireServingGateEnabled(fn: () => boolean): void {
  state.enabled = fn;
}

export function setKillPosture(p: KillPosture): void { state.kill = p; }
export function killPosture(): KillPosture { return state.kill; }

/** Crash-canary: no automatic patch writes for the rest of this session. */
export function suspendServing(): void { state.suspended = true; }
/** Explicit user re-enable (DebugController.setOn(true)) lifts it. */
export function clearServingSuspension(): void { state.suspended = false; }
export function servingSuspended(): boolean { return state.suspended; }

/** Single source of truth for the per-tick writer decision. Precedence:
 *  a CONFIRMED kill and a deliberate disable always win (restore); the
 *  offline freeze and the canary suspension hold the line (no churn);
 *  otherwise write. */
export function servingVerdict(): ServingVerdict {
  if (state.kill === "confirmed") return "restore";
  if (!safeEnabled()) return "restore";
  if (state.kill === "offline") return "freeze";
  if (state.suspended) return "freeze";
  return "write";
}

/** May a writer WRITE an ad patch (or start serving a new ad) right now? */
export function canPatch(): boolean { return servingVerdict() === "write"; }

/** May the live loopback keep handing /ad payloads to running webviews?
 *  Stricter than "freeze": only a CONFIRMED kill or a deliberate disable
 *  stops serving (the webview drops its overlay within one 10s poll).
 *  Offline-unsure keeps serving the current ad — that's the freeze
 *  contract — and the canary suspension only blocks PATCH writes (a stale
 *  webview from a prior session may still legitimately poll). */
export function canServeAds(): boolean {
  return state.kill !== "confirmed" && safeEnabled();
}

/** Snapshot for UI painters that need to know WHY serving is off
 *  (killed / offline / disabled-or-suspended). */
export function servingGateSnapshot():
  { kill: KillPosture; enabled: boolean; suspended: boolean } {
  return { kill: state.kill, enabled: safeEnabled(),
           suspended: state.suspended };
}
