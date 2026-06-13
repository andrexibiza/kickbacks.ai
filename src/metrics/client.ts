import { randomUUID } from "node:crypto";
import { type AdSurface } from "../types/surface";
import { dlog } from "../log";
import { timeoutFetch } from "../util/http";

export type { AdSurface };

type Fetch = typeof fetch;
// W3 viewership: `view_tick` is a 5s heartbeat fired while an ad accumulates
// visible time; `view_threshold_met` fires exactly once per ad-surface-
// session when cumulative visible time crosses the configured threshold
// (default 15s, server-overridable via portfolio.view_threshold_seconds).
// `error_impression` is the MAX_SESSION_MS safety-net fire (default 5 s) —
// once per session if the natural session-close never lands so a stuck ad
// still bills. Billable view-family events share a backend cooldown bucket so
// only one credit can move inside each cooldown window.
export type MetricEvent =
  | "impression_rendered"
  | "impression_viewable"
  | "prompt_view"
  | "click"
  | "view_tick"
  | "view_threshold_met"
  | "error_impression";

const EVENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newMetricEventUuid(): string {
  return randomUUID();
}

// Deliberate sign-out hook: cmdSignOut calls noteMetricsSignOut() so the
// `demoted:true` stamp (which marks mid-session token DEATH) is not applied
// to demo traffic after an intentional sign-out. Module-scoped, matching the
// adRotation clear hook: exactly one MetricsClient serves an extension host.
let liveSignOutReset: (() => void) | null = null;
export function noteMetricsSignOut(): void {
  liveSignOutReset?.();
}

/** POSTs the S2 /v1/metrics contract (required keys
 *  event_type,ad_id,campaign_id,client_id,ts,nonce; server-authoritative on
 *  tier/measurement). Best-effort: never throws. */
export class MetricsClient {
  // Demo-route demotion tracking: routing keys purely on token absence, so a
  // mid-session token death silently re-routes REAL ad ids to the demo
  // endpoint. `wasAuthed` lets a demoted (was-signed-in) send be stamped so
  // it stays distinguishable from genuine signed-out demo traffic;
  // `demotionLogged` makes the first demotion of each outage observable in
  // the debug log. Routing itself (money semantics) is unchanged.
  private wasAuthed = false;
  private demotionLogged = false;
  constructor(private base: string, private token: () => string | null,
              private clientId: () => string, private extVersion: string,
              private f: Fetch = timeoutFetch(15000),
              // Client-environment fingerprint (os/arch/os_version/editor),
              // computed once at activation and sent on every beacon so the
              // backend can segment ad traffic by client type. Transparent —
              // see app/admin Traffic; nothing here is hidden or obfuscated.
              private clientEnv?: Record<string, unknown>,
              // Fleet-signal sink: the backend piggybacks `kill` (every
              // response) and `balances` (authed + billed) on the beacon
              // response, replacing standalone polls. Optional + best-effort.
              private signals: { noteKill(raw: unknown): void;
                                 noteBalances(raw: unknown): void }
                | null = null) {
    liveSignOutReset = () => {
      this.wasAuthed = false;
      this.demotionLogged = false;
    };
  }

  async send(event: MetricEvent,
             a: { adId: string; campaignId: string; ccVersion: string;
                  corr?: string; surface?: AdSurface; visibleMs?: number;
                  sessionNonce?: string; viewable?: boolean;
                  viewPct?: number; viewMs?: number;
                  sessionToken?: string; eventUuid?: string }): Promise<void> {
    try {
      const eventUuid = a.eventUuid && EVENT_UUID_RE.test(a.eventUuid)
        ? a.eventUuid
        : newMetricEventUuid();
      const body: Record<string, unknown> = {
        event_type: event, ad_id: a.adId, campaign_id: a.campaignId,
        client_id: this.clientId(), ts: new Date().toISOString(),
        claude_code_version: a.ccVersion, extension_version: this.extVersion,
        nonce: eventUuid,
      };
      // W3 viewership additions — only included when present so we don't
      // pollute legacy event shapes (impression_*, click) with empty fields.
      if (a.surface) body.surface = a.surface;
      if (typeof a.visibleMs === "number") body.visible_ms = a.visibleMs;
      if (a.sessionNonce) body.session_nonce = a.sessionNonce;
      if (typeof a.viewable === "boolean") body.viewable = a.viewable;
      if (typeof a.viewPct === "number") body.view_pct = a.viewPct;
      if (typeof a.viewMs === "number") body.view_ms = a.viewMs;
      if (a.sessionToken) body.session_token = a.sessionToken;
      if (this.clientEnv) body.ext = this.clientEnv;
      const t = this.token();
      // Demo routing: a tokenless (signed-out) send goes to the public
      // /v1/metrics/demo — it charges the advertiser but credits no user (the
      // platform keeps 100%). The signed-in path is byte-identical to before.
      // The `client_id` already in `body` is the demo identity anchor that the
      // backend pairs with the demo session token. One switch here covers every
      // surface (overlay + status bar); signed-out used to send nothing at all.
      const path = t ? "/v1/metrics" : "/v1/metrics/demo";
      if (t) {
        this.wasAuthed = true;
        this.demotionLogged = false;
      } else {
        // Stamp every demo-route send inside `ext` — the only schema-allowed
        // free-form field (the backend 400s unknown top-level keys). A send
        // demoted by a mid-session token death additionally carries
        // `demoted:true` so analytics can tell it apart from genuine
        // signed-out demo traffic.
        const demoted = this.wasAuthed;
        body.ext = { ...(this.clientEnv ?? {}), demo: true,
          ...(demoted ? { demoted: true } : {}) };
        if (demoted && !this.demotionLogged) {
          this.demotionLogged = true;
          dlog("ext", "metric.demo_demoted", { event, adId: a.adId });
        }
      }
      const res = await this.f(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json",
          ...(t ? { authorization: `Bearer ${t}` } : {}),
          // W1 rename: send the new header AND the legacy one for one release
          // so the backend dual-accept can be staged independently.
          ...(a.corr ? { "X-Kickbacks-Corr": a.corr, "X-Vibe-Corr": a.corr } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        dlog("ext", "metric.send_failed", { status: res.status, event });
      } else if (this.signals) {
        // Fleet signals: only a FRESH 2xx body may produce a verdict; a
        // failed/old-backend response body (empty, non-JSON, no fields)
        // simply yields nothing. Balances only when this send was authed —
        // a demo-route response never carries them and must never repaint
        // a signed-out status bar.
        try {
          const j = await res.json() as { kill?: unknown; balances?: unknown };
          this.signals.noteKill(j?.kill);
          if (t) this.signals.noteBalances(j?.balances);
        } catch { /* old backend / empty body — no signal */ }
      }
    } catch (e) {
      // Still best-effort (never throws past here) — but a network-level
      // failure must stay greppable, not a total observability blackout.
      dlog("ext", "metric.send_error",
        { event, msg: e instanceof Error ? e.message : String(e) });
    }
  }
}
