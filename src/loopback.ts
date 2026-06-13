import * as vscode from "vscode";
import { createServer, Server } from "node:http";
import { randomBytes } from "node:crypto";
import { dlog, dlogRaw } from "./log";
import { type AdSurface, parseAdSurface } from "./types/surface";

/** The base URL the WEBVIEW must use to reach this loopback. On VS Code
 *  Remote/Server the webview runs on the *client*, so raw 127.0.0.1 (the
 *  remote host's loopback) is unreachable; vscode.env.asExternalUri returns a
 *  tunneled URL the client can reach (identity no-op on local desktop).
 *  Always includes the /vibe-ads/<token> path so the block uses it verbatim.
 *  Falls back to 127.0.0.1 if the API is unavailable/throws. */
export async function resolveLoopbackBase(
  port: number, token: string): Promise<string> {
  const local = `http://127.0.0.1:${port}`;
  try {
    const ext = await vscode.env.asExternalUri(vscode.Uri.parse(local));
    return ext.toString().replace(/\/+$/, "") + "/vibe-ads/" + token;
  } catch {
    return local + "/vibe-ads/" + token;
  }
}

export type LoopbackMetricKind =
  | "impression_rendered"
  | "impression_viewable"
  | "view_tick"
  | "view_threshold_met"
  | "error_impression";

export interface LoopbackMetricPayload {
  surface?: AdSurface;
  visibleMs?: number;
  sessionNonce?: string;
  eventUuid?: string;
  viewable?: boolean;
  viewPct?: number;
  viewMs?: number;
  /** The ad the webview CLAIMS this event belongs to (`ad=` query param on
   *  the block's metric GETs). For up to one 10s /ad poll after a rotation
   *  the webview is still running the OLD ad's view sessions, so the host
   *  must not stamp attribution from its current activeAd (audit #17). The
   *  deployed block sends the ad TEXT here (its view sessions key on AD);
   *  hosts resolve either form against their recently-served registry.
   *  Deliberately NOT named adId: downstream senders spread this payload
   *  over already-resolved billing fields. */
  claimedAdId?: string;
}

export interface LoopbackAdPayload {
  adText: string;
  clickUrl: string;
  iconUrl: string;
  adId: string;
  campaignId: string;
}

export interface LoopbackHandlers {
  onEvent: (kind: LoopbackMetricKind, payload: LoopbackMetricPayload) => void;
  onClick: (clickToken: string,
    surface?: AdSurface,
    visibleMs?: number,
    eventUuid?: string,
    /** `ad=` query param — see LoopbackMetricPayload.claimedAdId. */
    claimedAdId?: string) => void;
  getActivity: () => Record<string, unknown>;
  getCurrentAd: () => LoopbackAdPayload | null;
  /** Optional: every webview-relayed /log POST is mirrored here in addition
   *  to being appended to ~/.vibe-ads/debug.log via dlogRaw. Lets extension-
   *  scope code observe block lifecycle events (e.g., `block.start`) so we
   *  can detect "patch applied but webview never picked it up" desync
   *  without having to re-parse the debug.log file. Safe to leave unset. */
  onWebviewLog?: (raw: string) => void;
  /** Optional E2E driver surface. When set, the loopback exposes
   *  `GET /test/<name>?…` routes that delegate to this handler. Used by the
   *  kickbacks.test.* hooks so external scripts (curl, CI runners) can fire
   *  impressions / clicks / views and read the result without needing a
   *  running VS Code command host. Token-gated by the same loopback prefix.
   *  Self-gated at the handler level (testHooksEnabled() inside TestHooks),
   *  so removing the sentinel mid-session disables the routes on next call. */
  onTestRoute?: (name: string, params: URLSearchParams) =>
    Promise<{ status: number; body: unknown }>;
}

/** Loopback startup options. When `token` and/or `preferredPort` are
 *  passed, the loopback reuses them — the URL baked into the webview
 *  block stays stable across activations, so a webview that loaded a
 *  prior session's patched index.js can still reach the current
 *  ext-host. Without this, every ext-host restart produced a new token
 *  + port, the running webview's anchors pointed at a torn-down
 *  loopback, and clicks + telemetry vanished silently (the "patched
 *  but webview cached" desync). Both default to per-call random + OS-
 *  assigned, preserving the old behavior for callers that don't opt in. */
export interface LoopbackStartOpts {
  /** Reuse a stable token instead of minting a fresh random one each
   *  call. Caller is responsible for persistence (typically
   *  globalState). When omitted, a per-call random token is used. */
  token?: string;
  /** Try this port first; if `EADDRINUSE`, retry the next N ports
   *  (`preferredPortRange`, default 4) and finally fall back to OS-
   *  assigned (port=0). When omitted, OS-assigned is used directly. */
  preferredPort?: number;
  /** How many sequential ports to try starting at `preferredPort`
   *  before giving up and falling back to OS-assigned. */
  preferredPortRange?: number;
}

export class Loopback {
  private server: Server | null = null;
  private token = "";
  constructor(private h: LoopbackHandlers) {}

