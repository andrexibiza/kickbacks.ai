import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { Loopback } from "../src/loopback";

// Click-through telemetry is the revenue-bearing signal in the Kickbacks
// auction. The CC block tries sendBeacon FIRST (Electron lifecycle-safe
// during the host's external-navigation tear-down), then falls back to
// fetch+keepalive. Until tonight only the impression beacon path had
// coverage; the click path's sendBeacon-vs-fetch dual-fallback and the
// surface-routing (overlay vs banner) walk-up were untested. A silent drop
// in either codepath would burn live click revenue without any signal —
// the worst-class regression for a billing pipeline.
//
// These tests load the CC block.asset.js in JSDOM, mock navigator.sendBeacon
// + fetch on the JSDOM window, dispatch synthetic click events, and assert
// the EXACT loopback URL the ping plumbing emits.

const ASSET = readFileSync(
  join(__dirname, "..", "src", "adapters", "claude-code", "block.asset.js"),
  "utf8");

const SUBS: Record<string, string> = {
  __VIBE_ADS_TIER__: "3",
  __VIBE_ADS_AD__: JSON.stringify("Ramp - Save time & money"),
  __VIBE_ADS_ICON__: JSON.stringify("icon.r"),
  __VIBE_ADS_PORT__: "5555",
  __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"),
  __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ctok-abc123"),
  __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
  __VIBE_ADS_DEBUG__: "false",
  __VIBE_ADS_CLICKURL__: JSON.stringify("https://ramp.example/lp?utm=ck"),
  __VIBE_ADS_BANNER_ON__: "true",
  __VIBE_ADS_CORR__: JSON.stringify("corr.xyz789"),
  __VIBE_ADS_VIEW_THRESHOLD_MS__: "15000",
  __VIBE_ADS_ICON_URL__: JSON.stringify(""),
};

function preparedAsset(): string {
  let src = ASSET;
  for (const [k, v] of Object.entries(SUBS)) src = src.split(k).join(v);
  return src;
}

type BeaconCall = { url: string; data: Blob | string | null };
type FetchCall = { url: string; init: RequestInit | undefined };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeHarness(opts: { beacon: boolean | "reject" } = { beacon: true }) {
  // Anchor click triggers a real-href navigation attempt jsdom can't carry
  // out; without filtering this floods stderr with "Not implemented:
  // navigation" warnings on every test. We only care about beacon/fetch
  // outcomes here, so swallow that one warning class.
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e: Error) => {
    if (!/navigation/i.test(String(e?.message || ""))) throw e;
  });
  const dom = new JSDOM(`<body></body>`,
    { runScripts: "outside-only", virtualConsole: vc });
  const win = dom.window as unknown as Window & typeof globalThis & {
    eval: (s: string) => unknown;
    navigator: Navigator & { sendBeacon?: unknown };
    fetch: typeof fetch;
  };
  const beacons: BeaconCall[] = [];
  const fetches: FetchCall[] = [];
  // sendBeacon: configurable (present + true, present + returns false, or
  // absent). The block's ping() falls through to fetch on either of the
  // latter two — the cases we MUST not silently drop.
  if (opts.beacon !== false) {
    (win.navigator as unknown as { sendBeacon: (u: string, d?: Blob | string) => boolean })
      .sendBeacon = (u: string, d?: Blob | string): boolean => {
        beacons.push({ url: u, data: d ?? null });
        return opts.beacon === true;
      };
  } else {
    try { delete (win.navigator as unknown as { sendBeacon?: unknown }).sendBeacon; }
    catch { /* jsdom navigator getter; the absence is what matters */ }
    (win.navigator as unknown as { sendBeacon: undefined }).sendBeacon = undefined;
  }
  win.fetch = ((url: string, init?: RequestInit) => {
    fetches.push({ url: String(url), init });
    return Promise.resolve(new (win as unknown as { Response: typeof Response })
      .Response("", { status: 204 }));
  }) as typeof fetch;
  return { dom, win, beacons, fetches };
}

