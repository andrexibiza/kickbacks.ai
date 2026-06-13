// Faithful miniature of the real Codex chunk
// (openai.chatgpt-26.513.21555 / webview/assets/thinking-shimmer-BcRunliI.js):
// entry component `v` re-exported `as n`, generic wrapper `g` `as t`, the
// React-Compiler memo cache `(0,l.c)(N)`, the `({className,message,...}=e)`
// destructure, the i18n `thinkingShimmer.default` / `Thinking` anchor, and the
// `(0,d.jsx)` / `(0,d.jsxs)` runtime calls. Read as TEXT by the adapter tests
// (never executed) — the imports are shape, not live modules.
import { t as n } from "./jsx-runtime-Do_qqm2M.js";
import { t as r } from "./compiler-runtime-DAZMUUJC.js";
import { a as i } from "./lib-BFqEcoZz.js";
import { c as s } from "./spinner-CuTKgRAj.js";
var l = r(), d = n();
function g(e){
  let t = (0, l.c)(5), n, r, a;
  ({ className: r, children: n, ...a } = e);
  return (0, d.jsxs)(`span`, { className: r, ...a, children: [n] });
}
function v(e){
  let t = (0, l.c)(12), n, r, a;
  t[0] === e ? (n = t[1], r = t[2], a = t[3])
    : ({ className: n, message: r, ...a } = e, t[0] = e, t[1] = n, t[2] = r, t[3] = a);
  let o;
  t[4] === n ? o = t[5] : (o = s(`text-size-chat truncate`, n), t[4] = n, t[5] = o);
  let c;
  t[6] === r ? c = t[7]
    : (c = r ?? (0, d.jsx)(i, {id:`thinkingShimmer.default`,defaultMessage:`Thinking`,description:`Default placeholder shown while the assistant is thinking`}), t[6] = r, t[7] = c);
  let u;
  return t[8] !== a || t[9] !== o || t[10] !== c
    ? (u = (0, d.jsx)(g, { className: o, ...a, children: c }), t[8] = a, t[9] = o, t[10] = c, t[11] = u)
    : u = t[11], u;
}
export { v as n, g as t };
