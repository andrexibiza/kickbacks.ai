import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { MetricsClient, newMetricEventUuid, type AdSurface,
  type MetricEvent } from "./metrics/client";
import { PortfolioClient, type PatchAd } from "./portfolio/client";
import { EarningsClient } from "./earnings/client";
import { dlog, testHooksEnabled } from "./log";
import { errMsg } from "./util/errMsg";

/** Live context the test hooks read at fire-time. The activate path captures
 *  these as closures over its locals so a hook always reflects the latest
 *  ad / loopback / kill state without having to thread mutable refs. */
export interface TestHooksContext {
  ad: PatchAd | null;
  signedIn: boolean;
  killed: boolean;
  ccVersion: string;
  viewThresholdMs: number;
  loopback: { port: number; base: string } | null;
}

export interface FireArgs {
  /** Override surface; defaults to "overlay". */
  surface?: AdSurface;
  /** Override visibleMs on view-family events. */
  visibleMs?: number;
  /** Override ad id when no live ad is loaded. campaignId is paired. */
  adId?: string;
  campaignId?: string;
  /** Override session token when firing with adId/campaignId override. */
  sessionToken?: string;
  /** Optional explicit correlation id; otherwise the hook mints one. */
  corr?: string;
  /** Click only: optional click token to relay (defaults to "test"). */
  ct?: string;
}

export interface FireResult {
  ok: boolean;
  reason?: string;
  /** What the hook actually sent to the backend (post-resolution). */
  sent?: {
    event: MetricEvent;
    eventUuid: string;
    adId: string;
    campaignId: string;
    surface: AdSurface;
    corr: string;
    visibleMs?: number;
  };
}

export interface StateSnapshot {
  enabled: boolean;
  signedIn: boolean;
  killed: boolean;
  ccVersion: string;
  viewThresholdMs: number;
  ad: PatchAd | null;
  loopback: { port: number; base: string } | null;
  lastEvents: FireResult["sent"][];
}

const LOG_RING_CAP = 64;

/** E2E driver for ledger / billing / telemetry. Exposes
 *  `kickbacks.test.*` VS Code commands that fire impression / view / click
 *  events through the SAME MetricsClient the loopback uses, so an end-to-end
 *  test exercises the real backend path. Production-default OFF (sentinel
 *  + env gate, see testHooksEnabled()). Hooks always honor the gate so an
 *  enable-then-disable mid-session can't keep forging events. */
export class TestHooks {
  private readonly ring: FireResult["sent"][] = [];

  constructor(
    private readonly metrics: MetricsClient,
    private readonly portfolio: PortfolioClient,
    private readonly earnings: EarningsClient,
    private readonly getContext: () => TestHooksContext,
    private readonly onBillableEvent: (() => void) | null = null,
  ) {}

  private scheduleRefreshFor(event: MetricEvent): void {
    if (event !== "view_threshold_met" && event !== "click"
        && event !== "impression_viewable" && event !== "error_impression") {
      return;
    }
    try { this.onBillableEvent?.(); } catch { /* test hooks must not disrupt */ }
  }

  private resolveAd(args: FireArgs): { adId: string; campaignId: string; sessionToken: string } | null {
    if (args.adId && args.campaignId) {
      return { adId: args.adId, campaignId: args.campaignId, sessionToken: args.sessionToken || "" };
    }
    const ad = this.getContext().ad;
    if (ad) return { adId: ad.adId, campaignId: ad.campaignId, sessionToken: ad.sessionToken };
    return null;
  }

  private mintCorr(adId: string, args: FireArgs): string {
    if (args.corr) return args.corr;
    return `${adId}.test.${randomBytes(3).toString("hex")}`;
  }