function bootBlock(dom: JSDOM): void {
  // Strip the module.exports early-return branch so the IIFE runs the
  // DOM-attached path (event listeners + render loop). jsdom defines no
  // `module` global in the browser ctx, so the existing gate already
  // skips the early-return there — but be explicit for forward safety.
  (dom.window as unknown as { eval: (s: string) => unknown })
    .eval(preparedAsset());
}

function makeAd(doc: Document, opts: { surface?: "overlay" | "banner" } = {}):
  HTMLAnchorElement {
  const wrap = doc.createElement("div");
  if (opts.surface === "banner") wrap.setAttribute("data-vibe-ads-banner", "1");
  else if (opts.surface === "overlay") wrap.setAttribute("data-vibe-ads-overlay", "1");
  const a = doc.createElement("a");
  a.setAttribute("data-vibe-ads-ad", "1");
  a.setAttribute("href", "https://ramp.example/lp?utm=ck");
  a.textContent = "Ramp - Save time & money";
  wrap.appendChild(a);
  doc.body.appendChild(wrap);
  return a;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("CC click-through telemetry — sendBeacon-first, fetch fallback",
  () => {
  beforeEach(() => { vi.useRealTimers(); });

  it("sendBeacon path: clicks emit a single beacon to the loopback /click "
    + "endpoint with ct, corr, surface=overlay", async () => {
    const h = makeHarness({ beacon: true });
    bootBlock(h.dom);
    const a = makeAd(h.dom.window.document, { surface: "overlay" });
    a.click();
    await flushMicrotasks();
    expect(h.beacons).toHaveLength(1);
    expect(h.fetches).toHaveLength(0);     // fallback NOT used
    const u = new URL(h.beacons[0].url);
    expect(u.pathname).toBe("/vibe-ads/lt/click");
    expect(u.searchParams.get("ct")).toBe("ctok-abc123");
    expect(u.searchParams.get("corr")).toBe("corr.xyz789");
    expect(u.searchParams.get("surface")).toBe("overlay");
    expect(u.searchParams.get("event_uuid")).toMatch(UUID_RE);
  });

  it("sendBeacon UNAVAILABLE: falls back to fetch+keepalive POST with the "
    + "SAME url shape (silent-drop guard)", async () => {
    const h = makeHarness({ beacon: false });
    bootBlock(h.dom);
    makeAd(h.dom.window.document, { surface: "overlay" }).click();
    await flushMicrotasks();
    expect(h.beacons).toHaveLength(0);
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0].init?.method).toBe("POST");
    expect((h.fetches[0].init as unknown as { keepalive: boolean }).keepalive)
      .toBe(true);
    const u = new URL(h.fetches[0].url);
    expect(u.pathname).toBe("/vibe-ads/lt/click");
    expect(u.searchParams.get("ct")).toBe("ctok-abc123");
    expect(u.searchParams.get("surface")).toBe("overlay");
    expect(u.searchParams.get("event_uuid")).toMatch(UUID_RE);
  });

  it("sendBeacon REJECTS (returns false): falls back to fetch — the "
    + "Electron quirk where beacon present but the browser refuses the "
    + "specific request", async () => {
    const h = makeHarness({ beacon: "reject" });
    bootBlock(h.dom);
    makeAd(h.dom.window.document, { surface: "overlay" }).click();
    await flushMicrotasks();
    expect(h.beacons).toHaveLength(1);     // attempted
    expect(h.fetches).toHaveLength(1);     // and fell through
    expect(new URL(h.fetches[0].url).pathname).toBe("/vibe-ads/lt/click");
  });

  it("surface=banner when the click target is INSIDE a data-vibe-ads-banner "
    + "wrapper (ledger attribution must distinguish spinner vs banner)",
    async () => {
    const h = makeHarness({ beacon: true });
    bootBlock(h.dom);
    makeAd(h.dom.window.document, { surface: "banner" }).click();
    await flushMicrotasks();
    expect(h.beacons).toHaveLength(1);
    expect(new URL(h.beacons[0].url).searchParams.get("surface"))
      .toBe("banner");
  });

  it("surface defaults to overlay when no wrapper found (defensive)",
    async () => {
    const h = makeHarness({ beacon: true });
    bootBlock(h.dom);
    // Ad anchor with no banner/overlay wrapper at all.
    const a = h.dom.window.document.createElement("a");
    a.setAttribute("data-vibe-ads-ad", "1");
    a.setAttribute("href", "https://x.example");
    h.dom.window.document.body.appendChild(a);
    a.click();
    await flushMicrotasks();
    expect(new URL(h.beacons[0].url).searchParams.get("surface"))
      .toBe("overlay");
  });

  it("clicks on a NON-ad element emit zero pings (no listener leak)",
    async () => {
    const h = makeHarness({ beacon: true });
    bootBlock(h.dom);
    const div = h.dom.window.document.createElement("div");
    div.textContent = "unrelated chrome";
    h.dom.window.document.body.appendChild(div);
    div.click();
    await flushMicrotasks();
    expect(h.beacons).toHaveLength(0);
    expect(h.fetches).toHaveLength(0);
  });

  it("does NOT preventDefault — the anchor's real href must reach the host "
    + "for the external-open (CSP-exempt navigation is the actual click-out)",
    async () => {
    const h = makeHarness({ beacon: true });
    bootBlock(h.dom);
    const a = makeAd(h.dom.window.document, { surface: "overlay" });
    let defaultPrevented = false;
    a.addEventListener("click", (ev) => {
      defaultPrevented = ev.defaultPrevented;
    }, false);
    a.click();
    await flushMicrotasks();
    expect(defaultPrevented).toBe(false);
  });

  it("click ping carries the ad= attribution CLAIM (wave-4 fix 4): the same "
    + "param the view-event pings send — the pollAd-adopted identifier the "
    + "block keys its _vt sessions on (the ad TEXT) — and a REAL loopback "
    + "lifts it into onClick's claimedAdId", async () => {
    const h = makeHarness({ beacon: true });
    bootBlock(h.dom);
    makeAd(h.dom.window.document, { surface: "overlay" }).click();
    await flushMicrotasks();
    expect(h.beacons).toHaveLength(1);
    const u = new URL(h.beacons[0].url);
    // Without this claim the host's recent-ads registry (audit #17) cannot
    // resolve a click landing in the ≤10s /ad poll-lag window after a
    // rotation — it would bill the freshly-rotated campaign instead.
    expect(u.searchParams.get("ad")).toBe("Ramp - Save time & money");

    // End-to-end: replay the EXACT query the block emitted against a live
    // loopback server and assert the host parses the same param name into
    // onClick's claimedAdId (loopback.ts click route → `ad=` →
    // webviewInjection.resolveAttribution upstream).
    const clicks: Array<{ ct: string; claimedAdId?: string }> = [];
    const lb = new Loopback({
      onEvent: () => { /* not under test */ },
      onClick: (ct, _surface, _visibleMs, _eventUuid, claimedAdId) => {
        clicks.push({ ct, claimedAdId });
      },
      getActivity: () => ({}),
      getCurrentAd: () => null,
    });
    try {
      const { port, token } = await lb.start();
      expect(port).toBeGreaterThan(0);
      const res = await fetch(
        `http://127.0.0.1:${port}/vibe-ads/${token}/click${u.search}`,
        { method: "POST" });
      expect(res.status).toBe(204);
    } finally {
      await lb.stop();
    }
    expect(clicks).toHaveLength(1);
    expect(clicks[0].ct).toBe("ctok-abc123");
    expect(clicks[0].claimedAdId).toBe("Ramp - Save time & money");
  });

  it("clicks on a CHILD element of the ad anchor still attribute correctly "
    + "(the favicon SVG, animated dots span — every child must walk up to "
    + "the [data-vibe-ads-ad] ancestor)", async () => {
    const h = makeHarness({ beacon: true });
    bootBlock(h.dom);
    const a = makeAd(h.dom.window.document, { surface: "overlay" });
    // Simulate the favicon SVG or dots-span child the real ad renders.
    const dot = h.dom.window.document.createElement("span");
    dot.setAttribute("data-va-dots", "1");
    dot.textContent = " ..";
    a.appendChild(dot);
    dot.dispatchEvent(new h.dom.window.MouseEvent("click",
      { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(h.beacons).toHaveLength(1);
    expect(new URL(h.beacons[0].url).searchParams.get("ct"))
      .toBe("ctok-abc123");
  });
});
