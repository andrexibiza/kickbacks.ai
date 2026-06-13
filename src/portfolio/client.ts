import { dlog } from "../log";
import { timeoutFetch } from "../util/http";

export interface PatchAd {
  adId: string; campaignId: string; adText: string;
  iconRef: string; iconUrl: string; clickUrl: string; bannerEnabled: boolean;
  sessionToken: string;
  /** True when this ad came from the signed-out DEMO portfolio. Demo ads
   *  render on every surface exactly like a real ad and their click opens the
   *  real advertiser URL, but their metrics route to /v1/metrics/demo (the
   *  advertiser is charged, no user is credited). Absent/false ⇒ a normal,
   *  user-crediting ad. */
  demo?: boolean;
}

export interface PortfolioBalances {
  lifetimeUsd: string;
  todayUsd: string;
  lastUpdatedMs: number;
}

export interface PortfolioResponse {
  ad: PatchAd | null;
  ads: PatchAd[];
  queueId: string;
  ttlMs: number;
  rotationIntervalMs: number;
  viewThresholdMs: number;
  balances: PortfolioBalances | null;
}

type Fetch = typeof fetch;

/** The slice of FleetSignals the wire clients feed (fleet-chattiness fix):
 *  raw piggybacked fields off a FRESH 2xx body. Implementations parse
 *  defensively and must never throw back into the fetch path. */
export interface FleetSignalSink {
  noteKill(raw: unknown): void;
  noteBalances(raw: unknown): void;
}

const DEFAULT_VIEW_THRESHOLD_MS = 3_000;

function safeHttpUrl(value: string): string {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") ? u.toString() : "";
  } catch {
    return "";
  }
}

/** Consumes S2's /v1/portfolio shape. W4-extended fields are optional so an
 *  older backend still works: queue_id, view_threshold_seconds, balances. */
export class PortfolioClient {
  private cache: { resp: PortfolioResponse; expiresAt: number } | null = null;
  private demoCache: { resp: PortfolioResponse; expiresAt: number } | null = null;
  constructor(private base: string, private token: () => string | null,
              private f: Fetch = timeoutFetch(15000),
              private signals: FleetSignalSink | null = null) {}

  async fetchAd(ccVersion: string): Promise<PatchAd | null> {
    const r = await this.fetchPortfolio(ccVersion);
    return r?.ad ?? null;
  }

  /** W4 queue-aware fetch. Returns the full response so callers can manage
   *  a local queue (drain to depth N, then refetch) and surface the server-
   *  authoritative balances + view threshold. `campaignId` (the active ad's
   *  campaign, optional) scopes the piggybacked kill verdict so campaign
   *  kills propagate exactly like the standalone /v1/killswitch poll. */
  async fetchPortfolio(ccVersion: string,
                       campaignId = ""): Promise<PortfolioResponse | null> {
    const url = `${this.base}/v1/portfolio?claude_code_version=${encodeURIComponent(ccVersion)}`
      + (campaignId ? `&campaign=${encodeURIComponent(campaignId)}` : "");
    return this._fetch(url, this.authHeaders(), false, () => this.cache,
      (c) => { this.cache = c; });
  }

  /** Signed-out PREVIEW fetch: hits the public /v1/portfolio/demo with NO auth
   *  header. Returns real engine ads (each stamped `demo: true`) whose session
   *  tokens are bound to the demo:<clientId> namespace — so the surfaces render
   *  exactly like the live product but metrics route to /v1/metrics/demo
   *  (advertiser charged, no user credit). `clientId` is the stable device id
   *  (auth.clientId()); without it the server returns an empty portfolio. */
  async fetchDemoPortfolio(ccVersion: string, clientId: string,
                           campaignId = ""): Promise<PortfolioResponse | null> {
    const url = `${this.base}/v1/portfolio/demo`
      + `?claude_code_version=${encodeURIComponent(ccVersion)}`
      + `&client_id=${encodeURIComponent(clientId)}`
      + (campaignId ? `&campaign=${encodeURIComponent(campaignId)}` : "");
    return this._fetch(url, {}, true, () => this.demoCache,
      (c) => { this.demoCache = c; });
  }

