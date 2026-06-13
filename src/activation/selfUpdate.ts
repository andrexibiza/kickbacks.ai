import * as vscode from "vscode";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, statSync } from "node:fs";
import { UpdateClient, isNewer } from "../update/client";
import { timeoutFetch } from "../util/http";
import { buildVersion } from "../buildinfo";
import { dlog } from "../log";
import { errMsg } from "../util/errMsg";
import { DEFAULT_POLL_MS } from "../config";

const UPD_KEY = "vibe-ads.update.attempted";
const UPD_TRANSIENT_KEY = "vibe-ads.update.transient";
// Single-slot SUCCESS record {k, v, ts} (trey-nag-loop 2026-06-11): the
// artifact that last installed without throwing. Unlike the attempted ring
// it has NO cooldown — a successfully-installed artifact must never
// re-install/re-toast just because the user hasn't reloaded yet. A single
// slot (not a ring) keeps the rollback contract working: a rollback artifact
// differs from the latest success, so it is never suppressed by old history.
const UPD_INSTALLED_KEY = "vibe-ads.update.installed";
const UPD_COOLDOWN_MS = 30 * 60 * 1000;
const UPD_TRANSIENT_COOLDOWN_MS = 15 * 60 * 1000;
const UPD_RING_CAP = 16;

type InstalledRec = { k: string; v: string; ts: number };

function installedRec(ctx: vscode.ExtensionContext): InstalledRec | undefined {
  const raw = ctx.globalState.get<unknown>(UPD_INSTALLED_KEY) as
    InstalledRec | undefined;
  return raw && typeof raw.k === "string" && typeof raw.v === "string"
    ? raw : undefined;
}

type Ring = { k: string; ts: number }[];

function updKey(v: string, sha?: string): string {
  return sha ? `${v}@${sha.slice(0, 16)}` : v;
}

function ringGet(ctx: vscode.ExtensionContext, key: string): Ring {
  const raw = ctx.globalState.get<unknown>(key);
  return Array.isArray(raw) ? (raw as Ring).filter(
    (e) => e && typeof e.k === "string" && typeof e.ts === "number") : [];
}

function ringSeen(ctx: vscode.ExtensionContext, key: string, k: string, cooldown: number): boolean {
  const now = Date.now();
  return ringGet(ctx, key).some((e) => e.k === k && now - e.ts < cooldown);
}

function ringMark(ctx: vscode.ExtensionContext, key: string, k: string): void {
  const next = ringGet(ctx, key).filter((e) => e.k !== k);
  next.push({ k, ts: Date.now() });
  while (next.length > UPD_RING_CAP) next.shift();
  void ctx.globalState.update(key, next);
}

export interface SelfUpdateResult {
  updater: UpdateClient;
  installVsix: (vsix: ArrayBuffer) => Promise<void>;
}

