import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

// Regression coverage for the CC-webview view-timer billing fixes
// (audit 2026-06-09 findings #8, #15, #23) — the same phantom-billing class
// already fixed in the codex block (see codex-viewtimer.test.ts):
//   #8  viewHide was a documented no-op: the dropOverlay / banner-hidden
//       paths never ended their _vt session, so a failed dock kept emitting
//       view_tick + error_impression every 5s forever. viewHide now ENDS
//       the session (codex viewEnd semantics); a later viewShow re-arms a
//       FRESH session.
//   #15 the banner session kept billing while display:none during turns.
//       Hide ends the session; un-hide opens a fresh one. (Banner billing
//       while VISIBLE at idle is by design and unchanged.)
//   #23 laptop suspend was billed as visible time and replayed as a
//       synchronous view_tick burst on wake (absolute-epoch elapsed +
//       unbounded catch-up loop). viewTick now clamps poll gaps > 2 tick
//       intervals: the excess shifts the baseline (never billed) and at
//       most ONE catch-up tick fires per wake.
//
// Harness: the block runs in JSDOM on its real 250ms/1s intervals, but the
// webview realm's Date.now is test-controlled, so "elapsed" view-time (and
// an 8h suspend) advance only when the test says so — deterministic billing
// boundaries without 5s real-time sleeps.

const ASSET = readFileSync(
  join(__dirname, "..", "src", "adapters", "claude-code", "block.asset.js"),
  "utf8");