  private async _fetch(
    url: string, headers: Record<string, string>, demo: boolean,
    getCache: () => { resp: PortfolioResponse; expiresAt: number } | null,
    setCache: (c: { resp: PortfolioResponse; expiresAt: number }) => void,
  ): Promise<PortfolioResponse | null> {
    try {
      const r = await this.f(url, { headers });
      if (!r.ok) throw new Error(`portfolio ${r.status}`);
      const body = await r.json() as {
        ttl_seconds: number;
        view_threshold_seconds?: number;
        rotation_interval_seconds?: number;
        queue_id?: string;
        balances?: { lifetime_usd?: string; today_usd?: string;
                     last_updated_ms?: number };
        ads: { ad_id: string; campaign_id: string; title_text: string;
               icon_ref: string; icon_url?: string; click_url: string;
               banner_enabled?: boolean; session_token?: string }[];
      };
      // Fleet signals fire HERE — the fresh-2xx parse path — and nowhere
      // else. Critically NOT from the warm-cache fallback below (stale data
      // must never refresh a kill verdict's timestamp) and BEFORE any
      // caller-side early-return on empty inventory (a global kill empties
      // the ad list — exactly the moment the verdict matters most).
      this.signals?.noteKill((body as { kill?: unknown }).kill);
      if (!demo) this.signals?.noteBalances(
        (body as { balances?: unknown }).balances);
      const ads: PatchAd[] = (body.ads || []).map((a) => ({
        adId: a.ad_id, campaignId: a.campaign_id,
        adText: a.title_text,
        iconRef: a.icon_ref, iconUrl: a.icon_url || "", clickUrl: safeHttpUrl(a.click_url),
        bannerEnabled: a.banner_enabled === true,
        sessionToken: a.session_token || "",
        ...(demo ? { demo: true } : {}),
      }));
      const balances: PortfolioBalances | null = body.balances
        && typeof body.balances.lifetime_usd === "string"
        && typeof body.balances.today_usd === "string"
        ? { lifetimeUsd: body.balances.lifetime_usd,
            todayUsd: body.balances.today_usd,
            lastUpdatedMs: body.balances.last_updated_ms ?? Date.now() }
        : null;
      // Clamp server-supplied timing knobs (audit 2A-06). These drive
      // setInterval periods and, via applyPatch, full rewrites of CC's 4.9 MB
      // webview index.js. An out-of-range value (a bug or a hostile backend
      // sending rotation_interval_seconds: 0.001) would otherwise become a
      // per-millisecond disk-write loop on the host. viewThresholdMs is already
      // floored downstream; rotation + ttl were not.
      const ROTATION_FLOOR_MS = 15_000;          // never rewrite CC's file faster
      const TTL_CEIL_MS = 60 * 60_000;           // 1h cap on cache lifetime
      const rotationSec = body.rotation_interval_seconds;
      const rawRotationMs = rotationSec ? rotationSec * 1000 : 120_000;
      const rawTtlMs = (body.ttl_seconds || 0) * 1000;
      const resp: PortfolioResponse = {
        ad: ads[0] ?? null,
        ads,
        queueId: body.queue_id || "",
        ttlMs: Math.min(TTL_CEIL_MS, Math.max(0, rawTtlMs)),
        rotationIntervalMs: Math.max(ROTATION_FLOOR_MS, rawRotationMs),
        viewThresholdMs: (body.view_threshold_seconds
          ? body.view_threshold_seconds * 1000
          : DEFAULT_VIEW_THRESHOLD_MS),
        balances,
      };
      setCache({ resp, expiresAt: Date.now() + resp.ttlMs });
      return resp;
    } catch {
      const c = getCache();
      if (c && Date.now() < c.expiresAt) return c.resp;
      return null;
    }
  }

  private authHeaders(): Record<string, string> {
    const t = this.token();
    return t ? { authorization: `Bearer ${t}` } : {};
  }
}

/** The slice of AuthClient that demo-fallback resolution needs. */
export interface DemoFallbackAuth {
  accessToken(): string | null;
  clientId(): string;
  refresh(): Promise<boolean>;
}

/** Resolve the activation-time portfolio, falling back to the DEMO portfolio
 *  when the user is effectively signed out — INCLUDING the "token present but
 *  rejected" case. loadCached() trusts a cached access token without validating
 *  it, so a stale/expired token makes accessToken() truthy and the first real
 *  fetch 401s → no ad → dead surface (the user sees the sign-in prompt, never
 *  the demo preview). Here, when signed-in yields no ad we force one refresh:
 *  it either re-mints a valid token (→ real, user-crediting ads), clears the
 *  dead token on an explicit rejection (accessToken() → null → demo, so all the
 *  downstream token-based routing — metrics → /v1/metrics/demo, rotation → demo
 *  — lines up consistently), or fails TRANSIENTLY (offline/5xx: token kept,
 *  null returned, NO demo demotion — audit #10). A genuinely signed-out caller
 *  (no token) goes straight to demo and never triggers the refresh. Never
 *  throws beyond its callees. */
export async function fetchPortfolioWithDemoFallback(
  portfolio: PortfolioClient,
  auth: DemoFallbackAuth,
  ccVersion: string,
  campaignId = "",
): Promise<PortfolioResponse | null> {
  if (!auth.accessToken()) {
    return portfolio.fetchDemoPortfolio(ccVersion, auth.clientId(), campaignId);
  }
  // Signed in (token present). A NON-NULL response — including a valid-but-empty
  // portfolio (ads: []) — is authoritative; keep it. Empty inventory is normal
  // and must NOT trigger a refresh: a failed refresh can clear the token, so
  // doing it on every empty poll would needlessly sign a valid user out. Only a
  // HARD null (network failure / non-2xx like 401, with no warm cache) is
  // suspect — the cached access token may be dead (loadCached trusts it
  // unvalidated). Then force one refresh: re-mint (→ real ads) or clear
  // (→ accessToken() null → demo), which keeps every downstream token-based
  // surface aligned.
  const resp = await portfolio.fetchPortfolio(ccVersion, campaignId);
  if (resp) return resp;
  const refreshed = await auth.refresh();
  if (refreshed) {
    dlog("ext", "portfolio.demo_fallback", { reason: "token-revived" });
    return portfolio.fetchPortfolio(ccVersion, campaignId);
  }
  // Failed refresh: TRANSIENT vs FATAL (audit #10). refresh() keeps the
  // access token on transport failures (offline / timeout / 5xx) and clears
  // it only on an explicit server rejection. A still-present token means the
  // session may be perfectly valid (e.g. VS Code restored before Wi-Fi) —
  // do NOT demote to demo (demo metrics credit no user); serve nothing this
  // tick and let the caller's next refresh retry naturally. A cleared token
  // is authoritative: route to demo, aligned with every downstream surface.
  if (auth.accessToken()) {
    dlog("ext", "portfolio.demo_fallback", { reason: "transient-refresh" });
    return null;
  }
  dlog("ext", "portfolio.demo_fallback", { reason: "dead-token" });
  return portfolio.fetchDemoPortfolio(ccVersion, auth.clientId(), campaignId);
}
