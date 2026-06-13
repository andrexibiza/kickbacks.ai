import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveAsset(baseDir: string, subpath: string, ...names: [string, ...string[]]): string {
  for (const name of names) {
    const cands = [join(baseDir, name), join(baseDir, subpath, name)];
    for (const c of cands) if (existsSync(c)) return c;
  }
  return join(baseDir, names[0]);
}