  private async fireMetric(
    event: MetricEvent,
    args: FireArgs,
    payload: { visibleMs?: number; viewable?: boolean; viewPct?: number;
               viewMs?: number } = {},
  ): Promise<FireResult> {
    if (!testHooksEnabled()) {
      return { ok: false, reason: "test hooks disabled" };
    }
    const resolved = this.resolveAd(args);
    if (!resolved) {
      return { ok: false, reason: "no ad loaded and no adId/campaignId override" };
    }
    const surface: AdSurface = args.surface || "overlay";
    const corr = this.mintCorr(resolved.adId, args);
    const eventUuid = newMetricEventUuid();
    const ctx = this.getContext();
    const visibleMs = typeof args.visibleMs === "number"
      ? args.visibleMs : payload.visibleMs;
    try {
      await this.metrics.send(event, {
        adId: resolved.adId,
        campaignId: resolved.campaignId,
        ccVersion: ctx.ccVersion,
        corr,
        eventUuid,
        surface,
        sessionToken: resolved.sessionToken,
        ...(typeof visibleMs === "number" ? { visibleMs } : {}),
        ...(typeof payload.viewable === "boolean"
          ? { viewable: payload.viewable } : {}),
        ...(typeof payload.viewPct === "number"
          ? { viewPct: payload.viewPct } : {}),
        ...(typeof payload.viewMs === "number" ? { viewMs: payload.viewMs } : {}),
      });
    } catch (e) {
      const reason = errMsg(e, 200);
      dlog("ext", "testhook.send.err", { event, reason });
      return { ok: false, reason };
    }
    const sent = {
      event,
      eventUuid,
      adId: resolved.adId,
      campaignId: resolved.campaignId,
      surface,
      corr,
      ...(typeof visibleMs === "number" ? { visibleMs } : {}),
    };
    this.recordSent(sent);
    dlog("ext", "testhook.fire", { event, eventUuid,
      adId: resolved.adId, surface, corr });
    this.scheduleRefreshFor(event);
    return { ok: true, sent };
  }

  fireImpressionRendered(args: FireArgs = {}): Promise<FireResult> {
    return this.fireMetric("impression_rendered", args);
  }

  fireImpressionViewable(args: FireArgs = {}): Promise<FireResult> {
    return this.fireMetric("impression_viewable", args, {
      viewable: true, viewPct: 100,
    });
  }

  fireViewTick(args: FireArgs = {}): Promise<FireResult> {
    return this.fireMetric("view_tick", args);
  }

  fireViewThresholdMet(args: FireArgs = {}): Promise<FireResult> {
    const ctx = this.getContext();
    const visibleMs = typeof args.visibleMs === "number"
      ? args.visibleMs : ctx.viewThresholdMs;
    return this.fireMetric("view_threshold_met",
      { ...args, visibleMs },
      { viewable: true, viewPct: 100, viewMs: visibleMs });
  }

  /** Fire the MAX_SESSION_MS safety-net event. Lets e2e harnesses drive
   *  the 5 s stuck-session path without waiting on real wall-clock. */
  fireErrorImpression(args: FireArgs = {}): Promise<FireResult> {
    const visibleMs = typeof args.visibleMs === "number"
      ? args.visibleMs : 5000;
    return this.fireMetric("error_impression",
      { ...args, visibleMs },
      { viewable: true, viewPct: 100, viewMs: visibleMs });
  }

  async fireClick(args: FireArgs = {}): Promise<FireResult> {
    if (!testHooksEnabled()) {
      return { ok: false, reason: "test hooks disabled" };
    }
    const resolved = this.resolveAd(args);
    if (!resolved) {
      return { ok: false, reason: "no ad loaded and no adId/campaignId override" };
    }
    const surface: AdSurface = args.surface || "overlay";
    const corr = this.mintCorr(resolved.adId, args);
    const eventUuid = newMetricEventUuid();
    const ctx = this.getContext();
    try {
      await this.metrics.send("click", {
        adId: resolved.adId,
        campaignId: resolved.campaignId,
        ccVersion: ctx.ccVersion,
        corr,
        eventUuid,
        surface,
        sessionToken: resolved.sessionToken,
      });
    } catch (e) {
      const reason = errMsg(e, 200);
      dlog("ext", "testhook.click.err", { reason });
      return { ok: false, reason };
    }
    const sent = {
      event: "click" as MetricEvent,
      eventUuid,
      adId: resolved.adId,
      campaignId: resolved.campaignId,
      surface,
      corr,
    };
    this.recordSent(sent);
    dlog("ext", "testhook.click", { ct: args.ct || "test", eventUuid,
      adId: resolved.adId, surface, corr });
    this.scheduleRefreshFor("click");
    return { ok: true, sent };
  }

  async refreshPortfolio(): Promise<PatchAd | null> {
    if (!testHooksEnabled()) return null;
    const ctx = this.getContext();
    const r = await this.portfolio.fetchPortfolio(ctx.ccVersion);
    return r?.ad ?? null;
  }

  async refreshEarnings(): Promise<{ lifetimeUsd: string;
                                      todayUsd: string } | null> {
    if (!testHooksEnabled()) return null;
    return this.earnings.fetch();
  }

