import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TargetAdapter } from "../src/adapters/types";
import { activate, deactivate, __wireForTest } from "../src/extension";
import { makeContext, secrets, commands } from "./mocks/vscode";

describe("scaffold", () => {
  it("TargetAdapter type is importable and shaped", () => {
    const a: Pick<TargetAdapter, "name"> = { name: "claude-code" };
    expect(a.name).toBe("claude-code");
  });
});

describe("manifest ⇄ runtime parity for kickbacks.test.* hooks", () => {
  beforeEach(() => {
    secrets.clear();
    commands._handlers.clear();
    commands._executed.length = 0;
    __wireForTest({});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("every kickbacks.test.* command declared in package.json is registered"
    + " at activation when the gate is on — catches manifest/runtime drift",
    async () => {
    const pkg = JSON.parse(readFileSync(
      join(__dirname, "..", "package.json"), "utf8")) as {
        contributes: { commands: { command: string }[] } };
    const declared = pkg.contributes.commands
      .map((c) => c.command)
      .filter((c) => c.startsWith("kickbacks.test."))
      .sort();
    expect(declared.length).toBeGreaterThan(0); // sanity

    const adapter = {
      name: "claude-code" as const,
      preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
      version: () => "2.1.143",
      applyPatch: vi.fn(() => ({ ok: true })),
      restore: vi.fn(() => ({ ok: true, restored: true })),
    };
    const statusBar = { set: vi.fn(), dispose: vi.fn() };
    __wireForTest({ adapter, statusBar });
    vi.stubGlobal("fetch", vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({}) } as Response)));
    const ctx = makeContext();
    try {
      await activate(ctx as never);
      const registered = [...commands._handlers.keys()]
        .filter((c) => c.startsWith("kickbacks.test."))
        .sort();
      // Every declared id has a runtime handler — no orphan menu entries.
      for (const id of declared) expect(registered).toContain(id);
      // And every runtime handler is declared — no shadow commands hidden
      // from the manifest.
      for (const id of registered) expect(declared).toContain(id);
    } finally { await deactivate(); }
  });
});
