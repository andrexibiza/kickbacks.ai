import type { Loopback } from "../loopback";
import type { DebugController } from "../debug";
import type { TargetAdapter } from "../adapters/types";
import type { ClaudeCliStatuslineAdapter } from "../adapters/claude-cli/adapter";
import type { CodexCliWrapperAdapter } from "../adapters/codex-cli/adapter";

/** Mutable activation-lifetime state shared by the extracted subsystems
 *  and the extension.ts orchestrator. Created once in `activate()` and
 *  disposed in `deactivate()`. Replaces the former module-scope `let`
 *  variables so all mutable state is bundled in a single object. */
export interface ActivationContext {
  timers: NodeJS.Timeout[];
  loopback: Loopback | null;
  debugCtl: DebugController | null;
  cliStatus: ClaudeCliStatuslineAdapter | null;
  codexCliStatus: CodexCliWrapperAdapter | null;
  ccAdapter: TargetAdapter | null;
  codexAdapter: TargetAdapter | null;
  lastCliAdId: string | null;
  lastCliSpinnerAdId: string | null;
}

/** Create a fresh ActivationContext with all fields at their initial
 *  (empty / null) values. */
export function createActivationContext(): ActivationContext {
  return {
    timers: [],
    loopback: null,
    debugCtl: null,
    cliStatus: null,
    codexCliStatus: null,
    ccAdapter: null,
    codexAdapter: null,
    lastCliAdId: null,
    lastCliSpinnerAdId: null,
  };
}