  getState(): StateSnapshot {
    const ctx = this.getContext();
    return {
      enabled: testHooksEnabled(),
      signedIn: ctx.signedIn,
      killed: ctx.killed,
      ccVersion: ctx.ccVersion,
      viewThresholdMs: ctx.viewThresholdMs,
      ad: ctx.ad,
      loopback: ctx.loopback,
      lastEvents: [...this.ring],
    };
  }

  clearEventLog(): void { this.ring.length = 0; }

  /** Dispatch a loopback /test/<name> route to the corresponding method.
   *  Parses query-string args into FireArgs (visibleMs is numeric; everything
   *  else is a string). Self-gated by testHooksEnabled() so a sentinel
   *  removal mid-session disables the routes on the very next call (403). */
  async handleTestRoute(name: string, params: URLSearchParams):
    Promise<{ status: number; body: unknown }> {
    if (!testHooksEnabled()) {
      return { status: 403,
        body: { ok: false, reason: "test hooks disabled" } };
    }
    const args: FireArgs = {};
    const surface = params.get("surface");
    if (surface) args.surface = surface as AdSurface;
    const vm = params.get("visibleMs");
    if (vm !== null) {
      const n = Number(vm);
      if (Number.isFinite(n)) args.visibleMs = n;
    }
    const adId = params.get("adId");
    if (adId) args.adId = adId;
    const campaignId = params.get("campaignId");
    if (campaignId) args.campaignId = campaignId;
    const corr = params.get("corr");
    if (corr) args.corr = corr;
    const ct = params.get("ct");
    if (ct) args.ct = ct;
    try {
      switch (name) {
        case "fireImpressionRendered":
          return { status: 200, body: await this.fireImpressionRendered(args) };
        case "fireImpressionViewable":
          return { status: 200, body: await this.fireImpressionViewable(args) };
        case "fireViewTick":
          return { status: 200, body: await this.fireViewTick(args) };
        case "fireViewThresholdMet":
          return { status: 200, body: await this.fireViewThresholdMet(args) };
        case "fireErrorImpression":
          return { status: 200, body: await this.fireErrorImpression(args) };
        case "fireClick":
          return { status: 200, body: await this.fireClick(args) };
        case "refreshPortfolio":
          return { status: 200, body: await this.refreshPortfolio() };
        case "refreshEarnings":
          return { status: 200, body: await this.refreshEarnings() };
        case "getState":
          return { status: 200, body: this.getState() };
        case "clearEventLog":
          this.clearEventLog();
          return { status: 200, body: { ok: true } };
        default:
          return { status: 404,
            body: { ok: false, reason: `unknown route "${name}"` } };
      }
    } catch (e) {
      const reason = errMsg(e, 200);
      dlog("ext", "testhook.route.err", { name, reason });
      return { status: 500, body: { ok: false, reason } };
    }
  }

  private recordSent(sent: NonNullable<FireResult["sent"]>): void {
    this.ring.push(sent);
    while (this.ring.length > LOG_RING_CAP) this.ring.shift();
  }

  /** Wire VS Code commands. Only call when testHooksEnabled() is true; the
   *  gate is also re-checked inside each fire method so a sentinel removal
   *  mid-session disables the hooks immediately (next fire returns ok:false).
   *  Commands accept an optional first arg `FireArgs` object so callers can
   *  do `executeCommand("kickbacks.test.fireClick", { surface: "banner" })`. */
  registerCommands(ctx: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (a?: FireArgs) => unknown) =>
      ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg("kickbacks.test.fireImpressionRendered",
      (a) => this.fireImpressionRendered(a || {}));
    reg("kickbacks.test.fireImpressionViewable",
      (a) => this.fireImpressionViewable(a || {}));
    reg("kickbacks.test.fireViewTick", (a) => this.fireViewTick(a || {}));
    reg("kickbacks.test.fireViewThresholdMet",
      (a) => this.fireViewThresholdMet(a || {}));
    reg("kickbacks.test.fireErrorImpression",
      (a) => this.fireErrorImpression(a || {}));
    reg("kickbacks.test.fireClick", (a) => this.fireClick(a || {}));
    reg("kickbacks.test.refreshPortfolio", () => this.refreshPortfolio());
    reg("kickbacks.test.refreshEarnings", () => this.refreshEarnings());
    reg("kickbacks.test.getState", () => this.getState());
    reg("kickbacks.test.clearEventLog", () => this.clearEventLog());
    dlog("ext", "testhook.registered", {});
  }
}
