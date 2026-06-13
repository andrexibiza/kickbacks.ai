import { createHash } from "node:crypto";
export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
