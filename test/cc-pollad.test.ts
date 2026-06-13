import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

// Regression coverage for the wave-4 pollAd fixes:
//
// Audit #27 — the DOCKED idle overlay never repainted: paint() only runs in
// the active branch, so a host-side rotation while docked left a STALE
// creative on screen (clicks unbilled at the host's 15s floor, or
// misattributed). pollAd now retargets the docked line's EXISTING stable
// child nodes in place — the ad-text TEXT NODE's nodeValue and the anchor's
// href ONLY. The anchor is NEVER re-created (rewriting innerHTML of a live
// clickable element detaches it mid-click — a shipped bug, fixed once), the
// docked state stays NON-billing (persist-at-idle), and the next thaw's
// viewShow attributes to the NEW ad.
//
// Wave-2 carry-over — the EMPTY /ad payload (the host's serving-gate signal
// on kill/disable) was a no-op, leaving the last creative painted until
// idle/reload. pollAd now distinguishes payload shapes: a fetch ERROR keeps
// keep-last-ad (transient network); TWO consecutive successful-but-empty
// responses (debounce) drop the overlay/banner via the existing drop paths
// and END every view session. A served payload re-arms.
//
// Harness: cc-viewtimer-style JSDOM + test-controlled Date.now, plus a
// setInterval capture so the 10s pollAd can be driven deterministically, and
// a rect-stubbed <textarea> composer so the idle DOCK path (not the
// dock-miss drop) engages.

const ASSET = readFileSync(
  join(__dirname, "..", "src", "adapters", "claude-code", "block.asset.js"),
  "utf8");

const AD_A = "Acme deploys faster than your CI";
const URL_A = "https://acme.example/lp";
const AD_B = "Bolt ships 2x faster";
const URL_B = "https://bolt.example/lp";
const PAYLOAD_A = { adText: AD_A, clickUrl: URL_A, iconUrl: "",
  adId: "adA", campaignId: "c1" };
const PAYLOAD_B = { adText: AD_B, clickUrl: URL_B, iconUrl: "",
  adId: "adB", campaignId: "c2" };

