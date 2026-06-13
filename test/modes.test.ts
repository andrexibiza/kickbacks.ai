import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const REAL_UP = process.env.USERPROFILE;
let dir: string;
let vd: string;

async function fresh() {
  const m = await import("../src/modes");
  return m;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibe-modes-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  vd = join(dir, ".vibe-ads");
  mkdirSync(vd, { recursive: true });
});

afterEach(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_UP !== undefined) process.env.USERPROFILE = REAL_UP; else delete process.env.USERPROFILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("modes", () => {
  it("defaults: webview on, cli on, banner server", async () => {
    const m = await fresh();
    expect(m.webviewMode()).toBe("on");
    expect(m.cliMode()).toBe("on");
    expect(m.bannerOverride()).toBe("server");
  });

  it("webview.off / cli.off sentinels force off; round-trips via setters", async () => {
    const m = await fresh();
    m.setWebviewMode(false);
    m.setCliMode(false);
    expect(existsSync(join(vd, "webview.off"))).toBe(true);
    expect(m.webviewMode()).toBe("off");
    expect(m.cliMode()).toBe("off");
    m.setWebviewMode(true);
    expect(existsSync(join(vd, "webview.off"))).toBe(false);
    expect(m.webviewMode()).toBe("on");
  });

  it("banner.mode reads on/off; invalid -> server; setter writes/removes", async () => {
    const m = await fresh();
    writeFileSync(join(vd, "banner.mode"), " on \n");
    expect(m.bannerOverride()).toBe("on");
    writeFileSync(join(vd, "banner.mode"), "garbage");
    expect(m.bannerOverride()).toBe("server");
    m.setBannerOverride("off");
    expect(m.bannerOverride()).toBe("off");
    m.setBannerOverride("server");
    expect(existsSync(join(vd, "banner.mode"))).toBe(false);
    expect(m.bannerOverride()).toBe("server");
  });

  it("never throws on fs errors (returns safe defaults)", async () => {
    const m = await fresh();
    process.env.HOME = "\0invalid";
    process.env.USERPROFILE = "\0invalid";
    expect(() => m.webviewMode()).not.toThrow();
    expect(m.webviewMode()).toBe("on");
    expect(m.bannerOverride()).toBe("server");
  });
});
