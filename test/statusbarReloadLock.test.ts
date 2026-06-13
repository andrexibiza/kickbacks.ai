import { describe, it, expect } from "vitest";
import { StatusBar, type SbState } from "../src/statusbar";

// Audit #29: the needs-reload lock must mask ONLY routine earning paints
// (ad / active / debug-ON). Safety/truth states must always win — a locked
// bar that hides "killed", "offline" or "Sign in" is lying — and a masked
// paint must be reported (set() → false) so statusBarAd never bills an ad
// that was never displayed.
describe("StatusBar reloadLock (audit #29)", () => {
  it("masks routine paints (ad / active / debug-ON) and reports false", () => {
    const sb = new StatusBar();
    expect(sb.set({ kind: "needs-reload" })).toBe(true);
    const locked = sb.text;
    expect(sb.set({ kind: "ad", adText: "Try Acme" })).toBe(false);
    expect(sb.set({ kind: "active", version: "2.1.143", usd: "9.99" })).toBe(false);
    expect(sb.set({ kind: "debug", on: true, usd: "1.00" })).toBe(false);
    expect(sb.text).toBe(locked);
    sb.dispose();
  });

  const safetyStates: [SbState, RegExp][] = [
    [{ kind: "killed" }, /killed/i],
    [{ kind: "offline" }, /offline/i],
    [{ kind: "signed-out" }, /sign in/i],
    [{ kind: "incompatible", version: "9.9.9" }, /incompatible/i],
    [{ kind: "debug", on: false }, /off/i],
  ];
  for (const [state, re] of safetyStates) {
    it(`safety/truth state "${state.kind}" always paints over the lock`, () => {
      const sb = new StatusBar();
      sb.set({ kind: "needs-reload" });
      expect(sb.set(state)).toBe(true);
      expect(sb.text).toMatch(re);
      sb.dispose();
    });
  }

  it("a safety paint clears the lock so recovery paints resume", () => {
    const sb = new StatusBar();
    sb.set({ kind: "needs-reload" });
    sb.set({ kind: "offline" });             // safety wins + clears the lock
    expect(sb.set({ kind: "active", version: "2.1.143", usd: "0.10" })).toBe(true);
    expect(sb.text).toMatch(/\$0\.10/);
    sb.dispose();
  });

  it("needs-reload can re-engage the lock after a safety clear", () => {
    const sb = new StatusBar();
    sb.set({ kind: "needs-reload" });
    sb.set({ kind: "killed" });              // clears the lock
    sb.set({ kind: "needs-reload" });        // re-engages it
    expect(sb.set({ kind: "ad", adText: "x" })).toBe(false);
    expect(sb.text).toMatch(/reload/i);
    sb.dispose();
  });

  it("set() reports true for every paint while unlocked", () => {
    const sb = new StatusBar();
    expect(sb.set({ kind: "ad", adText: "x" })).toBe(true);
    expect(sb.set({ kind: "active", version: "2.1.143" })).toBe(true);
    expect(sb.set({ kind: "killed" })).toBe(true);
    sb.dispose();
  });
});