export function setupSelfUpdate(
  ctx: vscode.ExtensionContext,
  updateBase: string,
  currentVersion: string,
  localVsixPath: string | undefined,
  lastLocalVsixMtime: number,
  watchFileFn: typeof import("node:fs").watchFile,
  timers: NodeJS.Timeout[],
  updatePollIntervalMs: number | undefined,
): SelfUpdateResult {
  // Convergence check: this runs at ACTIVATION, i.e. after a window
  // (re)load. If the build now running is still OLDER than the version we
  // recorded as successfully installed, the install did not actually take
  // (silent installExtension failure, rolled-back extensions dir, …) —
  // clear the record so the updater gets ONE fresh attempt per activation
  // (still rate-fenced by the attempted-ring cooldown), instead of being
  // suppressed forever on a build that never converged.
  {
    const rec = installedRec(ctx);
    if (rec && isNewer(rec.v, currentVersion)) {
      dlog("ext", "selfupdate.notconverged",
        { recorded: rec.v, running: currentVersion });
      void ctx.globalState.update(UPD_INSTALLED_KEY, undefined);
    }
  }

  const installVsix = async (vsix: ArrayBuffer): Promise<void> => {
    const p = join(tmpdir(), `vibe-ads-update-${Date.now()}.vsix`);
    writeFileSync(p, Buffer.from(vsix));
    await vscode.commands.executeCommand(
      "workbench.extensions.installExtension", vscode.Uri.file(p));
    // Re-arm injection for the new build, but PRESERVE a deliberate user
    // disable (audit EXT-01 / 2A-02). K_ON === false means the user explicitly
    // ran "Disable Kickbacks"; undefined/true means default-on or already-on.
    // The old unconditional `= true` stomped an explicit opt-out on every
    // self-update, so the only durable opt-out was uninstall.
    if (ctx.globalState.get<boolean>("kickbacks.debug.on") !== false) {
      await ctx.globalState.update("kickbacks.debug.on", true);
    }
    dlog("ext", "selfupdate.installed", { path: p });
    void (async () => {
      try {
        const choice = await vscode.window.showInformationMessage?.(
          "Kickbacks updated. Reload window to activate the new build?",
          { modal: false }, "Reload Window", "Later");
        dlog("ext", "selfupdate.toast", { choice: choice || "dismissed" });
        if (choice === "Reload Window") {
          // The reload tears this extension host down mid-await, so the
          // command "rejects" with Canceled on every successful reload —
          // swallow it here instead of logging a misleading toast.err.
          try {
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow");
          } catch { /* expected: host dies under us */ }
        }
      } catch (e) {
        dlog("ext", "selfupdate.toast.err",
          { msg: errMsg(e) });
      }
    })();
  };

  // Local-vsix watcher
  if (localVsixPath) {
    let localMtime = lastLocalVsixMtime;
    try {
      watchFileFn(localVsixPath, { interval: 2000 }, (curr) => {
        if (!curr.mtimeMs || curr.mtimeMs === localMtime) return;
        localMtime = curr.mtimeMs;
        try {
          const bytes = readFileSync(localVsixPath);
          dlog("ext", "selfupdate.local", { path: localVsixPath, bytes: bytes.length });
          void installVsix(bytes.buffer.slice(
            bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        } catch (e) {
          dlog("ext", "selfupdate.local.err",
            { msg: errMsg(e) });
        }
      });
    } catch { /* never block activation */ }
  }

  const onUpdateAvailable = (info: { version: string; current: string;
                                      rollback: boolean }) => {
    try {
      const msg = info.rollback
        ? `Kickbacks: rolling back to v${info.version} (from v${info.current})…`
        : `Kickbacks: v${info.version} available — installing now…`;
      void vscode.window.showInformationMessage?.(msg);
    } catch { /* toast best-effort */ }
  };

  // audit-2026-06-09 #38: passing bare global `fetch` here silently bypassed
  // the class's timeoutFetch(120000) default — a black-holed manifest/VSIX
  // connection (2A-01 hang class) would park checkOnce forever and, with the
  // #31 single-flight guard, wedge every later poll behind it. Same 120s
  // budget as the class default.
  const updater = new UpdateClient(updateBase, currentVersion,
      timeoutFetch(120000), installVsix, {
    attempted: (v, sha) => ringSeen(ctx, UPD_KEY, updKey(v, sha), UPD_COOLDOWN_MS),
    markAttempted: (v, sha) => { ringMark(ctx, UPD_KEY, updKey(v, sha)); },
    installed: (v, sha) => installedRec(ctx)?.k === updKey(v, sha),
    markInstalled: (v, sha) => {
      void ctx.globalState.update(UPD_INSTALLED_KEY,
        { k: updKey(v, sha), v, ts: Date.now() } satisfies InstalledRec);
    },
    transientFailed: (v, sha) =>
      ringSeen(ctx, UPD_TRANSIENT_KEY, updKey(v, sha), UPD_TRANSIENT_COOLDOWN_MS),
    markTransientFailed: (v, sha) => { ringMark(ctx, UPD_TRANSIENT_KEY, updKey(v, sha)); },
    recordLkg: (v, vsix) => {
      try {
        const lkgPath = join(tmpdir(), `kickbacks-lkg-${v}.vsix`);
        writeFileSync(lkgPath, vsix);
        void ctx.globalState.update("vibe-ads.update.lkg", { v, path: lkgPath });
      } catch { /* best-effort */ }
    },
  }, onUpdateAvailable);

  timers.push(setInterval(() => void updater.checkOnce(),
    updatePollIntervalMs || DEFAULT_POLL_MS));

  return { updater, installVsix };
}
