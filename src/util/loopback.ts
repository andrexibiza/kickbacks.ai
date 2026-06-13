/** Loopback-base check used by extension.ts to refuse non-loopback HTTP
 *  bases (wave-2B-F01).
 *
 *  `new URL(base).hostname` handles `[::1]` bracket-stripping natively.
 *  Never throws (malformed URL => not loopback => safe-closed). */
export function isLoopbackBase(base: string): boolean {
  try {
    const host = (new URL(base).hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