function preparedAsset(opts: { bannerOn: boolean }): string {
  const subs: Record<string, string> = {
    __VIBE_ADS_TIER__: "3",
    __VIBE_ADS_AD__: JSON.stringify(AD_A),
    __VIBE_ADS_ICON__: JSON.stringify("icon.a"),
    __VIBE_ADS_PORT__: "5555",
    __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"),
    __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ck"),
    __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
    __VIBE_ADS_DEBUG__: "false",
    __VIBE_ADS_ICON_URL__: JSON.stringify(""),
    __VIBE_ADS_CLICKURL__: JSON.stringify(URL_A),
    __VIBE_ADS_BANNER_ON__: opts.bannerOn ? "true" : "false",
    __VIBE_ADS_CORR__: JSON.stringify("adA.abcd"),
    __VIBE_ADS_VIEW_THRESHOLD_MS__: "15000",
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

function makeHarness(opts: { bannerOn: boolean }): Harness {
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => { /* irrelevant here */ });
  const dom = new JSDOM(`<body></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true,
      virtualConsole: vc });
  const win = dom.window as unknown as Window & typeof globalThis & {
    eval: (s: string) => unknown; fetch: typeof fetch;
    setInterval: typeof setInterval;
  };
  const pings: string[] = [];
  let adPayload: Record<string, unknown> | null = PAYLOAD_A;
  let adError = false;
  win.fetch = ((url: string) => {
    const u = String(url);
    if (u.endsWith("/ad")) {
      if (adError) return Promise.reject(new Error("net down"));
      return Promise.resolve({ json: async () => (adPayload ?? {}) });
    }
    if (u.endsWith("/activity")) {
      return Promise.resolve({ json: async () => ({}) });
    }
    pings.push(u);
    return Promise.resolve({ json: async () => ({}) });
  }) as unknown as typeof fetch;
  // Capture interval callbacks BEFORE boot so the test can invoke pollAd
  // (the unique 10_000ms interval) directly instead of waiting 10 real
  // seconds. The real timers keep running underneath, same as production.
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const origSetInterval = win.setInterval.bind(win);
  (win as unknown as { setInterval: unknown }).setInterval =
    ((fn: () => void, ms: number) => {
      intervals.push({ fn, ms });
      return origSetInterval(fn, ms);
    }) as unknown as typeof setInterval;
  let t = 1_700_000_000_000;
  (win as unknown as { Date: DateConstructor }).Date.now = () => t;
  win.eval(preparedAsset(opts));
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

const GLYPHS = ["✢", "✶", "✻", "✽"];
function addSpinner(doc: Document): { el: HTMLElement; spin: () => void } {
  const el = doc.createElement("div");
  el.className = "spinnerRow_ab12c";
  let g = 0;
  el.textContent = GLYPHS[0] + " Reticulating…";
  doc.body.appendChild(el);
  return { el, spin: () => {
    g = (g + 1) % GLYPHS.length;
    el.textContent = GLYPHS[g] + " Reticulating…";
  } };
}

// A composer the idle DOCK can park above. jsdom rects are all-zero, which
// findComposer treats as "not visible" (→ dock-miss drop, the path
// cc-viewtimer.test.ts exercises); stub a real rect so docking succeeds.
function addComposer(doc: Document): HTMLElement {
  const el = doc.createElement("textarea");
  (el as unknown as { getBoundingClientRect: () => unknown })
    .getBoundingClientRect = () => ({
      width: 400, height: 60, top: 500, left: 10, right: 410, bottom: 560,
      x: 10, y: 500, toJSON: () => ({}) });
  doc.body.appendChild(el);
  return el;
}

function addBanner(doc: Document): HTMLElement {
  const el = doc.createElement("div");
  el.textContent =
    "You've used 71% of your weekly limit · resets in 4d · View usage";
  doc.body.appendChild(el);
  return el;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const count = (pings: string[], re: RegExp) =>
  pings.filter((u) => re.test(u)).length;
const OVERLAY_TICK = /\/view_tick\?surface=overlay&/;
const BANNER_TICK = /\/view_tick\?surface=banner&/;
const ERROR = /\/error_impression\?/;
const overlayOf = (doc: Document) =>
  doc.querySelector('[data-vibe-ads-overlay="1"]');
const anchorOf = (doc: Document) =>
  doc.querySelector('[data-vibe-ads-overlay="1"] a[data-vibe-ads-ad]') as
    HTMLAnchorElement | null;

describe("CC pollAd — docked-rotation repaint (audit #27)", () => {
  it("a rotation adopted while DOCKED retargets the SAME anchor in place "
    + "(text node + href only), stays non-billing, and the thaw attributes "
    + "to the NEW ad", async () => {
    const h = makeHarness({ bannerOn: false });
    addComposer(h.doc);
    const sp = addSpinner(h.doc);
    await sleep(300);                       // active paint → overlay + ad A
    const a1 = anchorOf(h.doc);
    expect(a1).toBeTruthy();
    expect(a1!.textContent).toContain(AD_A);
    expect(a1!.getAttribute("href")).toBe(URL_A);
    h.advance(5_100); sp.spin();            // accrue one billable tick
    await sleep(500);
    expect(count(h.pings, OVERLAY_TICK)).toBe(1);

    // Turn ends; glyph freezes → idle → DOCK (composer present, no drop).
    h.advance(2_000);
    await sleep(400);
    expect(overlayOf(h.doc)).toBeTruthy(); // persists at idle (docked)

    // Host rotates to ad B while docked; the webview's poll adopts it.
    h.setAd(PAYLOAD_B);
    await h.pollAd();
    const a2 = anchorOf(h.doc);
    // OLD behavior: the docked line still showed ad A's text + href.
    expect(a2).toBe(a1);                    // anchor NEVER re-created
    expect(a2!.textContent).toContain(AD_B);
    expect(a2!.textContent).not.toContain(AD_A);
    expect(a2!.getAttribute("href")).toBe(URL_B);
    // Stable children survive the retarget (no innerHTML rewrite).
    expect(a2!.querySelector("[data-va-dots]")).toBeTruthy();

    // Docked stays NON-billing after the swap (persist-at-idle): the old
    // session ended, no live session started for B.
    h.advance(20_000);
    await sleep(400);
    expect(count(h.pings, OVERLAY_TICK)).toBe(1);
    expect(count(h.pings, ERROR)).toBe(0);

    // Next turn thaws → the NEW ad's session opens fresh and bills as B.
    sp.spin();
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();
    h.advance(5_100); sp.spin();
    await sleep(500);
    const ticks = h.pings.filter((u) => OVERLAY_TICK.test(u));
    expect(ticks.length).toBe(2);
    expect(ticks[1]).toContain("&ad=" + encodeURIComponent(AD_B));
    expect(ticks[1]).toContain("&visible_ms=5000");
    h.dom.window.close();
  }, 20000);
});

describe("CC pollAd — empty payload is the no-serve signal (wave-2 "
  + "carry-over)", () => {
  it("TWO consecutive empty polls drop the overlay and END every session — "
    + "nothing repaints even with a live spinner; a served payload re-arms",
    async () => {
    const h = makeHarness({ bannerOn: false });
    const sp = addSpinner(h.doc);
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();
    h.advance(5_100); sp.spin();
    await sleep(500);
    expect(count(h.pings, OVERLAY_TICK)).toBe(1);

    h.setAd(null);                          // host gate: /ad returns {}
    await h.pollAd();
    // Debounce: ONE empty read never tears down (could race a rotation).
    expect(overlayOf(h.doc)).toBeTruthy();
    await h.pollAd();                       // second consecutive empty
    await sleep(300);
    // OLD behavior: the empty payload was a no-op — the last creative
    // stayed painted (and at idle would persist) until reload.
    expect(overlayOf(h.doc)).toBeNull();

    // Sessions are ENDED and the evaluator stays down even though the
    // spinner row is still live: no ticks, no error_impressions, no repaint.
    h.advance(20_000); sp.spin();
    await sleep(500);
    expect(overlayOf(h.doc)).toBeNull();
    expect(count(h.pings, OVERLAY_TICK)).toBe(1);
    expect(count(h.pings, ERROR)).toBe(0);

    // Host serves again → re-arm: the overlay re-mounts on the next active
    // paint with the new creative.
    h.setAd(PAYLOAD_B);
    await h.pollAd();
    sp.spin();
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();
    expect(anchorOf(h.doc)!.textContent).toContain(AD_B);
    h.dom.window.close();
  }, 20000);

  it("ONE empty poll followed by a real ad does NOT drop (single-race "
    + "debounce; the counter resets on any served payload)", async () => {
    const h = makeHarness({ bannerOn: false });
    const sp = addSpinner(h.doc);
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();

    h.setAd(null);
    await h.pollAd();                       // empty #1
    expect(overlayOf(h.doc)).toBeTruthy();
    h.setAd(PAYLOAD_A);
    await h.pollAd();                       // served → counter resets
    h.setAd(null);
    await h.pollAd();                       // empty #1 again (not #2)
    await sleep(200);
    expect(overlayOf(h.doc)).toBeTruthy();
    sp.spin();                              // still serving normally
    await sleep(200);
    expect(overlayOf(h.doc)).toBeTruthy();
    h.dom.window.close();
  }, 20000);

  it("fetch ERRORS never drop: transient network keeps the last ad and its "
    + "session keeps billing", async () => {
    const h = makeHarness({ bannerOn: false });
    const sp = addSpinner(h.doc);
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();

    h.setAdError(true);
    await h.pollAd();
    await h.pollAd();
    await h.pollAd();                       // 3 consecutive FAILURES
    expect(overlayOf(h.doc)).toBeTruthy(); // keep-last-ad preserved
    h.advance(5_100); sp.spin();
    await sleep(500);
    expect(count(h.pings, OVERLAY_TICK)).toBe(1);  // session alive
    h.dom.window.close();
  }, 20000);

  it("the BANNER surface is hidden and its session ENDED by no-serve at "
    + "idle, and repaints when the host serves again", async () => {
    const h = makeHarness({ bannerOn: true });
    addBanner(h.doc);
    await sleep(1_300);                     // banner loop is 1s
    const bEl = h.doc.querySelector(
      '[data-vibe-ads-banner="1"]') as HTMLElement;
    expect(bEl).toBeTruthy();
    h.advance(5_100);
    await sleep(500);
    expect(count(h.pings, BANNER_TICK)).toBe(1);  // visible-at-idle billing

    h.setAd(null);
    await h.pollAd();
    await h.pollAd();
    await sleep(1_200);                     // ≥1 banner loop tick
    // OLD behavior: the banner kept the stale creative visible and ticking.
    expect(bEl.style.display).toBe("none");
    h.advance(10_000);
    await sleep(600);
    expect(count(h.pings, BANNER_TICK)).toBe(1);

    // Host resumes (same creative): banner un-hides, repaints, and a FRESH
    // session starts at 0.
    h.setAd(PAYLOAD_A);
    await h.pollAd();
    await sleep(1_300);
    expect(bEl.style.display).not.toBe("none");
    h.advance(5_100);
    await sleep(500);
    const ticks = h.pings.filter((u) => BANNER_TICK.test(u));
    expect(ticks.length).toBe(2);
    expect(/[?&]visible_ms=5000(&|$)/.test(ticks[1])).toBe(true);
    h.dom.window.close();
  }, 20000);
});
