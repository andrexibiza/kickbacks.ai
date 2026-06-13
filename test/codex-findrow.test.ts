import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// Regression coverage for the codex-e2e row 03 + row 08 failures: Codex 26.x
// leaves a hidden "Thinking 1.2s" summary chip in chat history after a turn
// completes, with the same `text-size-chat truncate select-none` class trio
// the live shimmer uses. The old findRow() matched the stale chip and
// isThinkingRow() agreed → overlay never released at idle (row 03) and stuck
// to turn 1 on multi-turn prompts (row 08, "glued to turn 1").
//
// Fix is in extension/src/adapters/codex/block.asset.js: findRow() now also
// requires `loading-shimmer` in the className AND a non-zero bounding rect.

const ASSET = readFileSync(
  join(__dirname, "..", "src", "adapters", "codex", "block.asset.js"), "utf8");

function preparedAsset(): string {
  // Mirror CodexAdapter.renderBlock placeholder substitution (we only need
  // the IIFE body to run inside JSDOM; markers stripped since the bare asset
  // is itself a valid IIFE expression).
  const subs: Record<string, string> = {
    __VIBE_ADS_AD__: JSON.stringify("Ramp - Save time & money"),
    __VIBE_ADS_PORT__: "5555",
    __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"),
    __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
    __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ct"),
    __VIBE_ADS_CLICKURL__: JSON.stringify("https://ramp.example/lp"),
    __VIBE_ADS_CORR__: JSON.stringify("test.codex"),
    __VIBE_ADS_DEBUG__: "false",
    __VIBE_ADS_VIEW_THRESHOLD_MS__: "15000",
    __VIBE_ADS_ARG__: "e",        // unused by overlay path
    __VIBE_ADS_JSX__: "d",        // unused by overlay path
  };
  let src = ASSET;
  for (const [k, v] of Object.entries(subs)) src = src.split(k).join(v);
  return src;
}

