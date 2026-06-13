import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { CapWarning, formatReset } from "../src/activation/capWarning";

const RED = "#f85149";

/** Construct a CapWarning while capturing the underlying status-bar item, so
 *  tests can assert on its text/color/tooltip and spy its show/hide. Mirrors
 *  the statusbar.test.ts capture pattern. */
function makeCap() {
  let item: {
    text: string; tooltip: string; command: string | undefined;
    color: string | undefined;
    show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  const spy = vi.spyOn(vscode.window, "createStatusBarItem").mockImplementation(
    () => {
      item = { text: "", tooltip: "", command: undefined, color: undefined,
               show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
      return item as unknown as vscode.StatusBarItem;
    });
  const cw = new CapWarning();
  spy.mockRestore();
  return { cw, item: item! };
}

describe("formatReset", () => {
  it("formats sub-minute, minutes, and hours+minutes", () => {
    expect(formatReset(0)).toBe("<1m");
    expect(formatReset(59)).toBe("<1m");
    expect(formatReset(22 * 60)).toBe("22m");
    expect(formatReset(59 * 60)).toBe("59m");
    expect(formatReset(6 * 3600)).toBe("6h");          // exact hour drops "0m"
    expect(formatReset(6 * 3600 + 12 * 60)).toBe("6h12m");
  });
  it("clamps negatives to <1m", () => {
    expect(formatReset(-5)).toBe("<1m");
  });
});

describe("CapWarning", () => {
  it("hourly: clock icon, red, $-prefixed cap, shown", () => {
    const { cw, item } = makeCap();
    cw.show({ scope: "hourly", capUsd: "10.00", resetSeconds: 22 * 60 });
    expect(item.text).toBe("$(clock) Hourly cap · 22m");
    expect(item.color).toBe(RED);
    expect(item.command).toBe("kickbacks.debugMenu");
    expect(item.tooltip).toContain("$10.00/hr");
    expect(item.tooltip).toContain("top of the hour");
    expect(item.show).toHaveBeenCalled();
  });

  it("daily: warning icon, red, resets-UTC tooltip", () => {
    const { cw, item } = makeCap();
    cw.show({ scope: "daily", capUsd: "50.00", resetSeconds: 6 * 3600 + 12 * 60 });
    expect(item.text).toBe("$(warning) Daily cap · 6h12m");
    expect(item.color).toBe(RED);
    expect(item.tooltip).toContain("$50.00");
    expect(item.tooltip).toContain("00:00 UTC");
    expect(item.show).toHaveBeenCalled();
  });

  it("hide() hides the item", () => {
    const { cw, item } = makeCap();
    cw.hide();
    expect(item.hide).toHaveBeenCalled();
  });

  it("dispose() disposes the item", () => {
    const { cw, item } = makeCap();
    cw.dispose();
    expect(item.dispose).toHaveBeenCalled();
  });
});
