import type * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { Loopback } from "../loopback";
import { resolveLoopbackBase } from "../loopback";

const STABLE_TOKEN_KEY = "kickbacks.loopback.token";
const STABLE_PORT_KEY = "kickbacks.loopback.port";

export interface LoopbackBootResult { port: number; token: string; base: string; }

export interface LoopbackBootOpts {
  /** A SECONDARY registrant (the DebugController's stub wiring) shares the
   *  server but never displaces a primary's handlers. The production webview
   *  wiring (the default — primary) always takes the routes over, even from
   *  an earlier-booted debug stub. */
  secondary?: boolean;
}

/** ONE loopback server per extension host (audit #7). Pre-fix every normal
 *  boot ran TWO: the boot-canary debug apply() bound the persisted stable
 *  port P first and held it all session, so the production loopback
 *  EADDRINUSE'd onto P+1 and OVERWROTE the "stable" port — the port crept
 *  +1 per session, and a stale webview from the prior session (whose patch
 *  baked port P) reconnected to the DEBUG server, whose wiring dropped
 *  signed-out demo billing and blinded the desync watchdog. Now the first
 *  successful boot owns the single server; every later caller SHARES it
 *  via a live handler swap instead of binding a second port. */
let shared: {
  owner: Loopback; result: LoopbackBootResult; primary: boolean;
} | null = null;
// In-flight first-bind latch: two CONCURRENT first callers (an unawaited
// debug apply racing the serving-retry loop, audit #5) could both observe
// shared=null and mint two servers — the exact two-server state audit #7
// removes. The later caller awaits the in-flight bind, then re-checks the
// shared fast path.
let starting: Promise<LoopbackBootResult> | null = null;

/** Test-only: forget the in-process shared server (simulates an ext-host
 *  restart, where module state is rebuilt from scratch). */
export function resetSharedLoopbackForTest(): void {
  shared = null;
  starting = null;
}

/** Shared-server fast path (audit #7). `typeof` guards keep this safe when
 *  a test mocks ../loopback with a reduced Loopback surface — those fall
 *  through to the fresh-boot path (the pre-fix behavior). */
function tryShared(
  lb: Loopback, secondary: boolean,
): LoopbackBootResult | null {
  if (shared && shared.result.port > 0
      && typeof shared.owner.isRunning === "function"
      && shared.owner.isRunning()) {
    if (lb === shared.owner) return shared.result;
    if (typeof shared.owner.setHandlers === "function"
        && typeof lb.handlers === "function") {
      // Primary (production) wiring always takes the routes over — its /ad,
      // metric and click handlers are the billing authority (and stay
      // canServeAds-gated, wave 2). A secondary (debug stub) only installs
      // its handlers while no primary has registered, so a later debug
      // re-apply can never clobber live production wiring.
      if (!secondary) {
        shared.owner.setHandlers(lb.handlers());
        shared.primary = true;
      } else if (!shared.primary) {
        shared.owner.setHandlers(lb.handlers());
      }
      return shared.result;
    }
  }
  return null;
}

export async function bootLoopback(
  lb: Loopback, ctx: vscode.ExtensionContext, opts: LoopbackBootOpts = {},
): Promise<LoopbackBootResult> {
  const secondary = opts.secondary === true;
  for (;;) {
    const hit = tryShared(lb, secondary);
    if (hit) return hit;
    if (!starting) break;
    try { await starting; } catch { /* failed bind — re-check, then bind */ }
    if (!shared) break;  // in-flight bind produced no server: bind ourselves
  }
  const bind = (async (): Promise<LoopbackBootResult> => {
    let stableToken = ctx.globalState.get<string>(STABLE_TOKEN_KEY) || "";
    if (!/^[0-9a-f]{16,}$/i.test(stableToken)) {
      stableToken = randomBytes(16).toString("hex");
      void ctx.globalState.update(STABLE_TOKEN_KEY, stableToken);
    }
    const stablePort = Number(ctx.globalState.get<number>(STABLE_PORT_KEY) || 0) || undefined;
    const { port, token } = await lb.start({ token: stableToken, preferredPort: stablePort, preferredPortRange: 4 });
    if (port > 0 && port !== stablePort) void ctx.globalState.update(STABLE_PORT_KEY, port);
    const base = port < 0 ? "" : await resolveLoopbackBase(port, token);
    const result: LoopbackBootResult = { port, token, base };
    if (port > 0) shared = { owner: lb, result, primary: !secondary };
    return result;
  })();
  starting = bind;
  try {
    return await bind;
  } finally {
    if (starting === bind) starting = null;
  }
}
