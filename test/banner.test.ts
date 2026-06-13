import { describe, it, expect } from "vitest";
import { resolveBannerOn } from "../src/banner";

describe("resolveBannerOn", () => {
  it("override 'on' forces true even if server is false", () => {
    expect(resolveBannerOn(false, "on")).toBe(true);
  });
  it("override 'off' forces false even if server is true", () => {
    expect(resolveBannerOn(true, "off")).toBe(false);
  });
  it("override 'server' follows the server flag", () => {
    expect(resolveBannerOn(true, "server")).toBe(true);
    expect(resolveBannerOn(false, "server")).toBe(false);
  });
  it("defaults to following server when override is undefined (old globalState)", () => {
    expect(resolveBannerOn(true, undefined)).toBe(true);
    expect(resolveBannerOn(false, undefined)).toBe(false);
  });
});
