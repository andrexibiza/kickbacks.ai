// Shared fetch wrapper that applies a request timeout (audit 2A-01 / EXT-04 /
// 2J-09). None of the extension's HTTP clients passed an AbortSignal, so a
// black-holed backend connection (no FIN, slow drip) would hang forever:
// activation awaits portfolio + killswitch serially, the auth refresh
// single-flight parks every later caller behind the one stuck promise, and
// stuck keep-alive sockets accumulate against the 30s/60s/90s timers.
//
// Each client takes an injectable `f: Fetch` (tests pass a mock); only the
// DEFAULT is wrapped, so production gets a timeout while test injection is
// unchanged. A caller that supplies its own `signal` keeps it.

type Fetch = typeof fetch;

export function timeoutFetch(ms: number): Fetch {
  return ((input: any, init?: any) => {
    const existing = init && init.signal;
    let signal = existing;
    if (!signal) {
      try {
        // Node 18+/modern Electron expose AbortSignal.timeout; guard so an
        // older host degrades to the prior (no-timeout) behaviour rather than
        // throwing during activation.
        signal = (AbortSignal as any).timeout
          ? (AbortSignal as any).timeout(ms)
          : undefined;
      } catch {
        signal = undefined;
      }
    }
    return fetch(input, { ...(init || {}), signal });
  }) as Fetch;
}
