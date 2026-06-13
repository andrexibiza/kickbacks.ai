import { describe, it, expect } from "vitest";
import { isThinkingMessage } from "../src/adapters/codex/adapter";

// `m` is the live `e.message` prop the ThinkingShimmer entry receives. A bare
// React element shape is `{ props: {...} }`; null/undefined => Codex falls back
// to its own `thinkingShimmer.default` "Thinking" placeholder (spec §4.4 — the
// ONLY surface we override; every real tool/approval/reviewer status passes
// through untouched).
const el = (props: Record<string, unknown>) => ({ props });

describe("Codex display gate (spec §4.4)", () => {
  it("ad SHOWS: null / undefined / reasoningItem.thinking / thinkingShimmer.default / defaultMessage Thinking", () => {
    expect(isThinkingMessage(null)).toBe(true);
    expect(isThinkingMessage(undefined)).toBe(true);
    expect(isThinkingMessage(el({ id: "reasoningItem.thinking" }))).toBe(true);
    expect(isThinkingMessage(el({ id: "thinkingShimmer.default" }))).toBe(true);
    expect(isThinkingMessage(el({ defaultMessage: "Thinking" }))).toBe(true);
  });
  it("ad HIDDEN: tool / approval / reviewer / arbitrary / non-element", () => {
    expect(isThinkingMessage(el({ id: "localConversation.approvalRequest.inProgress" }))).toBe(false);
    expect(isThinkingMessage(el({ id: "localConversation.userInputRequest.inProgress" }))).toBe(false);
    expect(isThinkingMessage(el({ defaultMessage: "Reading {target}" }))).toBe(false);
    expect(isThinkingMessage(el({ id: "something.else" }))).toBe(false);
    expect(isThinkingMessage("a string")).toBe(false);
    expect(isThinkingMessage(42)).toBe(false);
  });
});
