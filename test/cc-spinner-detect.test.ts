import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

// Regression coverage for audit 2026-06-09 finding #28: findSpinner returned
// the FIRST non-empty `.spinnerRow_` element in document order. CC can leave
// a STALE prior row frozen mid-glyph at turn end (the asset's own GRACE_MS
// comment documents this) while keeping the node mounted — so in turn N+1
// the live animating row mounts BELOW the stale one, the stale row shadows
// it, the global freshness signature never changes, and the ad is suppressed
// for the entire turn. The fix prefers the LAST non-empty row among the rows
// the EXISTING selector already matches (the transcript appends, so the live
// row is the latest). PRIME DIRECTIVE: the selector and the observation
// scope must NOT grow — these tests also pin the single-row / zero-row /
// emptied-row behaviors unchanged.
//
// Harness: same shape as cc-viewtimer.test.ts — the block runs in JSDOM on
// its real 80ms/250ms intervals, the realm's Date.now is test-controlled, so
// freshness (GRACE_MS) advances only when the test says so.

const ASSET = readFileSync(
  join(__dirname, "..", "src", "adapters", "claude-code", "block.asset.js"),
  "utf8");

function preparedAsset(): string {
  const subs: Record<string, string> = {
    __VIBE_ADS_TIER__: "3",
    __VIBE_ADS_AD__: JSON.stringify("Acme deploys faster than your CI"),
    __VIBE_ADS_ICON__: JSON.stringify("icon.a"),
    __VIBE_ADS_PORT__: "5555",
    __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"),
    __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ck"),
    __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
    __VIBE_ADS_DEBUG__: "false",
    __VIBE_ADS_ICON_URL__: JSON.stringify(""),
    __VIBE_ADS_CLICKURL__: JSON.stringify("https://acme.example/lp"),
    __VIBE_ADS_BANNER_ON__: "false",
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
}

function makeHarness(): Harness {
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => { /* irrelevant here */ });
  const dom = new JSDOM(`<body></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true,
      virtualConsole: vc });
  const win = dom.window as unknown as Window & typeof globalThis & {
    eval: (s: string) => unknown; fetch: typeof fetch;
  };
  const pings: string[] = [];
  win.fetch = ((url: string) => {
    const u = String(url);
    // /ad must keep serving a REAL payload: the no-serve teardown (wave-4
    // fix 3) must never engage in these detection-only tests.
    if (u.endsWith("/ad")) {
      return Promise.resolve({ json: async () => ({
        adText: "Acme deploys faster than your CI",
        clickUrl: "https://acme.example/lp", iconUrl: "",
        adId: "adA", campaignId: "c1" }) });
    }
    if (u.endsWith("/activity")) {
      return Promise.resolve({ json: async () => ({}) });
    }
    pings.push(u);
    return Promise.resolve({ json: async () => ({}) });
  }) as unknown as typeof fetch;
  let t = 1_700_000_000_000;
  (win as unknown as { Date: DateConstructor }).Date.now = () => t;
  win.eval(preparedAsset());
  return { dom, doc: dom.window.document, pings,
    advance: (ms: number) => { t += ms; } };
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const overlayOf = (doc: Document) =>
  doc.querySelector('[data-vibe-ads-overlay="1"]');
const count = (pings: string[], re: RegExp) =>
  pings.filter((u) => re.test(u)).length;
const OVERLAY_TICK = /\/view_tick\?surface=overlay&/;

describe("CC spinner detection — last non-empty row wins (audit #28)", () => {
  it("a stale frozen row ABOVE must not shadow the live row BELOW: the "
    + "live (latest) row is chosen, the ad mounts and bills the turn",
    async () => {
    const h = makeHarness();
    // Turn N's leftover: a non-empty row frozen mid-glyph (✻ never changes),
    // still mounted at the TOP of the transcript.
    const stale = h.doc.createElement("div");
    stale.className = "spinnerRow_ab12c";
    stale.textContent = "✻ Baking… (12s)";
    h.doc.body.appendChild(stale);
    await sleep(300);
    // The frozen row alone looks fresh on first sighting, then goes stale
    // past GRACE_MS → idle → dock → no composer in jsdom → drop.
    h.advance(2_000);
    await sleep(400);
    expect(overlayOf(h.doc)).toBeNull();

    // Turn N+1: the LIVE row mounts BELOW the stale one and animates
    // (initial glyph ✢ ≠ the frozen ✻).
    const live = addSpinner(h.doc);
    await sleep(400);
    // OLD behavior: findSpinner returned the FIRST non-empty row (the
    // frozen one), its signature never changed, paint() never ran — the ad
    // stayed suppressed for the whole turn. NEW: the LAST non-empty row is
    // the live one; the overlay mounts.
    expect(overlayOf(h.doc)).toBeTruthy();
    // …and the turn bills normally (the live row's session is counting).
    h.advance(5_100); live.spin();
    await sleep(500);
    expect(count(h.pings, OVERLAY_TICK)).toBe(1);
    h.dom.window.close();
  }, 20000);

  it("single-row case unchanged: one live row shows the ad; frozen past "
    + "GRACE it goes idle (dock-miss → drop in jsdom)", async () => {
    const h = makeHarness();
    addSpinner(h.doc);
    await sleep(300);
    expect(overlayOf(h.doc)).toBeTruthy();
    h.advance(2_000);                      // glyph never rotated → stale
    await sleep(400);
    expect(overlayOf(h.doc)).toBeNull();
    h.dom.window.close();
  }, 20000);

  it("zero-row and emptied-row cases unchanged: no spinnerRow (or only "
    + "CC's emptied `<div></div>` turn-end row) never paints", async () => {
    const h = makeHarness();
    await sleep(300);
    expect(overlayOf(h.doc)).toBeNull();
    // CC's turn-end state: the row stays mounted but emptied — NOT a
    // candidate (whitespace-only is "no spinner").
    const emptied = h.doc.createElement("div");
    emptied.className = "spinnerRow_ab12c";
    emptied.textContent = "";
    h.doc.body.appendChild(emptied);
    await sleep(300);
    expect(overlayOf(h.doc)).toBeNull();
    expect(count(h.pings, /impression_rendered/)).toBe(0);
    h.dom.window.close();
  }, 20000);
});
