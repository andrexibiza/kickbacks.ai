// Global vitest setup. The one job here is keeping every test file hermetic
// against the developer's real ~/.vibe-ads/debug.log.
//
// Background: ../src/log.dlog() appends a line to ~/.vibe-ads/debug.log
// whenever debugEnabled() returns true (sentinel file, env var, or
// config.debugMode). Any test that drives activate(), DebugController, or
// the Claude Code adapter therefore writes into the dev machine's *real*
// log, interleaving "build dev" / "9.9.9" preflight noise with the user's
// live extension events. That noise was misread once as an extension-host
// restart loop. Mocking the log module process-wide stops that at the
// source without each test having to remember to opt in.
import { vi } from "vitest";

vi.mock("../src/log", () => ({
  debugEnabled: () => false,
  dlog: () => {},
  dlogRaw: () => {},
  debugIconDataUri: () => "",
  codexEnabled: () => false,
  codexDisabled: () => false,
  codexCliEnabled: () => false,
  testHooksEnabled: () => true,
  LOG_PATH: "/tmp/test-log",
}));
