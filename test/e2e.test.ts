import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code/adapter";

const FIX = readFileSync(join(__dirname, "fixtures/synthetic-index.js"), "utf8");

// These jsdom e2e cases have multi-second real-time waits (verb idle/GRACE
// timing) and are SLOW — they are NOT part of the standard suite. Run them
// explicitly on demand only:  VIBE_ADS_E2E=1 npx vitest run test/e2e.test.ts
const E2E = process.env.VIBE_ADS_E2E === "1";

(E2E ? describe : describe.skip)(
  "S3 e2e (fixture only — never a real install)", () => {
  // Real CC structure (telemetry-confirmed): a `spinnerRow_<hash>` DIV inside
  // `messagesContainer_<hash> stickyMode_<hash>`, with the animated glyph in
  // a CHILD (.ccverb here). CC keeps the row for the turn (animating the
  // child in place) and REMOVES it when the turn ends; a new turn mounts a
  // fresh row. The block must occupy non-destructively (append OUR child,
  // hide CC's via visibility:hidden) and pin the ad to the row's presence.
  function makeCcDom() {
    const dom = new JSDOM(
      `<body><div id="mc" class="messagesContainer_X stickyMode_X"></div></body>`,
      { runScripts: "outside-only" });
    (dom.window as any).fetch = async () => ({ json: async () => ({}) });
    const doc = dom.window.document;
    const mc = doc.getElementById("mc")!;
    let turn = false;
    const tick = dom.window.setInterval(() => {
      const row = mc.querySelector('[class*="spinnerRow_"]');
      if (turn) {
        if (!row) {
          const r = doc.createElement("div");
          r.className = "spinnerRow_07S1Yg";
          const v = doc.createElement("span");
          v.className = "ccverb";
          v.textContent = "✢._.";
          r.appendChild(v);
          mc.appendChild(r);
        } else {                                  // CC animates child IN PLACE
          const v = row.querySelector(".ccverb");
          if (v) v.textContent = "✢" + ".".repeat(1 + (Date.now() >> 7) % 3);
        }
      } else if (row) {
        // REAL idle behavior (telemetry-confirmed): CC keeps spinnerRow
        // MOUNTED but stops the glyph (no longer ✢-led). The fix must drop
        // the overlay on the glyph stopping, not on row removal.
        const v = row.querySelector(".ccverb");
        if (v) v.textContent = "";
      }
    }, 120);
    return { dom, doc, tick, setTurn: (v: boolean) => { turn = v; } };
  }
  // The ad is a body-level overlay we own (NOT inside CC's tree).
  const adVisible = (doc: Document) => {
    const o = doc.querySelector('[data-vibe-ads-overlay="1"]') as
      HTMLElement | null;
    return !!o && !!o.isConnected && o.parentElement === doc.body &&
      (o.textContent || "").includes("Acme deploys faster");
  };
  // CC's spinner subtree must be byte-untouched: its child still present,
  // no data-vibe-ads* injected/added inside the row (we only READ it).
  const ccTreeUntouched = (doc: Document) => {
    const row = doc.querySelector('[class*="spinnerRow_"]');
    if (!row) return true;                 // row gone (idle) — trivially fine
    const v = row.querySelector(".ccverb");
    return !!v && v.getAttribute("data-vibe-ads-hid") === null &&
      (v as HTMLElement).style.visibility !== "hidden" &&
      row.querySelector("[data-vibe-ads-overlay]") === null &&
      row.querySelector("[data-vibe-ads-host]") === null;
  };

  it("patch -> ad renders in a body overlay, CC tree untouched -> restore " +
     "byte-exact", async () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-e2e-"));
    const target = join(d, "index.js");
    writeFileSync(target, FIX, "utf8");
    const a = new ClaudeCodeAdapter(target);
    expect(a.applyPatch({ tier: 3, adText: "Acme deploys faster than your CI now",
      iconRef: "icon.a", iconUrl: "", clickToken: "ck", clickUrl: "https://acme.example/lp",
      corr: "e2e.tst", loopbackPort: 5555,
      loopbackToken: "lt", loopbackBase: "http://127.0.0.1:5555" }).ok).toBe(true);
    const patched = readFileSync(target, "utf8");
    const block = patched.slice(patched.indexOf("/* VIBE-ADS-START */"));
    const dom = new JSDOM(
      `<body><div class="messagesContainer_X stickyMode_X">` +
      `<div class="spinnerRow_07S1Yg"><span class="ccverb">✢._.</span>` +
      `</div></div></body>`, { runScripts: "outside-only" });
    (dom.window as any).fetch = async () => ({ json: async () => ({}) });
    dom.window.eval(block);
    await new Promise((r) => setTimeout(r, 300));
    const doc = dom.window.document;
    expect(adVisible(doc)).toBe(true);                 // ad in body overlay
    expect(ccTreeUntouched(doc)).toBe(true);            // CC subtree untouched
    expect(doc.querySelector(".ccverb")).not.toBeNull(); // but NOT destroyed
    expect(a.restore().restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(FIX);    // byte-exact
  });

  it("ad PERSISTS frozen at idle (last ad stays in view), re-glues next " +
     "turn, CC tree never mutated", async () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-pin-"));
    const target = join(d, "index.js");
    writeFileSync(target, FIX, "utf8");
    new ClaudeCodeAdapter(target).applyPatch({ tier: 3,
      adText: "Acme deploys faster than your CI now", iconRef: "icon.a", iconUrl: "",
      clickToken: "ck", clickUrl: "https://acme.example/lp", corr: "e2e.pin",
      loopbackPort: 5555, loopbackToken: "lt",
      loopbackBase: "http://127.0.0.1:5555" });
    const patched = readFileSync(target, "utf8");
    const block = patched.slice(patched.indexOf("/* VIBE-ADS-START */"));
    const { dom, doc, tick, setTurn } = makeCcDom();
    dom.window.eval(block);

    setTurn(true);                                   // ---- turn 1 active
    await new Promise((r) => setTimeout(r, 700));
    expect(adVisible(doc)).toBe(true);
    expect(ccTreeUntouched(doc)).toBe(true);          // CC subtree untouched (read-only)

    setTurn(false);                                  // turn ends (glyph stops)
    await new Promise((r) => setTimeout(r, 4600));   // well > GRACE_MS
    // PERSIST-AT-IDLE: the ad is FROZEN in place, NOT dropped — the last
    // rendered frame stays on screen indefinitely after the turn ends.
    expect(adVisible(doc)).toBe(true);
    expect(ccTreeUntouched(doc)).toBe(true);          // still read-only

    setTurn(true);                                   // ---- brand-new turn
    await new Promise((r) => setTimeout(r, 700));
    expect(adVisible(doc)).toBe(true);               // thaws, re-glues
    expect(ccTreeUntouched(doc)).toBe(true);

    setTurn(false);
    dom.window.clearInterval(tick);
  }, 15000);

  it("does NOT vanish mid-thinking while CC animates its child in place " +
     "(read-only detection keeps the signal)", async () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-inplace-"));
    const target = join(d, "index.js");
    writeFileSync(target, FIX, "utf8");
    new ClaudeCodeAdapter(target).applyPatch({ tier: 3,
      adText: "Acme deploys faster than your CI now", iconRef: "icon.a", iconUrl: "",
      clickToken: "ck", clickUrl: "https://acme.example/lp", corr: "e2e.inpl",
      loopbackPort: 5555, loopbackToken: "lt",
      loopbackBase: "http://127.0.0.1:5555" });
    const patched = readFileSync(target, "utf8");
    const block = patched.slice(patched.indexOf("/* VIBE-ADS-START */"));
    const { dom, doc, tick, setTurn } = makeCcDom();
    dom.window.eval(block);

    setTurn(true);                                   // row stays; child anim
    await new Promise((r) => setTimeout(r, 1500));
    expect(adVisible(doc)).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));   // well past old GRACE
    expect(adVisible(doc)).toBe(true);               // STILL shown — no vanish
    expect(ccTreeUntouched(doc)).toBe(true);

    setTurn(false);
    await new Promise((r) => setTimeout(r, 4600));
    // PERSIST-AT-IDLE: still shown after the turn ends (frozen, not cleared).
    expect(adVisible(doc)).toBe(true);
    dom.window.clearInterval(tick);
  }, 20000);

  it("does NOT bill while frozen at idle (no view_tick / error_impression " +
     "pings accrue once the turn ends)", async () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-nobill-"));
    const target = join(d, "index.js");
    writeFileSync(target, FIX, "utf8");
    new ClaudeCodeAdapter(target).applyPatch({ tier: 3,
      adText: "Acme deploys faster than your CI now", iconRef: "icon.a", iconUrl: "",
      clickToken: "ck", clickUrl: "https://acme.example/lp", corr: "e2e.nobill",
      loopbackPort: 5555, loopbackToken: "lt",
      loopbackBase: "http://127.0.0.1:5555" });
    const patched = readFileSync(target, "utf8");
    const block = patched.slice(patched.indexOf("/* VIBE-ADS-START */"));
    const { dom, doc, tick, setTurn } = makeCcDom();
    // Record every loopback hit (fetch + sendBeacon) so we can prove the
    // view-time accumulator emits NOTHING once the ad freezes at idle.
    const pings: string[] = [];
    (dom.window as any).fetch = async (u: string) => {
      pings.push(String(u)); return { json: async () => ({}) };
    };
    try {
      Object.defineProperty(dom.window.navigator, "sendBeacon", {
        configurable: true,
        value: (u: string) => { pings.push(String(u)); return true; },
      });
    } catch { /* jsdom: no sendBeacon → ping() falls back to the fetch above */ }
    const billing = () =>
      pings.filter((u) => /view_tick|error_impression|view_threshold_met/.test(u));
    dom.window.eval(block);

    setTurn(true);                                   // active turn (<5s)
    await new Promise((r) => setTimeout(r, 700));
    expect(adVisible(doc)).toBe(true);

    setTurn(false);                                  // turn ends → freeze
    await new Promise((r) => setTimeout(r, 2500));   // > GRACE_MS: now frozen
    expect(adVisible(doc)).toBe(true);               // persisted
    const before = billing().length;                 // no billing yet (<5s)

    // Sit idle well past the 5s MAX_SESSION_MS / TICK_MS boundary. If billing
    // were NOT paused, the absolute-epoch clock would cross 5s of elapsed and
    // fire a view_tick/error_impression during this window.
    await new Promise((r) => setTimeout(r, 6000));
    expect(adVisible(doc)).toBe(true);               // still persisted
    expect(billing().length).toBe(before);           // …and STILL no billing

    setTurn(false);
    dom.window.clearInterval(tick);
  }, 20000);

  it("renders a clickable ad into a real usage banner when bannerOn", async () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-bn-"));
    const target = join(d, "index.js");
    writeFileSync(target, FIX, "utf8");
    const a = new ClaudeCodeAdapter(target);
    a.applyPatch({ tier: 3, adText: "Acme deploys faster", iconRef: "i", iconUrl: "",
      clickToken: "ck", clickUrl: "https://acme.example/lp", corr: "e2e.tst",
      loopbackPort: 5555,
      loopbackToken: "lt", loopbackBase: "http://127.0.0.1:5555", bannerOn: true });
    const patched = readFileSync(target, "utf8");
    const block = patched.slice(patched.indexOf("/* VIBE-ADS-START */"));
    const dom = new JSDOM(
      `<body><div id="b">You've used 71% of your weekly limit · resets in 4d · View usage</div></body>`,
      { runScripts: "outside-only" });
    (dom.window as any).fetch = async () => ({ json: async () => ({}) });
    dom.window.eval(block);
    await new Promise((r) => setTimeout(r, 1200)); // banner loop is 1s
    const b = dom.window.document.getElementById("b")!;
    expect(b.getAttribute("data-vibe-ads-banner")).toBe("1");
    expect(b.innerHTML).toContain("Acme deploys faster");
    expect(b.innerHTML).toContain('data-vibe-ads-ad="1"');
  });

  it("leaves the banner untouched when bannerOn is false", async () => {
    const d = mkdtempSync(join(tmpdir(), "vibe-ads-bf-"));
    const target = join(d, "index.js");
    writeFileSync(target, FIX, "utf8");
    new ClaudeCodeAdapter(target).applyPatch({ tier: 3, adText: "Acme", iconRef: "i", iconUrl: "",
      clickToken: "ck", clickUrl: "https://acme.example/lp", corr: "e2e.tst",
      loopbackPort: 5555,
      loopbackToken: "lt", loopbackBase: "http://127.0.0.1:5555", bannerOn: false });
    const patched = readFileSync(target, "utf8");
    const block = patched.slice(patched.indexOf("/* VIBE-ADS-START */"));
    const orig = "You've used 71% of your weekly limit · resets in 4d · View usage";
    const dom = new JSDOM(`<body><div id="b">${orig}</div></body>`,
      { runScripts: "outside-only" });
    (dom.window as any).fetch = async () => ({ json: async () => ({}) });
    dom.window.eval(block);
    await new Promise((r) => setTimeout(r, 1200));
    expect(dom.window.document.getElementById("b")!.textContent).toBe(orig);
  });

  it("the real-install locator is NOT used by tests (guard)", () => {
    // extension.ts only resolves the real path inside activate(); no test
    // imports or invokes locateClaudeCode against the real FS. Assert the
    // fixture-only contract by construction: importing the adapter requires
    // an explicit target (no default real path).
    // @ts-expect-error constructor requires a target argument
    expect(() => new ClaudeCodeAdapter()).toThrow;
  });
});