  /** True while the underlying HTTP server is bound and accepting
   *  connections. Lets bootLoopback() detect a stale shared server (owner
   *  already stopped) and fall through to a fresh bind. */
  isRunning(): boolean { return !!this.server && this.server.listening; }

  /** The handler set this instance was constructed with. Read by
   *  bootLoopback() to lift a later caller's wiring onto the ONE shared
   *  server (audit #7). */
  handlers(): LoopbackHandlers { return this.h; }

  /** Live handler swap (audit #7): the request closure dispatches through
   *  `this.h` at request time, so replacing it re-routes every route —
   *  /ad, /activity, the metric relays, /click, /log, /test — without
   *  rebinding the port. Used by bootLoopback() so the production webview
   *  wiring can take over ad-serving from the debug stub on the single
   *  shared server instead of EADDRINUSE-ing onto stablePort+1. */
  setHandlers(h: LoopbackHandlers): void { this.h = h; }

  start(opts: LoopbackStartOpts = {}): Promise<{ port: number; token: string }> {
    this.token = opts.token && /^[0-9a-f]{16,}$/i.test(opts.token)
      ? opts.token
      : randomBytes(16).toString("hex");
    const prefix = `/vibe-ads/${this.token}/`;
    this.server = createServer((req, res) => {
      // 2A-M02: bound per-connection lifetime. A misbehaving webview that
      // opens a request and never sends data (or sends headers and stalls)
      // would otherwise park a connection until process exit, leaking fds.
      // Loopback is 127.0.0.1-only and token-gated; values are picked to
      // tolerate slow disks under /activity (LogTail.current readSync).
      try {
        if (typeof req.setTimeout === "function") req.setTimeout(10000);
      } catch { /* never block the request loop on timeout config */ }
      try {
        // CORS: in VS Code 1.120+ the chat webview runs from a
        // `vscode-webview://` origin and Chromium enforces CORS on its fetch
        // to this http loopback. Without ACAO every relay (impressions,
        // clicks, activity, debug log) is browser-blocked → billing telemetry
        // silently dies. `dlog`'s `content-type: application/json` POST is a
        // non-simple request, so the webview fires an OPTIONS preflight first;
        // it must succeed independently of the token path. Loopback is bound
        // to 127.0.0.1 and still token-gated for real routes, so `*` here only
        // widens who may *read the response*, not who can reach the port.
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "content-type");
          res.setHeader("Access-Control-Max-Age", "86400");
          res.statusCode = 204; res.end(); return;
        }
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (!url.pathname.startsWith(prefix)) { res.statusCode = 404; res.end(); return; }
        const route = url.pathname.slice(prefix.length);
        if (route === "activity") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(this.h.getActivity())); return;
        }
        if (route === "ad") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(this.h.getCurrentAd() ?? {})); return;
        }
        if (route === "impression_rendered" || route === "impression_viewable"
            || route === "view_tick" || route === "view_threshold_met"
            || route === "error_impression") {
          // Mirror the loopback.click trace: every impression / view-
          // tick that reaches the extension leaves a log entry BEFORE
          // dedupe + onEvent dispatch, so an operator grepping the
          // debug log can see what the webview actually pinged
          // (separate from what the dedupe layer let through).
          const payload = metricPayload(route, url);
          dlog("ext", "loopback.event",
            { route, surface: payload.surface || "",
              visibleMs: payload.visibleMs, eventUuid: payload.eventUuid },
            { corr: url.searchParams.get("corr") || "" });
          this.h.onEvent(route, payload);
          res.statusCode = 204; res.end(); return;
        }
        if (route === "click") {
          const sRaw = url.searchParams.get("surface") || "";
          const s = parseAdSurface(sRaw);
          // visible_ms is included by the webview block so the extension
          // can apply the click-threshold floor (anti-misclick / anti-bot).
          // Parse defensively: NaN / negative => treat as 0 (unknown).
          const vmsRaw = Number(url.searchParams.get("visible_ms") || "");
          const visibleMs = Number.isFinite(vmsRaw) && vmsRaw >= 0
            ? Math.floor(vmsRaw) : 0;
          const eventUuid = parseEventUuid(url.searchParams.get("event_uuid"));
          // Audit #17: lift the claimed ad (when the block sends it) so the
          // host can bill a click on the OLD ad's anchor — emitted during the
          // 10s /ad poll lag after a rotation — to the OLD campaign.
          const claimedAdId = url.searchParams.get("ad") || undefined;
          dlog("ext", "loopback.click", { ct: url.searchParams.get("ct") || "",
            surface: s || "", visibleMs, eventUuid },
            { corr: url.searchParams.get("corr") || "" });
          this.h.onClick(url.searchParams.get("ct") || "", s, visibleMs,
            eventUuid, claimedAdId);
          res.statusCode = 204;
          res.end(); return;
        }
        if (route === "log") {
          // Webview block relays its lifecycle here (the only channel out of
          // the sandbox). Proves the loopback is reachable when lines appear.
          // 2A-M01: cap BEFORE concatenation, not after. The prior
          // body += c; if (body.length > 16000) req.destroy() let a single
          // chunk push body up to chunk-size + 16000 before destroying.
          let body = "";
          let overflowed = false;
          req.on("data", (c) => {
            if (overflowed) return;
            const cs = String(c);
            if (body.length + cs.length > 16000) {
              overflowed = true;
              req.destroy();
              return;
            }
            body += cs;
          });
          req.on("end", () => {
            if (overflowed) return;
            dlogRaw(body);
            try { this.h.onWebviewLog?.(body); }
            catch { /* observer best-effort; never affects the log relay */ }
          });
          res.statusCode = 204; res.end(); return;
        }
        // E2E test-hook driver routes: GET /test/<name>?…. Only handled when
        // a host wired an onTestRoute (see LoopbackHandlers). The handler is
        // itself responsible for the testHooksEnabled() gate — returns 403
        // with ok:false when off, so a removed sentinel mid-session is
        // observed on the very next call without restarting the server.
        if (route.startsWith("test/") && this.h.onTestRoute) {
          const name = route.slice("test/".length);
          this.h.onTestRoute(name, url.searchParams).then((r) => {
            res.statusCode = r.status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(r.body));
          }).catch((e) => {
            dlog("ext", "loopback.test_route_error",
              { name, msg: e instanceof Error ? e.message : String(e) });
            try { res.statusCode = 500; res.end(); } catch { /* ignore */ }
          });
          return;
        }
        res.statusCode = 404; res.end();
      } catch (e) {
        dlog("ext", "loopback.handler_error",
          { msg: e instanceof Error ? e.message : String(e) });
        try { res.statusCode = 500; res.end(); } catch { /* ignore */ }
      }
    });
    // Build the candidate port list: preferredPort (if any) + N-1
    // sequential fallbacks, then 0 (OS-assigned) as the final fallback.
    // Each EADDRINUSE moves to the next candidate; any other listen
    // error resolves with port=-1 (same fail-safe shape as before).
    const candidates: number[] = [];
    if (typeof opts.preferredPort === "number" && opts.preferredPort > 0) {
      const range = Math.max(1, opts.preferredPortRange ?? 4);
      for (let i = 0; i < range; i++)
        candidates.push(opts.preferredPort + i);
    }
    candidates.push(0);

    return new Promise((resolveP) => {
      const tryNext = (i: number): void => {
        if (!this.server) return resolveP({ port: -1, token: this.token });
        const port = candidates[i];
        const onErr = (e: NodeJS.ErrnoException): void => {
          // EADDRINUSE on a preferred port → try the next candidate.
          // Any other error → give up (same fail-safe shape as the
          // pre-refactor handler).
          if (e && (e.code === "EADDRINUSE" || e.code === "EACCES")
              && i + 1 < candidates.length) {
            try { this.server!.removeListener("error", onErr); }
            catch { /* ignore */ }
            // The server is already closed by the failed listen; we can
            // re-issue listen() on the same server instance.
            tryNext(i + 1);
          } else {
            resolveP({ port: -1, token: this.token });
          }
        };
        this.server!.once("error", onErr);
        this.server!.listen(port, "127.0.0.1", () => {
          try { this.server!.removeListener("error", onErr); }
          catch { /* ignore */ }
          const addr = this.server!.address();
          const bound = typeof addr === "object" && addr ? addr.port : -1;
          resolveP({ port: bound, token: this.token });
        });
      };
      tryNext(0);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolveP) => {
      if (!this.server) return resolveP();
      this.server.close(() => resolveP());
      this.server = null;
    });
  }
}

const EVENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseEventUuid(raw: string | null): string | undefined {
  return raw && EVENT_UUID_RE.test(raw) ? raw : undefined;
}

function metricPayload(route: string, url: URL): LoopbackMetricPayload {
  const surfaceRaw = url.searchParams.get("surface") || "";
  const surface = parseAdSurface(surfaceRaw);
  const visible = Number(url.searchParams.get("visible_ms") || "");
  const visibleMs = Number.isFinite(visible) && visible >= 0
    ? Math.floor(visible)
    : undefined;
  const sessionNonce = url.searchParams.get("session") || undefined;
  const eventUuid = parseEventUuid(url.searchParams.get("event_uuid"));
  const claimedAdId = url.searchParams.get("ad") || undefined;
  const payload: LoopbackMetricPayload = {};
  if (surface) payload.surface = surface;
  if (typeof visibleMs === "number") payload.visibleMs = visibleMs;
  if (sessionNonce) payload.sessionNonce = sessionNonce;
  if (eventUuid) payload.eventUuid = eventUuid;
  if (claimedAdId) payload.claimedAdId = claimedAdId;
  if (route === "view_threshold_met" || route === "error_impression") {
    // error_impression is the 5 s safety-net cap from block.asset.js
    // (MAX_SESSION_MS). It represents a session that DID stay visible —
    // the bill should reflect a fully-viewable impression, same shape
    // as view_threshold_met.
    payload.viewable = true;
    payload.viewPct = 100;
    if (typeof visibleMs === "number") payload.viewMs = visibleMs;
  }
  return payload;
}
