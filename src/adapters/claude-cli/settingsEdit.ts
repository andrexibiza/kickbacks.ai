/** Minimal-edit, JSONC-tolerant editing of ~/.claude/settings.json.
 *  We mutate RAW TEXT (never re-serialize) so the user's comments,
 *  whitespace and key order survive. A tiny state machine walks the raw
 *  bytes tracking string/line-comment/block-comment context. */

type Ctx = "code" | "str" | "line" | "block";

/** Strip JSONC comments + a single trailing comma before } or ] so we can
 *  validate with JSON.parse. Used ONLY for parse/idempotency checks, never
 *  for the emitted text. */
function stripJsonc(src: string): string {
  let out = "", ctx: Ctx = "code", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (ctx === "code") {
      if (c === '"') { ctx = "str"; out += c; i++; continue; }
      if (c === "/" && n === "/") { ctx = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { ctx = "block"; i += 2; continue; }
      out += c; i++; continue;
    }
    if (ctx === "str") {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') ctx = "code";
      i++; continue;
    }
    if (ctx === "line") { if (c === "\n") { ctx = "code"; out += c; } i++; continue; }
    // block
    if (c === "*" && n === "/") { ctx = "code"; i += 2; continue; }
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseable(src: string): boolean {
  try { JSON.parse(stripJsonc(src)); return true; } catch { return false; }
}

/** Find the [start,end) raw-text span of the VALUE of a top-level `key`, or
 *  null if the key is absent. Comment/string aware; only depth-1 keys (direct
 *  children of the root object) match. Throws if the text is not parseable
 *  as JSONC. */
function findTopLevelValueSpan(src: string, key: string): [number, number] | null {
  if (!parseable(src)) throw new Error("settings.json not parseable");
  let ctx: Ctx = "code", depth = 0, i = 0;
  let pendingKey: string | null = null, keyStart = -1;
  const skipWs = (j: number): number => {
    let c2: Ctx = "code";
    while (j < src.length) {
      const c = src[j], n = src[j + 1];
      if (c2 === "code") {
        if (c === "/" && n === "/") { c2 = "line"; j += 2; continue; }
        if (c === "/" && n === "*") { c2 = "block"; j += 2; continue; }
        if (/\s/.test(c) || c === ":") { j++; continue; }
        return j;
      }
      if (c2 === "line") { if (c === "\n") c2 = "code"; j++; continue; }
      if (c === "*" && n === "/") { c2 = "code"; j += 2; continue; }
      j++;
    }
    return j;
  };
  const valueEnd = (j: number): number => {
    // j points at first char of the value; consume one JSON value.
    let c2: Ctx = "code", d = 0;
    for (; j < src.length; j++) {
      const c = src[j], n = src[j + 1];
      if (c2 === "str") {
        if (c === "\\") { j++; continue; }
        if (c === '"') c2 = "code";
        continue;
      }
      if (c2 === "line") { if (c === "\n") c2 = "code"; continue; }
      if (c2 === "block") { if (c === "*" && n === "/") { c2 = "code"; j++; } continue; }
      if (c === '"') { c2 = "str"; continue; }
      if (c === "/" && n === "/") { c2 = "line"; j++; continue; }
      if (c === "/" && n === "*") { c2 = "block"; j++; continue; }
      if (c === "{" || c === "[") d++;
      else if (c === "}" || c === "]") { if (d === 0) return j; d--; }
      else if ((c === "," ) && d === 0) return j;
    }
    return j;
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (ctx === "str") {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') {
        ctx = "code";
        if (depth === 1) pendingKey = src.slice(keyStart + 1, i);
      }
      i++; continue;
    }
    if (ctx === "line") { if (c === "\n") ctx = "code"; i++; continue; }
    if (ctx === "block") { if (c === "*" && n === "/") { ctx = "code"; i += 2; continue; } i++; continue; }
    if (c === "/" && n === "/") { ctx = "line"; i += 2; continue; }
    if (c === "/" && n === "*") { ctx = "block"; i += 2; continue; }
    if (c === '"') { ctx = "str"; keyStart = i; i++; continue; }
    if (c === "{" || c === "[") { depth++; i++; continue; }
    if (c === "}" || c === "]") { depth--; i++; continue; }
    if (c === ":" && depth === 1 && pendingKey === key) {
      const vs = skipWs(i + 1);
      return [vs, valueEnd(vs)];
    }
    if (c === "," ) pendingKey = null;
    i++;
  }
  return null;
}

/** Parse and return the VALUE of a top-level `key`, or undefined when the
 *  key is absent or the text is not parseable. Read-only companion to
 *  `upsertTopLevel` — the CLI adapter uses it to capture a pre-existing
 *  user statusLine before taking the slot (chain-capture). */
export function readTopLevel(src: string, key: string): unknown {
  try {
    const span = findTopLevelValueSpan(src, key);
    if (!span) return undefined;
    return JSON.parse(stripJsonc(src.slice(span[0], span[1])));
  } catch { return undefined; }
}

/** Set the top-level `key` to `valueJson` (a JSON value string), editing only
 *  that span. Inserts the key right after the root `{` when absent.
 *  Idempotent. Throws if `src` is not parseable JSONC. */
function upsertTopLevel(src: string, key: string, valueJson: string): string {
  const span = findTopLevelValueSpan(src, key);
  if (span) {
    const next = src.slice(0, span[0]) + valueJson + src.slice(span[1]);
    return next;
  }
  const brace = src.indexOf("{");
  if (brace < 0) throw new Error("settings.json not parseable");
  const after = src.slice(brace + 1);
  const hasKeys = parseable(src) && /\S/.test(stripJsonc(after).replace(/[}\s]/g, ""));
  const insert = `\n  ${JSON.stringify(key)}: ${valueJson}${hasKeys ? "," : ""}`;
  return src.slice(0, brace + 1) + insert + after;
}

