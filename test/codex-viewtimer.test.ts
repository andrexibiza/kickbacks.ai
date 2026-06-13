import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// Regression coverage for the codex view-timer phantom-billing loop (the
// "why am I failing recently" report: a backgrounded Codex panel spammed
// codex.view.error_impression every ~5s for 31 minutes on one stuck ad).
//
// Three fixes in extension/src/adapters/codex/block.asset.js:
//   #1 viewEnd() on idle drop  — the session no longer ticks off-screen.
//   #2 MAX_SESSION_MS = THRESHOLD_MS — view_threshold_met becomes the
//      billing path; error_impression no longer fires before it.
//   #3 pause while document.hidden — a hidden panel accrues no view-time.

const ASSET = readFileSync(
  join(__dirname, "..", "src", "adapters", "codex", "block.asset.js"), "utf8");

// Small threshold so the tests run in ~1s instead of 15s. With cap===threshold
// (fix #2) MAX_SESSION_MS tracks this too. TICK_MS is hardcoded 5000 in the
// asset, so no view_tick fires inside these short windows — keeps assertions
// about threshold_met vs error_impression unambiguous.
function preparedAsset(thresholdMs: number): string {
  const subs: Record<string, string> = {
    __VIBE_ADS_AD__: JSON.stringify("turbopuffer: like RAG, but way better"),
    __VIBE_ADS_PORT__: "5555",
    __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"),
    __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
    __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ct"),
    __VIBE_ADS_CLICKURL__: JSON.stringify("https://turbopuffer.example/lp"),
    __VIBE_ADS_CORR__: JSON.stringify("test.codex.vt"),
    __VIBE_ADS_DEBUG__: "false",
    __VIBE_ADS_VIEW_THRESHOLD_MS__: String(thresholdMs),
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
  setHidden: (h: boolean) => void;
}

function makeDom(hidden = false): Harness {
  const dom = new JSDOM(`<body><div id="mc" class="chatpanel"></div></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  const pings: string[] = [];
  // Codex ping() is fetch-only (no sendBeacon). Record every loopback URL.
  (dom.window as unknown as { fetch: typeof fetch }).fetch = ((u: string) => {
    pings.push(String(u));
    return Promise.resolve({ json: async () => ({}) });
  }) as unknown as typeof fetch;
  let _hidden = hidden;
  Object.defineProperty(dom.window.document, "hidden", {
    configurable: true, get: () => _hidden,
  });
  return {
    dom, doc: dom.window.document, pings,
    setHidden: (h: boolean) => { _hidden = h; },
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

function boot(h: Harness, thresholdMs: number): void {
  (h.dom.window as unknown as { eval: (s: string) => unknown })
    .eval(preparedAsset(thresholdMs));
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const count = (pings: string[], re: RegExp) =>
  pings.filter((u) => re.test(u)).length;
const THRESHOLD = /\/view_threshold_met\?/;
const ERROR = /\/error_impression\?/;

describe("codex view-timer phantom-billing fixes", () => {
  it("fix #2: view_threshold_met is the billing path; error_impression "
    + "never fires (no 5s spam)", async () => {
    const h = makeDom();
    h.doc.getElementById("mc")!.appendChild(liveShimmer(h.doc));
    boot(h, 600);
    await sleep(1100);                  // > threshold
    expect(count(h.pings, THRESHOLD)).toBe(1);
    expect(count(h.pings, ERROR)).toBe(0);
    await sleep(1400);                  // stay active well past old 5s cap
    expect(count(h.pings, THRESHOLD)).toBe(1);   // one-shot per session
    expect(count(h.pings, ERROR)).toBe(0);       // still no error spam
    h.dom.window.close();
  }, 10000);

  it("fix #1: the session ENDS on idle-drop and re-arms on the next turn "
    + "(no immortal off-screen accumulator)", async () => {
    const h = makeDom();
    const row = liveShimmer(h.doc);
    h.doc.getElementById("mc")!.appendChild(row);
    boot(h, 600);
    await sleep(1100);
    expect(count(h.pings, THRESHOLD)).toBe(1);

    // Turn ends: rect collapses → findRow releases → dropOverlay → viewEnd.
    setRect(row, { x: 0, y: 0, w: 0, h: 0 });
    await sleep(1800);                  // > GRACE_MS (1500)
    expect(h.doc.querySelector('[data-vibe-ads="codex"]')).toBeNull();
    const afterIdle = count(h.pings, THRESHOLD);

    // New turn: a FRESH session must fire a SECOND threshold_met. If the old
    // session had merely been hidden (not ended) its thresholdMet=true would
    // suppress this — so 2 proves the record was actually deleted.
    setRect(row, { x: 100, y: 200, w: 240, h: 20 });
    await sleep(1100);
    expect(count(h.pings, THRESHOLD)).toBe(afterIdle + 1);
    expect(count(h.pings, ERROR)).toBe(0);
    h.dom.window.close();
  }, 12000);

  it("fix #3: a hidden webview accrues no view-time and resumes when shown",
    async () => {
    const h = makeDom(true);           // start hidden
    h.doc.getElementById("mc")!.appendChild(liveShimmer(h.doc));
    boot(h, 600);
    await sleep(1200);                  // well past threshold, but hidden
    expect(count(h.pings, THRESHOLD)).toBe(0);   // paused → nothing billed
    expect(count(h.pings, ERROR)).toBe(0);

    h.setHidden(false);                // panel revealed → resume
    await sleep(1100);
    expect(count(h.pings, THRESHOLD)).toBe(1);
    expect(count(h.pings, ERROR)).toBe(0);
    h.dom.window.close();
  }, 10000);
});
