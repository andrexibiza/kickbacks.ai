import { describe, it, expect } from "vitest";
import { applyMissStatus } from "../src/activation/webviewInjection";

// Regression: a transient injection miss (loopback port race on
// reload/self-update, or a single applyPatch failure) must NOT relabel a
// still-live, ad-serving block as "incompatible". This was the cosmetic
// "Kickbacks incompatible" label users saw while ads were actually serving.
// The first param is "ANY webview target patched" (S9 dual target) — a live
// Codex block keeps the label honest exactly like a live Claude Code block;
// the union is pinned in webviewInjection-dualtarget.test.ts.
describe("applyMissStatus (honest incompatible label)", () => {
  it("defers to active (null) when a block is already live (either target)", () => {
    expect(applyMissStatus(true, "2.1.161")).toBeNull();
  });

  it("reports incompatible ONLY when NO target is patched", () => {
    expect(applyMissStatus(false, "2.1.161"))
      .toEqual({ kind: "incompatible", version: "2.1.161" });
  });
});