/** Set top-level "statusLine" to `valueJson`. See `upsertTopLevel`. */
export function upsertStatusLine(src: string, valueJson: string): string {
  return upsertTopLevel(src, "statusLine", valueJson);
}

/** Set top-level "spinnerVerbs" to `valueJson`. CC 2.1.143+ reads this at boot
 *  via the iTH() selector to override the default verb dictionary in the
 *  thinking-shimmer. Schema (from claude.exe at offset 217693700):
 *  `{ mode: "append" | "replace", verbs: string[] }`. See `upsertTopLevel`. */
export function upsertSpinnerVerbs(src: string, valueJson: string): string {
  return upsertTopLevel(src, "spinnerVerbs", valueJson);
}

/** Remove a top-level key (and its preceding comma, if any) from a JSONC
 *  settings file. Idempotent — returns `src` unchanged when the key is
 *  absent. Comment/string aware; preserves the user's other keys, their
 *  ordering, and their comments. Used to evict the spinnerVerbs entry
 *  the older CLI adapter wrote into settings.json — once it's gone CC
 *  falls back to its built-in verb dictionary and our webview block
 *  becomes the SINGLE ad-rendering surface (no plain-text fallback that
 *  silently masks a block.desync). */
export function removeTopLevel(src: string, key: string): string {
  let span: [number, number] | null;
  try { span = findTopLevelValueSpan(src, key); }
  catch { return src; }                            // not parseable → leave alone
  if (!span) return src;
  // Walk backward from the value span to consume the key, its colon,
  // and any leading whitespace + a single preceding comma; walk forward
  // to swallow a trailing comma (so removing a middle key doesn't leave
  // `{ "a": 1,, "b": 2 }`).
  let s = span[0];
  // Step back past whitespace + colon + whitespace + the key string.
  while (s > 0 && /\s/.test(src[s - 1])) s--;
  if (s > 0 && src[s - 1] === ":") s--;
  while (s > 0 && /\s/.test(src[s - 1])) s--;
  if (s > 0 && src[s - 1] === '"') {
    // Find the matching opening quote, respecting backslash escapes.
    let q = s - 2;
    while (q > 0) {
      if (src[q] === '"' && src[q - 1] !== "\\") break;
      q--;
    }
    s = q;
  }
  // Trailing comma + whitespace (or leading comma if no trailing one).
  let e = span[1];
  let trailingCommaConsumed = false;
  let j = e;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] === ",") { e = j + 1; trailingCommaConsumed = true; }
  if (trailingCommaConsumed) {
    // Also consume the whitespace run immediately before the key so removing
    // an entry upsertTopLevel inserted (`\n  "key": value,` right after the
    // root `{`) round-trips byte-exact — the CLI adapter's key-scoped
    // restore() relies on this to leave a never-edited settings.json exactly
    // as it was before applyPatch. Whitespace only: a comment between the
    // previous token and the key is never consumed.
    while (s > 0 && /\s/.test(src[s - 1])) s--;
  }
  if (!trailingCommaConsumed) {
    // No trailing comma → consume any leading comma + ws so the result
    // doesn't end with a dangling `, }`.
    let k = s;
    while (k > 0 && /\s/.test(src[k - 1])) k--;
    if (k > 0 && src[k - 1] === ",") s = k - 1;
  }
  return src.slice(0, s) + src.slice(e);
}

/** Remove the top-level "spinnerVerbs" entry. Convenience wrapper. */
export function removeSpinnerVerbs(src: string): string {
  return removeTopLevel(src, "spinnerVerbs");
}
