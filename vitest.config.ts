import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"],
          setupFiles: ["test/setup.ts"] },
  resolve: { alias: { vscode: resolve(__dirname, "test/mocks/vscode.ts") } },
});
