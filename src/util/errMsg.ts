/** Extract a human-readable error message from an unknown throw value.
 *  Caps the result at `max` characters so log lines stay bounded. Used
 *  throughout the extension in place of the duplicated inline pattern. */
export function errMsg(e: unknown, max = 160): string {
  return String((e as { message?: string })?.message ?? e).slice(0, max);
}
