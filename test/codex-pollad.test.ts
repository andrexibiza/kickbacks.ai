import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

// Regression coverage for the codex "frozen ads" fix (2026-06-11): the baked
// __VIBE_ADS_AD__ was frozen for the life of the webview — rotation re-patched
// the bundle on disk but a running Codex panel never re-read it, so users sat
// on one creative (or the pre-inventory "Your ad here" placeholder) until a
// full VS Code reload. The block now polls the loopback /ad every 10s with
// the SAME semantics as claude-code/block.asset.js pollAd:
//   • changed payload → adopt + RESET all view sessions/impression flags
//     (old creative's accumulated time never bills against the new one)
//   • successful-but-empty ×2 (debounced) → no-serve: drop overlay, end
//     every session, suppress repaint until served again
//   • fetch error → keep last ad (transient network / CSP-blocked loopback)
// Plus: the click ping now carries the `ad=` attribution claim (CC parity).

const ASSET = readFileSync(
  join(__dirname, "..", "src", "adapters", "codex", "block.asset.js"), "utf8");

const AD_A = "Acme deploys faster than your CI";
const URL_A = "https://acme.example/lp";
const AD_B = "Bolt ships 2x faster";
const URL_B = "https://bolt.example/lp";
const PAYLOAD_B = { adText: AD_B, clickUrl: URL_B, iconUrl: "",
  adId: "adB", campaignId: "c2" };

function preparedAsset(): string {
  const subs: Record<string, string> = {
    __VIBE_ADS_AD__: JSON.stringify(AD_A),
    __VIBE_ADS_PORT__: "5555",
    __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"),
    __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
    __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ck"),
    __VIBE_ADS_CLICKURL__: JSON.stringify(URL_A),
    __VIBE_ADS_CORR__: JSON.stringify("test.codex.poll"),
    __VIBE_ADS_DEBUG__: "false",
    // Large threshold so only the 5s view_tick cadence drives billing
    // assertions (threshold_met never fires inside these windows).
    __VIBE_ADS_VIEW_THRESHOLD_MS__: "15000",
    __VIBE_ADS_ARG__: "e",
    __VIBE_ADS_JSX__: "d",
  };
  let src = ASSET;
  for (const [k, v] of Object.entries(subs)) src = src.split(k).join(v);
  return src;
}

interface Harness {
  dom: JSDOM;
  doc: Document;
  pings: string[];
  advance: (ms: number) => void;
  /** Drive the block's 10s /ad poll once, deterministically. */
  pollAd: () => Promise<void>;
  setAd: (p: Record<string, unknown> | null) => void;
  setAdError: (on: boolean) => void;
}