function makeDom(): { dom: JSDOM; doc: Document; mc: HTMLElement } {
  const dom = new JSDOM(
    `<body><div id="mc" class="chatpanel"></div></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  // Stub fetch — the asset best-effort-pings the loopback; we just no-op.
  (dom.window as unknown as { fetch: typeof fetch }).fetch =
    (() => Promise.resolve(new (dom.window as unknown as { Response: typeof Response }).Response("", { status: 204 }))) as typeof fetch;
  // Force rects: jsdom returns 0×0 for layout. We patch getBoundingClientRect
  // on a per-element basis below to model live vs hidden states.
  const doc = dom.window.document;
  return { dom, doc, mc: doc.getElementById("mc") as HTMLElement };
}

function bootAsset(dom: JSDOM): void {
  // eval inside the JSDOM window ctx — same pattern as test/e2e.test.ts.
  // A <script>-tag inject would require runScripts:"dangerously" and is
  // strictly slower because jsdom rebuilds the parser path.
  (dom.window as unknown as { eval: (src: string) => unknown })
    .eval(preparedAsset());
}

// Helper: stamp a fixed rect on an element so the asset's
// getBoundingClientRect() visibility filter sees the shape we want.
function setRect(el: HTMLElement,
  r: { x: number; y: number; w: number; h: number }): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect })
    .getBoundingClientRect = () => ({
      x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + r.w,
      bottom: r.y + r.h, width: r.w, height: r.h, toJSON() { return {}; },
    } as DOMRect);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Real codex 26.x shimmer markup, copied from a captured codex.show debug
// line: class="loading-shimmer-pure-text _cadencedShimmer_1bpr9_1 text-
// size-chat leading-[1.5] select-none truncate". textContent renders as
// "ThinkingThinking" because the shimmer stacks two spans (base + sweep).
function makeLiveShimmer(doc: Document): HTMLElement {
  const el = doc.createElement("span");
  el.className = "loading-shimmer-pure-text _cadencedShimmer_1bpr9_1 "
    + "text-size-chat leading-[1.5] select-none truncate";
  // Two stacked spans → textContent = "ThinkingThinking"
  const a = doc.createElement("span"); a.textContent = "Thinking";
  const b = doc.createElement("span"); b.textContent = "Thinking";
  el.appendChild(a); el.appendChild(b);
  setRect(el, { x: 100, y: 200, w: 240, h: 20 });
  return el;
}

// The post-turn "Thinking 1.2s" summary chip Codex leaves in chat history
// after streaming ends. Same class trio (text-size-chat / truncate /
// select-none) BUT no loading-shimmer-* class and (typically) display:none
// → zero rect.
function makeStaleSummaryChip(doc: Document): HTMLElement {
  const el = doc.createElement("span");
  el.className = "text-size-chat leading-[1.5] select-none truncate";
  el.textContent = "Thinking 1.2s";
  setRect(el, { x: 0, y: 0, w: 0, h: 0 });    // display:none-equivalent
  return el;
}

describe("S9 codex findRow — live shimmer only, never stale chip", () => {
  it("paints overlay on a live shimmer row", async () => {
    const { dom, doc, mc } = makeDom();
    mc.appendChild(makeLiveShimmer(doc));
    bootAsset(dom);
    await sleep(200);                          // > 80ms interval tick
    const overlay = doc.querySelector('[data-vibe-ads="codex"]');
    expect(overlay).toBeTruthy();
    expect(overlay!.querySelector('[data-vibe-ads-ad]')).toBeTruthy();
    dom.window.close();
  });

  it("never paints on a post-turn 'Thinking 1.2s' summary chip alone",
    async () => {
    const { dom, doc, mc } = makeDom();
    mc.appendChild(makeStaleSummaryChip(doc));   // only the stale chip
    bootAsset(dom);
    await sleep(200);
    const overlay = doc.querySelector('[data-vibe-ads="codex"]');
    expect(overlay).toBeNull();
    dom.window.close();
  });

  it("picks the LIVE shimmer when both a stale chip AND a live shimmer "
    + "exist (row 08: 'glued to turn 1' regression guard)", async () => {
    const { dom, doc, mc } = makeDom();
    // Stale chip comes FIRST in DOM order — the bug had findRow returning
    // it because it matched the class trio. With the fix, the live
    // shimmer (which carries loading-shimmer + non-zero rect) wins.
    const stale = makeStaleSummaryChip(doc);
    const live = makeLiveShimmer(doc);
    mc.appendChild(stale);
    mc.appendChild(live);
    bootAsset(dom);
    await sleep(200);
    const overlay = doc.querySelector('[data-vibe-ads="codex"]') as
      HTMLElement | null;
    expect(overlay).toBeTruthy();
    // Overlay rect must align with the LIVE shimmer, not the stale chip.
    // The asset reads getBoundingClientRect().left/top off lastRow and
    // pins overlay.style.left/top to it; live rect is x=100,y=200.
    expect(overlay!.style.left).toBe("100px");
    expect(overlay!.style.top).toBe("200px");
    dom.window.close();
  });

  it("drops the overlay when the live shimmer becomes hidden "
    + "(row 03: idle-release regression guard)", async () => {
    const { dom, doc, mc } = makeDom();
    const live = makeLiveShimmer(doc);
    mc.appendChild(live);
    bootAsset(dom);
    await sleep(200);
    expect(doc.querySelector('[data-vibe-ads="codex"]')).toBeTruthy();
    // Simulate Codex finishing the turn: rect collapses to 0×0
    // (Codex applies display:none on the shimmer). The current row
    // class trio (text-size-chat/truncate/select-none) survives but
    // loading-shimmer-* drops or the rect drops to zero. Either way,
    // findRow() must release.
    setRect(live, { x: 0, y: 0, w: 0, h: 0 });
    // Walk past GRACE_MS=1500 so the idle-drop branch fires.
    await sleep(1800);
    expect(doc.querySelector('[data-vibe-ads="codex"]')).toBeNull();
    dom.window.close();
  });

  it("does NOT paint on a live-shimmer-class row that's visibility:hidden "
    + "(Codex 26 post-stream invisible-but-still-mounted state — row 03 "
    + "second-line regression guard)", async () => {
    const { dom, doc, mc } = makeDom();
    const live = makeLiveShimmer(doc);
    // Codex 26 transitional state: live shimmer remains mounted with the
    // sweep class on, has a non-zero rect (box reserved), but is invisible
    // because the chat panel marked it visibility:hidden. The old rect-
    // only filter would happily paint on this and the dot-cycle would
    // keep going past the harness's "idle confirmed" gate, false-FAILing
    // row 03 even after the class+rect filters were added.
    live.style.visibility = "hidden";
    mc.appendChild(live);
    bootAsset(dom);
    await sleep(200);
    expect(doc.querySelector('[data-vibe-ads="codex"]')).toBeNull();
    dom.window.close();
  });
});
