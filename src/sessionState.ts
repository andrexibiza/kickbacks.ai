import { dlog } from "./log";

/** Single source of truth for the cross-component session state that
 *  several UI surfaces used to derive independently — and frequently
 *  disagreed on (status bar reading auth.signedIn() while the menu
 *  read K_ON, etc.). Every state-changing call site `set()`s into here;
 *  every UI subscriber gets the new snapshot in one place. Each change
 *  is also logged so `debug.log` shows a state-transition timeline. */
export interface SessionSnapshot {
  /** True iff we hold an access token the extension considers usable.
   *  Driven by the AuthClient's in-memory `at`; goes false when refresh
   *  fails or signOut runs. Does NOT prove the backend still accepts
   *  the token — `authHealthy` reflects the last real call. */
  signedIn: boolean;
  /** Backend response status for the most recent authenticated call.
   *  Tracking this separately from `signedIn` lets the UI distinguish
   *  "we have a token but every call 401s" (the bug class the user
   *  asked about) from a clean signed-out / signed-in state. */
  authHealthy: "ok" | "401" | "unknown";
  /** K_ON — the debug-injection master toggle. */
  injectionOn: boolean;
  /** True iff a kill switch (server or override) is engaged. */
  killed: boolean;
  /** True iff the most recent portfolio fetch returned a winning ad. */
  hasAd: boolean;
  /** Claude Code version (for the status bar version label). */
  ccVersion: string;
}

const INITIAL: SessionSnapshot = {
  signedIn: false, authHealthy: "unknown", injectionOn: false,
  killed: false, hasAd: false, ccVersion: "unknown",
};

export class SessionState {
  private snap: SessionSnapshot = { ...INITIAL };
  private subs: Array<(s: SessionSnapshot) => void> = [];

  get(): Readonly<SessionSnapshot> { return this.snap; }

  set(patch: Partial<SessionSnapshot>): void {
    // Cheap structural-equality check: avoid spamming debug.log when a
    // no-op set comes through (showActive ticks, periodic kill polls).
    const before = JSON.stringify(this.snap);
    this.snap = { ...this.snap, ...patch };
    const after = JSON.stringify(this.snap);
    if (before === after) return;
    dlog("ext", "session.state", this.snap as unknown as Record<string, unknown>);
    for (const fn of this.subs) {
      try { fn(this.snap); } catch { /* observers are best-effort */ }
    }
  }

  onChange(fn: (s: SessionSnapshot) => void): void { this.subs.push(fn); }

  /** Operator-readable single-line summary used in diagnostic dumps and
   *  the debug menu's "Built …" info row context. */
  describe(): string {
    const s = this.snap;
    const auth = s.signedIn ? (s.authHealthy === "401" ? "in (broken)" :
      s.authHealthy === "ok" ? "in" : "in (unknown)") : "out";
    return `auth: ${auth}  injection: ${s.injectionOn ? "on" : "off"}  ad: ${
      s.hasAd ? "yes" : "no"}  killed: ${s.killed ? "yes" : "no"}  cc: ${s.ccVersion}`;
  }
}
