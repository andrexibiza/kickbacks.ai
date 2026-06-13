import { describe, it, expect, vi, beforeEach } from "vitest";
import { DebugController } from "../src/debug";
import { Loopback } from "../src/loopback";
import { bootLoopback, resetSharedLoopbackForTest }
  from "../src/util/loopbackBoot";
import { resetServingGate, setKillPosture } from "../src/servingGate";
import { makeContext, window, commands, _opened } from "./mocks/vscode";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: the shared-loopback record and the serving gate are module-level
// singletons (audit #7 / wave 2) — never leak one test's state into the next.
beforeEach(() => { resetServingGate(); resetSharedLoopbackForTest(); });

function authHook(signedIn: boolean) {
  return {
    signedIn: () => signedIn,
    storageInfo: () => ({ scheme: "file" }),
    signOut: vi.fn(async () => {}),
  };
}

function mkAdapter() {
  return {
    name: "claude-code",
    preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
    version: () => "2.1.143",
    applyPatch: vi.fn(() => ({ ok: true })),
    restore: vi.fn(() => ({ ok: true, restored: true })),
  };
}

describe("DebugController", () => {
  it("defaults to off with a default message", () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    expect(d.on()).toBe(false);
    expect(d.text()).toMatch(/kickbacks/i);
  });

  it("setOn(true) patches with the custom text and reports state", async () => {
    const adapter = mkAdapter();
    const ctx = makeContext() as never;
    const onState = vi.fn();
    const d = new DebugController(adapter, ctx, onState);
    await d.setText("Hello from debug");
    await d.setOn(true);
    expect(d.on()).toBe(true);
    expect(adapter.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({ adText: "Hello from debug", tier: 3 }));
    expect(onState).toHaveBeenCalledWith(true);
    await d.dispose();
  });

  it("setOn(false) restores and reports state", async () => {
    const adapter = mkAdapter();
    const onState = vi.fn();
    const d = new DebugController(adapter, makeContext() as never, onState);
    await d.setOn(false);
    expect(adapter.restore).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith(false);
  });

  it("reassertTick re-applies when ON but the patch drifted (Bug B)", async () => {
    const adapter = { ...mkAdapter(), isPatched: vi.fn(() => false) };
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.setOn(true);                  // persists ON (applies once)
    adapter.applyPatch.mockClear();
    await d.reassertTick();
    expect(adapter.applyPatch).toHaveBeenCalled();   // self-healed, no toggle
    await d.dispose();
  });

  it("reassertTick is a no-op when ON and the patch is still present", async () => {
    const adapter = { ...mkAdapter(), isPatched: vi.fn(() => true) };
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.setOn(true);
    adapter.applyPatch.mockClear();
    await d.reassertTick();
    expect(adapter.applyPatch).not.toHaveBeenCalled(); // healthy => no churn
    await d.dispose();
  });

  it("reassertTick is a no-op when injection is OFF", async () => {
    const adapter = { ...mkAdapter(), isPatched: vi.fn(() => false) };
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.reassertTick();              // never turned on
    expect(adapter.applyPatch).not.toHaveBeenCalled();
  });

  it("auth row is 'Sign in' when signed out (right under GET PAID OUT); runs the signIn command", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(false));
    let captured: { id: string; label: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => {
        captured = items as { id: string; label: string }[];
        return captured.find((i) => i.id === "signin");
      });
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    // GET PAID OUT $$$ owns the very top row; the auth flip sits directly
    // under it.
    expect(captured[0].id).toBe("getpaid");
    expect(captured[1].id).toBe("signin");
    expect(captured[1].label).toMatch(/sign in/i);
    expect(captured.some((i) => i.id === "signout")).toBe(false);
    expect(exec).toHaveBeenCalledWith("kickbacks.signIn");
    qp.mockRestore(); exec.mockRestore();
  });

  it("auth row flips between Sign in / Sign out by auth state and dispatches the right command", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    let captured: { id: string; label: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => {
        captured = items as { id: string; label: string }[];
        return captured.find((i) => i.id === "signout");
      });
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    // Auth row is the signed-in user's Sign out action — the identity
    // appears INLINE (label or description), not as a separate row.
    // signin must NOT appear when already signed in.
    expect(captured[0].id).toBe("getpaid");
    expect(captured[1].id).toBe("signout");
    expect(captured[1].label).toMatch(/sign out/i);
    expect(captured.some((i) => i.id === "signin")).toBe(false);
    expect(captured.some((i) => i.id === "__identity")).toBe(false);
    expect(exec).toHaveBeenCalledWith("kickbacks.signOut");
    qp.mockRestore(); exec.mockRestore();
  });

  it("GET PAID OUT $$$ is the menu's first row and opens the earnings portal", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    _opened.length = 0;
    let captured: { id: string; label: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => {
        captured = items as { id: string; label: string }[];
        return captured.find((i) => i.id === "getpaid");
      });
    await d.openMenu();
    expect(captured[0].id).toBe("getpaid");
    expect(captured[0].label).toMatch(/GET PAID OUT \$\$\$/);
    expect(_opened).toContain("https://kickbacks.ai/me");
    qp.mockRestore();
  });

  it("GET PAID OUT $$$ stays on top even when auth never initialised", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    let captured: { id: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => { captured = items as { id: string }[]; return undefined; });
    await d.openMenu();
    expect(captured[0].id).toBe("getpaid");
    qp.mockRestore();
  });

  it("W2 menu shape: required items present, deprecated ones absent", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    let captured: { id?: string; label?: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => {
        captured = items as { id?: string; label?: string }[]; return undefined;
      });
    await d.openMenu();
    const ids = captured.map((i) => i.id);
    // Required
    expect(ids).toContain("toggle");
    expect(ids).toContain("config");
    expect(ids).toContain("reapply");
    expect(ids).toContain("reload");
    expect(ids).toContain("restore");
    expect(ids).toContain("openlog");
    expect(ids).toContain("builtinfo");
    // Removed: msg (rolled into config.json), plus W2-era wv/cli/diag/banner/status
    expect(ids).not.toContain("msg");
    expect(ids).not.toContain("wv");
    expect(ids).not.toContain("cli");
    expect(ids).not.toContain("diag");
    expect(ids).not.toContain("banner");
    expect(ids).not.toContain("status");
    // Toggle label reflects state
    const toggleLabel = captured.find((i) => i.id === "toggle")?.label || "";
    expect(toggleLabel).toMatch(/enable|disable/i);
    expect(toggleLabel).toMatch(/kickbacks/i);
    qp.mockRestore();
  });

  it("consolidated re-apply fires BOTH CC reassert and Codex reassert", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    const ccReassert = vi.fn();
    const codexReassert = vi.fn();
    d.setReassert(ccReassert);
    d.setReassertCodex(codexReassert);
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) =>
        (items as { id?: string }[]).find((i) => i.id === "reapply"));
    await d.openMenu();
    expect(ccReassert).toHaveBeenCalled();
    expect(codexReassert).toHaveBeenCalled();
    qp.mockRestore();
  });

  it("menu omits the auth item entirely when auth is unavailable", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    let captured: { id: string }[] = [];
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) => { captured = items as { id: string }[]; return undefined; });
    await d.openMenu();
    expect(captured.some((i) => i.id === "signin" || i.id === "signout")).toBe(false);
    qp.mockRestore();
  });

  it("setText live re-applies only while injection is on", async () => {
    const adapter = mkAdapter();
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.setText("off-text");
    expect(adapter.applyPatch).not.toHaveBeenCalled();
    await d.setOn(true);
    await d.setText("on-text");
    expect(adapter.applyPatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ adText: "on-text" }));
    await d.dispose();
  });

  // ─── Tiered auto-enable across sign-out → sign-in ─────────────────────
  // Regression: signing out forces K_ON=false; pre-fix the sign-in gate only
  // re-enabled on neverToggled(), so once you'd signed out you stayed disabled
  // forever. doSignOut() now remembers the pre-sign-out state so the next
  // sign-in can restore it — while still respecting a deliberate disable.
  it("shouldAutoEnableOnSignIn: Tier 1 — true for a first-run user (never toggled)", () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    expect(d.neverToggled()).toBe(true);
    expect(d.shouldAutoEnableOnSignIn()).toBe(true);
  });

  it("shouldAutoEnableOnSignIn: Tier 2 — true after signing out while injection was ON", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);            // user is running ads
    await d.doSignOut();            // forces K_ON=false, remembers it was ON
    expect(d.on()).toBe(false);
    expect(d.neverToggled()).toBe(false);          // K_ON is defined now
    expect(d.shouldAutoEnableOnSignIn()).toBe(true); // …but Tier 2 fires
    await d.dispose();
  });

  it("shouldAutoEnableOnSignIn: false when the user deliberately disabled, then signed out", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);
    await d.setOn(false);          // deliberate "Disable Kickbacks"
    await d.doSignOut();           // captures the OFF intent
    expect(d.shouldAutoEnableOnSignIn()).toBe(false); // stays off — respected
    await d.dispose();
  });

  it("setOn(false) clears the sign-out memory: a deliberate disable sticks across the next sign-in", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);
    await d.doSignOut();             // K_PRESIGNOUT=true (was ON)
    expect(d.shouldAutoEnableOnSignIn()).toBe(true);
    await d.setOn(false);            // deliberate disable AFTER the sign-out
    expect(d.shouldAutoEnableOnSignIn()).toBe(false); // stale memory cleared
    await d.dispose();
  });

  it("menu Restore is a deliberate disable: doRestore clears the sign-out memory too", async () => {
    // Audit fix-up (wave 2): doRestore set K_ON=false but left a stale
    // K_PRESIGNOUT=true, so the serving gate's enabled() input stayed true
    // and the 60s reassert re-patched the just-restored install.
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);
    await d.doSignOut();             // stale K_PRESIGNOUT=true
    await (d as unknown as { doRestore: () => Promise<void> }).doRestore();
    expect(d.on()).toBe(false);
    expect(d.shouldAutoEnableOnSignIn()).toBe(false);
    await d.dispose();
  });

  it("clearSignOutMemory consumes the one-shot intent", async () => {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    await d.setOn(true);
    await d.doSignOut();
    expect(d.shouldAutoEnableOnSignIn()).toBe(true);
    await d.clearSignOutMemory();
    // Flag gone; only the (still-false) K_ON remains, so no auto-enable.
    expect(d.shouldAutoEnableOnSignIn()).toBe(false);
    await d.dispose();
  });

  it("bannerOverride cycles server → on → off → server (modes sentinel)", async () => {
    const RH = process.env.HOME, RU = process.env.USERPROFILE;
    const tmp = mkdtempSync(join(tmpdir(), "vibe-dbg-"));
    process.env.HOME = tmp; process.env.USERPROFILE = tmp;
    try {
      const ctl = new DebugController(mkAdapter(), makeContext() as never, () => {});
      expect(ctl.bannerOverride()).toBe("server");
      await ctl.cycleBannerOverride();
      expect(ctl.bannerOverride()).toBe("on");
      expect(readFileSync(join(tmp, ".vibe-ads", "banner.mode"), "utf8").trim()).toBe("on");
      await ctl.cycleBannerOverride();
      expect(ctl.bannerOverride()).toBe("off");
      await ctl.cycleBannerOverride();
      expect(ctl.bannerOverride()).toBe("server");
      expect(existsSync(join(tmp, ".vibe-ads", "banner.mode"))).toBe(false);
    } finally {
      if (RH !== undefined) process.env.HOME = RH; else delete process.env.HOME;
      if (RU !== undefined) process.env.USERPROFILE = RU; else delete process.env.USERPROFILE;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Audit #7 (wave 3): one loopback server per extension host ────────────
describe("DebugController — shared loopback (audit #7)", () => {
  it("apply() reuses ONE Loopback across re-applies — no stop/re-mint that "
    + "would tear down the shared server", async () => {
    const adapter = mkAdapter();
    const d = new DebugController(adapter, makeContext() as never, () => {});
    await d.setOn(true);
    const lb1 = (d as unknown as { lb: Loopback | null }).lb;
    expect(lb1).toBeTruthy();
    expect(lb1!.isRunning()).toBe(true);
    await d.setText("re-applied text");      // live re-apply while ON
    const lb2 = (d as unknown as { lb: Loopback | null }).lb;
    expect(lb2, "pre-fix: a fresh Loopback was minted per apply").toBe(lb1);
    expect(lb1!.isRunning()).toBe(true);     // the bound server survived
    await d.dispose();
  });

  it("apply() shares an existing production loopback (same port, no "
    + "EADDRINUSE→port+1) and never displaces its handlers; dispose() leaves "
    + "the production server running", async () => {
    const ctx = makeContext();
    // The production loopback boots first (K_ON=false boot)…
    const prodLb = new Loopback({
      onEvent: () => {}, onClick: () => {}, getActivity: () => ({}),
      getCurrentAd: () => ({ adText: "prod-ad", clickUrl: "https://p.test",
        iconUrl: "", adId: "prod", campaignId: "prod" }),
    });
    const prod = await bootLoopback(prodLb, ctx as never);
    expect(prod.port).toBeGreaterThan(0);
    // …then the user enables Kickbacks → debug apply().
    const adapter = mkAdapter();
    const d = new DebugController(adapter, ctx as never, () => {});
    await d.setOn(true);
    const calls = adapter.applyPatch.mock.calls as unknown as
      [{ loopbackPort: number; loopbackBase: string }][];
    const params = calls[calls.length - 1][0];
    expect(params.loopbackPort, "pre-fix: bound prod.port + 1")
      .toBe(prod.port);
    expect(params.loopbackBase).toBe(prod.base);
    // Production wiring (the billing authority) keeps the routes.
    const ad = await (await fetch(`${prod.base}/ad`)).json();
    expect(ad.adId).toBe("prod");
    // The debug controller never owned the server — its dispose must not
    // tear down production traffic.
    await d.dispose();
    expect(prodLb.isRunning()).toBe(true);
    await prodLb.stop();
  });

  it("the debug loopback's /ad stays canServeAds-gated (wave-2 contract "
    + "preserved in the sharing design)", async () => {
    const adapter = mkAdapter();
    const d = new DebugController(adapter, makeContext() as never, () => {});
    d.setPortfolioAd("Debug ad", "https://d.test");
    await d.setOn(true);
    const calls = adapter.applyPatch.mock.calls as unknown as
      [{ loopbackBase: string }][];
    const params = calls[calls.length - 1][0];
    const served = await (await fetch(`${params.loopbackBase}/ad`)).json();
    expect(served.adText).toBe("Debug ad");
    setKillPosture("confirmed");             // confirmed kill ⇒ stop serving
    const gated = await (await fetch(`${params.loopbackBase}/ad`)).json();
    expect(gated).toEqual({});
    await d.dispose();
  });
});

describe("DebugController — restart/open-log routing (W2 menu)", () => {
  function mkDbg() {
    const d = new DebugController(mkAdapter(), makeContext() as never, () => {});
    d.setAuth(authHook(true));
    return d;
  }

  it("reload entry restarts the extension host", async () => {
    const d = mkDbg();
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) =>
        (items as { id?: string }[]).find((i) => i.id === "reload"));
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    expect(exec).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    qp.mockRestore(); exec.mockRestore();
  });

  it("openlog entry opens the debug log file", async () => {
    const d = mkDbg();
    const qp = vi.spyOn(window, "showQuickPick").mockImplementation(
      async (items: unknown) =>
        (items as { id?: string }[]).find((i) => i.id === "openlog"));
    const exec = vi.spyOn(commands, "executeCommand");
    await d.openMenu();
    expect(exec).toHaveBeenCalledWith("vscode.open", expect.anything());
    qp.mockRestore(); exec.mockRestore();
  });
});