function preparedAsset(opts: { bannerOn: boolean }): string {
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
    __VIBE_ADS_BANNER_ON__: opts.bannerOn ? "true" : "false",
    __VIBE_ADS_CORR__: JSON.stringify("ad1.abcd"),
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

function makeHarness(opts: { bannerOn: boolean }): Harness {
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => { /* anchor navigation etc. — irrelevant here */ });
  const dom = new JSDOM(`<body></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true,
      virtualConsole: vc });
  const win = dom.window as unknown as Window & typeof globalThis & {
    eval: (s: string) => unknown; fetch: typeof fetch;
  };
  const pings: string[] = [];
  win.fetch = ((url: string) => {
    pings.push(String(url));
    return Promise.resolve({ json: async () => ({}) });
  }) as unknown as typeof fetch;
  // Take over the webview realm's wall clock BEFORE booting the block: every
  // billing decision in the asset reads Date.now(). The real setInterval
  // polls keep firing underneath; only "elapsed" is virtual.
  let t = 1_700_000_000_000;
  (win as unknown as { Date: DateConstructor }).Date.now = () => t;
  win.eval(preparedAsset(opts));
  return { dom, doc: dom.window.document, pings,
    advance: (ms: number) => { t += ms; } };
}

// A live CC spinner row. The block treats the row as ACTIVE only while its
// leading sparkle glyph keeps CHANGING within GRACE_MS (fake-clock ms), so:
// with the clock frozen it stays active for free; every advance() > GRACE_MS
// must be paired with spin() (same synchronous step) to stay "thinking", or
// left un-spun to go idle.
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
const THRESHOLD = /\/view_threshold_met\?/;
function visibleMs(u: string): number {
  const m = /[?&]visible_ms=(\d+)/.exec(u);
  return m ? Number(m[1]) : -1;
}

describe("CC view-timer billing fixes (audit #8/#15/#23)", () => {
  it("#8: a failed dock (composer miss) ENDS the overlay session — no "
    + "view_tick/error_impression keeps firing off-screen; the next turn "
    + "re-arms a FRESH session", async () => {
    const h = makeHarness({ bannerOn: false });
    const sp = addSpinner(h.doc);
    await sleep(400);                       // evaluate() paints + viewShow
    expect(h.doc.querySelector('[data-vibe-ads-overlay="1"]')).toBeTruthy();

    h.advance(5_100); sp.spin();            // cross one tick boundary, active
    await sleep(500);
    expect(count(h.pings, OVERLAY_TICK)).toBe(1);

    // Turn ends; jsdom has no visible composer → dock_miss → dropOverlay
    // (exactly the finding-#8 failure path). The glyph is NOT rotated so the
    // row goes stale past GRACE_MS.
    h.advance(2_000);
    await sleep(500);
    expect(h.doc.querySelector('[data-vibe-ads-overlay="1"]')).toBeNull();
    const ticksAtDrop = count(h.pings, OVERLAY_TICK);
    const errsAtDrop = count(h.pings, ERROR);

    // OLD behavior: the no-op viewHide left the session immortal — this
    // jump crossed the 10s and 15s boundaries and kept emitting. An ENDED
    // session emits NOTHING.
    h.advance(9_900);
    await sleep(500);
    expect(count(h.pings, OVERLAY_TICK)).toBe(ticksAtDrop);
    expect(count(h.pings, ERROR)).toBe(errsAtDrop);

    // A new turn re-glues and opens a FRESH session: its first tick reports
    // visible_ms=5000, not a carried-over total.
    sp.spin();
    await sleep(400);
    expect(h.doc.querySelector('[data-vibe-ads-overlay="1"]')).toBeTruthy();
    h.advance(5_100); sp.spin();
    await sleep(500);
    const ticks = h.pings.filter((u) => OVERLAY_TICK.test(u));
    expect(ticks.length).toBe(ticksAtDrop + 1);
    expect(visibleMs(ticks[ticks.length - 1])).toBe(5_000);
    h.dom.window.close();
  }, 20000);

  it("#15: the banner session ENDS while hidden during a turn "
    + "(display:none must not bill); un-hide at idle opens a FRESH session",
    async () => {
    const h = makeHarness({ bannerOn: true });
    addBanner(h.doc);
    await sleep(1_300);                     // banner loop is 1s
    expect(h.doc.querySelector('[data-vibe-ads-banner="1"]')).toBeTruthy();

    // Visible-at-idle billing is BY DESIGN and must keep working.
    h.advance(5_100);
    await sleep(500);
    expect(count(h.pings, BANNER_TICK)).toBe(1);

    // A turn starts → banner hides → its session must END.
    const sp = addSpinner(h.doc);
    await sleep(1_300);                     // ≥1 banner tick: hide + end
    const bEl = h.doc.querySelector(
      '[data-vibe-ads-banner="1"]') as HTMLElement;
    expect(bEl.style.display).toBe("none");
    const hiddenAt = count(h.pings, BANNER_TICK);

    // OLD behavior: the hidden banner's session kept passing the paused
    // gate and ticked at the 10s/15s boundaries of this jump.
    h.advance(9_900); sp.spin();            // stay in-turn across the jump
    await sleep(700);
    expect(count(h.pings, BANNER_TICK)).toBe(hiddenAt);

    // Turn ends (no composer → overlay drops, _spinnerActive clears) →
    // banner un-hides and a FRESH session starts at 0.
    h.advance(2_000);                       // glyph frozen → idle → drop
    await sleep(1_500);
    expect(bEl.style.display).not.toBe("none");
    h.advance(5_100);
    await sleep(500);
    const ticks = h.pings.filter((u) => BANNER_TICK.test(u));
    expect(ticks.length).toBe(hiddenAt + 1);
    expect(visibleMs(ticks[ticks.length - 1])).toBe(5_000);  // fresh baseline
    h.dom.window.close();
  }, 20000);

  it("#23: an 8h suspend is NOT billed as visible time and NOT replayed as "
    + "a tick burst on wake (at most one catch-up tick; session survives)",
    async () => {
    const h = makeHarness({ bannerOn: true });
    addBanner(h.doc);
    await sleep(1_300);                     // banner session live at idle
    h.advance(5_100);
    await sleep(500);
    expect(count(h.pings, BANNER_TICK)).toBe(1);

    // Laptop suspends for 8 hours with the session live. OLD behavior:
    // the wake poll replayed one view_tick per 5s of sleep (~5760 events)
    // each reporting machine-off time as cumulative visible_ms.
    h.advance(8 * 3_600_000);
    await sleep(700);
    const ticks = h.pings.filter((u) => BANNER_TICK.test(u));
    expect(ticks.length).toBe(2);           // exactly ONE catch-up tick
    expect(visibleMs(ticks[1])).toBe(10_000);  // sleep excluded, not ~8h
    expect(count(h.pings, ERROR)).toBe(0);
    expect(count(h.pings, THRESHOLD)).toBe(0);

    // Billing continues normally after wake — the baseline was shifted
    // past the sleep, not the session torn down.
    h.advance(5_000);
    await sleep(500);
    const after = h.pings.filter((u) => BANNER_TICK.test(u));
    expect(after.length).toBe(3);
    expect(visibleMs(after[2])).toBe(15_000);
    h.dom.window.close();
  }, 20000);
});
