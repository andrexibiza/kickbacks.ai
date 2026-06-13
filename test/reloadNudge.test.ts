import { describe, it, expect, vi, afterEach } from "vitest";
import { window, commands } from "./mocks/vscode";
import { showInstallReloadNudge, showSignInReloadNudge }
  from "../src/activation/reloadNudge";

vi.mock("../src/log", () => ({
  dlog: vi.fn(),
}));

afterEach(() => { vi.restoreAllMocks(); });

type ToastArgs = { msg: string; opts?: { modal?: boolean; detail?: string };
                  buttons: string[] };

function spyToast(answer: string | undefined): { calls: ToastArgs[] } {
  const calls: ToastArgs[] = [];
  vi.spyOn(window, "showInformationMessage").mockImplementation(
    async (msg: unknown, ...rest: unknown[]) => {
      const opts = (rest[0] && typeof rest[0] === "object")
        ? rest[0] as ToastArgs["opts"] : undefined;
      const buttons = (opts ? rest.slice(1) : rest) as string[];
      calls.push({ msg: String(msg), opts, buttons });
      return answer as never;
    });
  return { calls };
}

describe("install reload nudge", () => {
  it("is modal, says earnings need a reload, and Reload Now reloads the window", async () => {
    const t = spyToast("Reload Now");
    const exec = vi.spyOn(commands, "executeCommand");
    await showInstallReloadNudge();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].msg).toMatch(/won't earn money until you reload/i);
    expect(t.calls[0].opts?.modal).toBe(true);
    expect(t.calls[0].buttons).toContain("Reload Now");
    expect(exec).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("dismissing does not reload", async () => {
    spyToast(undefined);
    const exec = vi.spyOn(commands, "executeCommand");
    await showInstallReloadNudge();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("sign-in reload nudge", () => {
  it("is modal, says reload to start collecting money, and Reload Now reloads", async () => {
    const t = spyToast("Reload Now");
    const exec = vi.spyOn(commands, "executeCommand");
    await showSignInReloadNudge();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].msg).toMatch(/reload to start collecting money/i);
    expect(t.calls[0].opts?.modal).toBe(true);
    expect(t.calls[0].buttons).toContain("Reload Now");
    expect(exec).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("dismissing does not reload", async () => {
    spyToast(undefined);
    const exec = vi.spyOn(commands, "executeCommand");
    await showSignInReloadNudge();
    expect(exec).not.toHaveBeenCalled();
  });
});
