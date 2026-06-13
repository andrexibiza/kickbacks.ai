// Minimal hermetic mock of the `vscode` module surface S3 uses.
export const secrets = new Map<string, string>();
export const _opened: string[] = [];
// _shown: every showInformationMessage / showErrorMessage call, in order.
// Lets commands.test.ts assert that `kickbacks.status` produced the expected
// toast without having to spy() each handler individually.
export const _shown: { kind: "info" | "error"; text: string }[] = [];
// _warned: every showWarningMessage call, in order. Kept separate from _shown
// so adding warning capture never perturbs a test asserting on _shown counts.
export const _warned: string[] = [];
// _opened docs: every workspace.openTextDocument(path) call. Used to verify
// that `kickbacks.editConfig` actually opened the config file.
export const _openedDocs: string[] = [];
export const window = {
  createStatusBarItem: () => ({
    text: "", tooltip: "", command: "" as string | undefined,
    color: undefined as string | undefined,
    backgroundColor: undefined as ThemeColor | undefined,
    show() {}, hide() {}, dispose() {},
  }),
  showInformationMessage: async (msg: unknown, ..._rest: unknown[]) => {
    _shown.push({ kind: "info", text: String(msg) }); return undefined;
  },
  showErrorMessage: async (msg: unknown, ..._rest: unknown[]) => {
    _shown.push({ kind: "error", text: String(msg) }); return undefined;
  },
  showWarningMessage: async (msg: unknown, ..._rest: unknown[]) => {
    _warned.push(String(msg)); return undefined;
  },
  showQuickPick: async (_items: unknown[], _o?: unknown) => undefined as unknown,
  showInputBox: async (_o?: unknown) => undefined as string | undefined,
  showTextDocument: async (_doc: unknown, _o?: unknown) => undefined as unknown,
};
export const workspace = {
  openTextDocument: async (p: unknown) => {
    const path = typeof p === "string" ? p
      : (p as { fsPath?: string; toString(): string })?.fsPath
        ?? (p as { toString(): string }).toString();
    _openedDocs.push(path);
    return { uri: { fsPath: path }, getText: () => "" };
  },
};
export const env = {
  openExternal: async (u: { toString(): string }) => { _opened.push(u.toString()); return true; },
  // Remote port-forwarding tunnel; identity in tests/local desktop.
  asExternalUri: async (u: { toString(): string }) => u,
  clipboard: {
    _last: "" as string,
    writeText: async function (t: string) { this._last = t; },
  },
};
export const commands = {
  _handlers: new Map<string, (...a: unknown[]) => unknown>(),
  // Every executeCommand call, in order. Useful when a handler delegates
  // (e.g. the debug menu's "Sign in" item executes "kickbacks.signIn").
  _executed: [] as { id: string; args: unknown[] }[],
  registerCommand(id: string, h: (...a: unknown[]) => unknown) {
    this._handlers.set(id, h); return { dispose() {} };
  },
  // Dispatch to a registered handler when present so tests can drive the
  // exact command pipeline VS Code itself would. Unknown ids (e.g.
  // "workbench.action.restartExtensionHost") fall through to undefined,
  // matching the pre-dispatch behavior — extension code that fires them
  // for side effect keeps working in tests.
  async executeCommand(id: string, ...args: unknown[]) {
    commands._executed.push({ id, args });
    const h = commands._handlers.get(id);
    if (!h) return undefined;
    return await h(...args);
  },
};
export const Uri = {
  parse: (s: string) => ({ toString: () => s }),
  file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
};
export const QuickPickItemKind = { Default: 0, Separator: -1 };
// Theme-token reference (e.g. "statusBarItem.errorBackground"); the mock just
// records the id so tests can assert which token a surface painted with.
export class ThemeColor { constructor(public readonly id: string) {} }
export class EventEmitter<T> { event = (_l: (e: T) => void) => ({ dispose() {} }); fire(_e: T) {} }
export const StatusBarAlignment = { Left: 1, Right: 2 };
export interface ExtensionContext {
  secrets: { get(k: string): Thenable<string | undefined>;
             store(k: string, v: string): Thenable<void>;
             delete(k: string): Thenable<void>; };
  globalState: { get<T>(k: string): T | undefined; update(k: string, v: unknown): Thenable<void> };
  subscriptions: { dispose(): void }[];
}
export function makeContext(): ExtensionContext {
  const gs = new Map<string, unknown>();
  return {
    secrets: {
      get: async (k) => secrets.get(k),
      store: async (k, v) => { secrets.set(k, v); },
      delete: async (k) => { secrets.delete(k); },
    },
    globalState: { get: <T>(k: string) => gs.get(k) as T | undefined,
                   update: async (k, v) => { gs.set(k, v); } },
    subscriptions: [],
  };
}