function makeHarness(): Harness {
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => { /* anchor-click navigation noise */ });
  const dom = new JSDOM(`<body><div id="mc" class="chatpanel"></div></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true,
      virtualConsole: vc });
  const win = dom.window as unknown as Window & typeof globalThis & {
    eval: (s: string) => unknown; fetch: typeof fetch;
    setInterval: typeof setInterval;
  };
  const pings: string[] = [];
  let adPayload: Record<string, unknown> | null =
    { adText: AD_A, clickUrl: URL_A, iconUrl: "", adId: "adA", campaignId: "c1" };
  let adError = false;
  win.fetch = ((url: string) => {
    const u = String(url);
    if (u.endsWith("/ad")) {
      if (adError) return Promise.reject(new Error("net down"));
      return Promise.resolve({ json: async () => (adPayload ?? {}) });
    }
    pings.push(u);
    return Promise.resolve({ json: async () => ({}) });
  }) as unknown as typeof fetch;
  // Capture interval registrations BEFORE boot so the unique 10s pollAd
  // can be driven directly (cc-pollad.test.ts pattern). Real timers keep
  // running underneath (250ms viewTick, 80ms paint loop), same as prod.
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const origSetInterval = win.setInterval.bind(win);
  (win as unknown as { setInterval: unknown }).setInterval =
    ((fn: () => void, ms: number) => {
      intervals.push({ fn, ms });
      return origSetInterval(fn, ms);
    }) as unknown as typeof setInterval;
  let t = 1_700_000_000_000;
  (win as unknown as { Date: DateConstructor }).Date.now = () => t;
  win.eval(preparedAsset());
  const pollFn = intervals.find((i) => i.ms === 10_000)?.fn;
  if (!pollFn) throw new Error("pollAd interval (10s) not registered");
  return {
    dom, doc: dom.window.document, pings,
    advance: (ms: number) => { t += ms; },
    pollAd: async () => {
      pollFn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    setAd: (p) => { adPayload = p; },
    setAdError: (on) => { adError = on; },
  };
}

function setRect(el: HTMLElement,
  r: { x: number; y: number; w: number; h: number }): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect })
    .getBoundingClientRect = () => ({
      x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + r.w,
      bottom: r.y + r.h, width: r.w, height: r.h, toJSON() { return {}; },
    } as DOMRect);
}

function liveShimmer(doc: Document): HTMLElement {
  const el = doc.createElement("span");
  el.className = "loading-shimmer-pure-text _cadencedShimmer_1bpr9_1 "
    + "text-size-chat leading-[1.5] select-none truncate";
  const a = doc.createElement("span"); a.textContent = "Thinking";
  const b = doc.createElement("span"); b.textContent = "Thinking";
  el.appendChild(a); el.appendChild(b);
  setRect(el, { x: 100, y: 200, w: 240, h: 20 });
  return el;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const count = (pings: string[], re: RegExp) =>
  pings.filter((u) => re.test(u)).length;
const TICK = /\/view_tick\?/;
const RENDERED = /\/impression_rendered\?/;
const ERROR = /\/error_impression\?/;
const overlayOf = (doc: Document) =>
  doc.querySelector('[data-vibe-ads="codex"]');
const anchorOf = (doc: Document) =>
  doc.querySelector('[data-vibe-ads="codex"] a[data-vibe-ads-ad]') as
    HTMLAnchorElement | null;

describe("codex pollAd — live rotation adoption (frozen-ads fix)", () => {
  it("adopts a rotated ad in place: text + href swap, the old session is "
    + "ENDED (no carry-over billing), fresh impression events fire, and the "
    + "next tick attributes to the NEW ad at visible_ms=5000", async () => {
    const h = makeHarness();
    h.doc.getElementById("mc")!.appendChild(liveShimmer(h.doc));
    await sleep(300);                       // active paint → overlay + ad A
    expect(anchorOf(h.doc)).toBeTruthy();
    expect(anchorOf(h.doc)!.textContent).toContain(AD_A);
    expect(anchorOf(h.doc)!.getAttribute("href")).toBe(URL_A);
    expect(count(h.pings, RENDERED)).toBe(1);

    h.advance(5_100);                       // accrue one billable tick on A
    await sleep(400);
    const ticksA = h.pings.filter((u) => TICK.test(u));
    expect(ticksA.length).toBe(1);
    expect(ticksA[0]).toContain("ad=" + encodeURIComponent(AD_A));

    // Host rotates to B (or replaces the patch-time placeholder).
    h.setAd(PAYLOAD_B);
    await h.pollAd();
    await sleep(300);                       // next 80ms paint repaints
    expect(anchorOf(h.doc)!.textContent).toContain(AD_B);
    expect(anchorOf(h.doc)!.textContent).not.toContain(AD_A);
    expect(anchorOf(h.doc)!.getAttribute("href")).toBe(URL_B);
    // Fresh impression for the new creative.
    expect(count(h.pings, RENDERED)).toBe(2);

    // The old ad's 5.1s of accumulated view-time must NOT carry over: the
    // next tick is the NEW ad's FIRST (visible_ms=5000), not a continuation.
    h.advance(5_100);
    await sleep(400);
    const ticks = h.pings.filter((u) => TICK.test(u));
    expect(ticks.length).toBe(2);
    expect(ticks[1]).toContain("ad=" + encodeURIComponent(AD_B));
    expect(ticks[1]).toContain("visible_ms=5000");
    expect(count(h.pings, ERROR)).toBe(0);
    h.dom.window.close();
  }, 15000);

  it("a click after rotation carries the ad= attribution claim for the "
    + "creative actually on screen", async () => {
    const h = makeHarness();
    h.doc.getElementById("mc")!.appendChild(liveShimmer(h.doc));
    await sleep(300);
    h.setAd(PAYLOAD_B);
    await h.pollAd();
    await sleep(300);
    const a = anchorOf(h.doc)!;
    expect(a.textContent).toContain(AD_B);
    a.dispatchEvent(new h.dom.window.MouseEvent("click", { bubbles: true }));
    const clicks = h.pings.filter((u) => /\/click\?/.test(u));
    expect(clicks.length).toBe(1);
    expect(clicks[0]).toContain("&ad=" + encodeURIComponent(AD_B));
    h.dom.window.close();
  }, 15000);
});

describe("codex pollAd — empty payload is the no-serve signal", () => {
  it("TWO consecutive empty polls drop the overlay, END every session, and "
    + "suppress repaint even with a live shimmer; a served payload re-arms",
    async () => {
    const h = makeHarness();
    h.doc.getElementById("mc")!.appendChild(liveShimmer(h.doc));
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();
    h.advance(5_100);
    await sleep(400);
    expect(count(h.pings, TICK)).toBe(1);

    h.setAd(null);                          // host gate: /ad returns {}
    await h.pollAd();
    // Debounce: ONE empty read never tears down (could race a rotation).
    expect(overlayOf(h.doc)).toBeTruthy();
    await h.pollAd();                       // second consecutive empty
    await sleep(200);
    expect(overlayOf(h.doc)).toBeNull();

    // Sessions ended + paint suppressed: the shimmer is still live, yet no
    // repaint, no ticks, no error_impressions.
    h.advance(20_000);
    await sleep(400);
    expect(overlayOf(h.doc)).toBeNull();
    expect(count(h.pings, TICK)).toBe(1);
    expect(count(h.pings, ERROR)).toBe(0);

    // Host serves again → re-arm on the next active paint.
    h.setAd(PAYLOAD_B);
    await h.pollAd();
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();
    expect(anchorOf(h.doc)!.textContent).toContain(AD_B);
    h.dom.window.close();
  }, 15000);

  it("ONE empty poll followed by a served payload does NOT drop (debounce "
    + "counter resets)", async () => {
    const h = makeHarness();
    h.doc.getElementById("mc")!.appendChild(liveShimmer(h.doc));
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();

    h.setAd(null);
    await h.pollAd();                       // empty #1
    expect(overlayOf(h.doc)).toBeTruthy();
    h.setAd({ adText: AD_A, clickUrl: URL_A, iconUrl: "",
      adId: "adA", campaignId: "c1" });
    await h.pollAd();                       // served → counter resets
    h.setAd(null);
    await h.pollAd();                       // empty #1 again (not #2)
    await sleep(200);
    expect(overlayOf(h.doc)).toBeTruthy();
    h.dom.window.close();
  }, 15000);

  it("fetch ERRORS never drop: the last ad stays painted and keeps billing "
    + "(transient network / CSP-blocked loopback = today's status quo)",
    async () => {
    const h = makeHarness();
    h.doc.getElementById("mc")!.appendChild(liveShimmer(h.doc));
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();

    h.setAdError(true);
    await h.pollAd();
    await h.pollAd();
    await h.pollAd();                       // 3 consecutive FAILURES
    expect(overlayOf(h.doc)).toBeTruthy();  // keep-last-ad preserved
    h.advance(5_100);
    await sleep(400);
    expect(count(h.pings, TICK)).toBe(1);   // session alive
    h.dom.window.close();
  }, 15000);
});
