import { timeoutFetch } from "../util/http";

type Fetch = typeof fetch;

export interface ConsentState {
  telemetryOptIn: boolean;
  tosAcceptedVersion: string | null;
  currentTosVersion: string;
}

/** Backend-facing consent shim (wave-2I-F03). Mirrors the EarningsClient
 *  fail-safe pattern: any error => null. Never throws into activation. */
export class ConsentClient {
  constructor(
    private base: string,
    private token: () => string | null,
    // audit-2026-06-09 #38: was bare `fetch` — the only client whose DEFAULT
    // bypassed the 2A-01 timeout wrapper. Consent is two tiny calls; 30s is
    // a generous budget for the user-blocking Agree POST.
    private f: Fetch = timeoutFetch(30000),
  ) {}

  async read(): Promise<ConsentState | null> {
    try {
      const t = this.token();
      if (!t) return null;
      const r = await this.f(`${this.base}/v1/me/consent`,
        { headers: { authorization: `Bearer ${t}` } });
      if (!r.ok) return null;
      const j = await r.json() as {
        telemetry_opt_in?: boolean;
        tos_accepted_version?: string | null;
        current_tos_version?: string;
      };
      if (typeof j.current_tos_version !== "string") return null;
      return {
        telemetryOptIn: !!j.telemetry_opt_in,
        tosAcceptedVersion: typeof j.tos_accepted_version === "string"
          ? j.tos_accepted_version
          : null,
        currentTosVersion: j.current_tos_version,
      };
    } catch { return null; }
  }

  async accept(): Promise<{ tosVersion: string; acceptedAt: string } | null> {
    try {
      const t = this.token();
      if (!t) return null;
      const r = await this.f(`${this.base}/v1/me/consent`,
        { method: "POST", headers: { authorization: `Bearer ${t}` } });
      if (!r.ok) return null;
      const j = await r.json() as {
        tos_version?: string;
        accepted_at?: string;
      };
      if (typeof j.tos_version !== "string"
          || typeof j.accepted_at !== "string") return null;
      return { tosVersion: j.tos_version, acceptedAt: j.accepted_at };
    } catch { return null; }
  }
}
