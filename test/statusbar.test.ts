import { describe, it, expect, vi } from "vitest";
import { StatusBar } from "../src/statusbar";
import { window, ThemeColor } from "./mocks/vscode";

// NOTE: VS Code codicons render as `$(name)` in status-bar text, so the raw
// string always contains `$(`. Earnings assertions match `$<digit>` instead.
describe("StatusBar", () => {
  it("renders each state; signed-in shows Kickbacks + earnings, no 'debug' word", () => {
    const sb = new StatusBar();

    sb.set({ kind: "signed-out" });
    expect(sb.text).toMatch(/sign in/i);

    sb.set({ kind: "active", version: "2.1.143", usd: "1.53" });
    expect(sb.text).toContain("Kickbacks");
    expect(sb.text).toMatch(/\$1\.53/);
    expect(sb.text).not.toMatch(/active|2\.1\.143/); // version is tooltip-only

    sb.set({ kind: "active", version: "2.1.143" }); // no figure yet => $0.00
    expect(sb.text).toContain("Kickbacks");
    expect(sb.text).toMatch(/\$0\.00 today · \$0\.00/);

    // debug renders exactly like active — never the word "debug"
    sb.set({ kind: "debug", on: true, usd: "2.00" });
    expect(sb.text).toMatch(/\$2\.00/);
    expect(sb.text).not.toMatch(/debug/i);

    sb.set({ kind: "incompatible", version: "9.9.9" });
    expect(sb.text).toMatch(/incompatible/i);
    expect(sb.text).toContain("9.9.9");

    sb.set({ kind: "killed" });
    expect(sb.text).toMatch(/killed/i);

    sb.set({ kind: "offline" });
    expect(sb.text).toMatch(/offline/i);

    sb.set({ kind: "ad", adText: "Try Acme Widgets — acme.com" });
    expect(sb.text).toBe("Kickbacks.ai  |  Try Acme Widgets — acme.com");
  });
});

describe("StatusBar S7 today+lifetime", () => {
  it("active renders today + lifetime", () => {
    const sb = new StatusBar();
    sb.set({ kind: "active", version: "2.1.143", usd: "1.20", usdToday: "0.04" });
    expect(sb.text).toMatch(/\$0\.04 today/);
    expect(sb.text).toMatch(/\$1\.20/);
    sb.dispose();
  });
  it("active with only lifetime defaults today to $0.00", () => {
    const sb = new StatusBar();
    sb.set({ kind: "active", version: "2.1.143", usd: "1.20" });
    expect(sb.text).toMatch(/\$0\.00 today · \$1\.20/);
    sb.dispose();
  });
  it("active with no earnings shows $0.00 (never a bare label)", () => {
    const sb = new StatusBar();
    sb.set({ kind: "active", version: "2.1.143" });
    expect(sb.text).toMatch(/\$0\.00 today · \$0\.00/);
    sb.dispose();
  });
  it("signed-out never shows $amount", () => {
    const sb = new StatusBar();
    sb.set({ kind: "signed-out" });
    expect(sb.text).not.toMatch(/\$\d/);
    sb.dispose();
  });
});

describe("StatusBar needs-reload (post-install red call-to-action)", () => {
  type Item = { text: string; command?: string; color?: string;
                backgroundColor?: ThemeColor };
  // Capture the underlying status-bar item so the red-background + click
  // wiring is assertable (the field is private on StatusBar).
  function mk(): { sb: StatusBar; item: Item } {
    let item!: Item;
    const orig = window.createStatusBarItem;
    const spy = vi.spyOn(window, "createStatusBarItem").mockImplementation(
      () => { item = orig() as Item; return item as never; });
    const sb = new StatusBar();
    spy.mockRestore();
    return { sb, item };
  }

  it("renders RELOAD text on a red background with white text; click reloads the window", () => {
    const { sb, item } = mk();
    sb.set({ kind: "needs-reload" });
    expect(sb.text).toMatch(/reload/i);
    expect(sb.text).toMatch(/earn money/i);
    expect(item.backgroundColor?.id).toBe("statusBarItem.errorBackground");
    expect(item.color).toBe("#ffffff");
    expect(item.command).toBe("workbench.action.reloadWindow");
    sb.dispose();
  });

  it("is sticky for routine paints (earnings refresh, ads), but safety states paint over it", () => {
    const { sb, item } = mk();
    sb.set({ kind: "needs-reload" });
    const locked = sb.text;
    sb.set({ kind: "active", version: "2.1.143", usd: "9.99" });
    sb.set({ kind: "ad", adText: "Try Acme" });
    expect(sb.text).toBe(locked);
    expect(item.backgroundColor?.id).toBe("statusBarItem.errorBackground");
    sb.set({ kind: "killed" });
    expect(sb.text).not.toBe(locked);
    expect(sb.text).toMatch(/killed/i);
    sb.dispose();
  });

  it("other states never carry a background and keep the menu click", () => {
    const { sb, item } = mk();
    sb.set({ kind: "active", version: "2.1.143", usd: "1.00" });
    expect(item.backgroundColor).toBeUndefined();
    expect(item.command).toBe("kickbacks.debugMenu");
    sb.dispose();
  });
});
