# Phase 0 MVP: desktop command center and advertiser assurance package

## Summary

This PR turns `kickbacks-kit` from a TUI-first companion into a Phase 0 local
command center for Kickback.ai. It leads with verified developer activity,
official opt-in earning adapters, Trust Engine state, and advertiser assurance,
while preserving the local archive/TUI as useful evidence below the product
pitch.

It builds on what Kickback.ai already shipped rather than dismissing it. The
extension and payout promise are the foundation; this package makes the trust
boundary explicit enough for real users, advertisers, and backend work.

## Why this matters

Bot pressure is not just an abuse edge case for Kickback.ai. It is the product
boundary. Real developers should be able to earn from attention inside their
actual workflows, and advertisers should be able to see why paid reach is real,
capped, held, accepted, refunded, fraudulent, or rejected.

The boundary is surface-neutral:

- desktop, CLI/TUI, Telegram, Discord, chat, and agent workflow surfaces may be
  earning surfaces only when they run as registered official opt-in adapters;
- every agent interaction with developer attention is a possible advertising
  opportunity only when it is an official opt-in adapter with proof and backend
  settlement;
- official adapters create candidate attention events with consent, visibility
  proof, authentication, caps, and backend receipts;
- dashboard, doctor, repair, installer, tests, generated notes, local archive
  rows, and unauthenticated chat output remain non-earning probes;
- backend ledgers decide advertiser billing, refunds, holds, reversals, credits,
  payout readiness, and settlement;
- advertiser assurance reports separate gross events, held events, rejected or
  fraudulent events, refunds, final billable reach, and released payouts.

Forbidden paths stay forbidden: fabricated, hidden, probe/test/repair,
unauthenticated, non-consensual, or locally self-settled billing.

External earning surfaces are outside this repository's verification scope.
Phase 0 defines the contract those surfaces must satisfy before Kickback.ai can
treat them as earning inventory: registered official adapters, explicit user
controls, proof, backend acceptance, refund windows, and settlement gates.

This is also a documentation and security hardening event. The pitch needs to
name why the trust layer matters now: attackers are already testing realistic
multi-window impression traffic, loopback-readable tokens are not attention
proof, third-party anchors can drift, and Stripe Connect plus tax/reporting
requirements make raw cash payouts an operations problem rather than just a
button in the UI.

## Shipped Locally

- README now opens with verified developer activity, desktop command center,
  optional opt-in monetization boundaries, official adapter proof, Trust Engine,
  and advertiser assurance.
- The old local archive/TUI companion story is preserved as archive behavior
  below the product pitch, not as the whole company story.
- `kb app`, `kb trust`, sync freshness, install/repair, agent wrappers, Hermes,
  skills, and archive/TUI surfaces are documented as shipped local controls.
- SECURITY.md documents trust boundaries for local controls, official adapters,
  backend settlement, Stripe/vendor credit rails, ML/bot signals, Hermes/chat
  privacy, installer/repair safety, and disclosure.
- Reward Exchange is documented as backend roadmap: cash, optional
  sponsor-funded credits, blended rewards, multipliers, linked vendor accounts,
  holds, and reversals.

## Roadmap Clarified

The docs deliberately separate shipped local behavior from backend-owned product
work:

- official opt-in adapter receipts for every monetized surface;
- append-only classification, attestation, refund, reward, reversal, and payout
  hold ledgers;
- backend settlement for cash, sponsor-funded credits, and Reward Exchange;
- Stripe Connect and vendor credit rails on the backend;
- official Stripe Connect policy carried into the docs: account type and
  controller responsibility affect fraud, abuse, negative-balance, and identity
  verification liability; KYC requirements can pause charges or payouts; and
  product copy must avoid traffic-resale or easy-money positioning;
- Telegram, Discord, CLI/TUI, desktop, chat, and agent workflow earning
  adapters belong behind the same signed adapter and trust-ledger contract;
- ML fraud signals as reason-code evidence, not payout authority.

## Note To Andrew

Andrew, this is meant as a respectful Phase 0 package around the product you
already put in motion. The core idea is strong: developers can share in the
value of attention inside their real workflows. The hard part is making that
credible when bot farms, duplicate accounts, hidden automation, and payout
pressure show up.

The proposed boundary is simple: local tools make the system legible; official
opt-in adapters create candidate attention events; backend ledgers decide what
can become `backend_accepted`, `accepted_billable_after_refund_window`,
`refunded`, `fraudulent`, `rejected`, or `paid`.

I am Axl Ibiza. I have a Finance MBA from Johnson & Wales University, and my
lane is the corporate, finance-driven layer Kickback.ai now needs: agent
integrations, CLI systems, desktop command centers, trust architecture,
analytics, compliance boundaries, security hardening, and developer experience.

The founder dynamic is the strength here. You can keep being the fast,
boundary-pushing builder. I can build the layer that makes the product survive
contact with scale: audit trails, state machines, cap logic, payout/reversal
boundaries, international Stripe readiness, and the security posture that cannot
be bolted on later because later is where the expensive disasters live.

## Safety Notes

- No claim that this branch performs cash, credit, multiplier, or payout
  settlement.
- No claim that local archive sightings are billable events.
- No claim that the local repo alone ships or settles Telegram, Discord,
  Hermes, desktop, CLI/TUI, chat, or agent workflow earning adapters.
- No categorical claim that those surfaces can never monetize; when an external
  surface is reported live, the docs still keep it behind official adapters,
  backend attestation, and settlement gates.
- No claim that loopback-readable tokens, realistic saturation traffic, or
  brittle third-party anchors are acceptable earning proof; they are hard-stop
  threats handled by signed adapters, server-side nonces, duty-cycle and strict
  concurrency checks, human-in-the-loop ML review, and backend settlement
  ledgers.
- No claim that Stripe approval, account onboarding, or payout readiness is
  final trust authority. Stripe is a payout rail and compliance input; backend
  ledgers still own fraud review, refund windows, holds, and settlement.
- No product positioning that treats Kickback.ai as resale of online traffic or
  engagement, guaranteed rewards, unrealistic incentives, or fast/easy money.
- No invasive IDE patching architecture: adapters should use supported IDE APIs,
  avoid storing long-lived bearer material in extension global state or
  workspace settings, and fail closed on unsigned updates, publisher mismatch,
  or compatibility-manifest drift.
- No insult to the current product; the language treats this as a trust and
  packaging layer over the existing upstream surface.

## Phase roadmap

- Phase 0 ships the local desktop control plane, installer/repair, Hermes,
  Claude, Codex, Trust Engine reporting, sync freshness, developer note, and
  archive/TUI companion.
- Phases 1-6 are backend trust work: official adapter receipts, event ledgers,
  advertiser assurance, Stripe payout readiness, deterministic review, and ML
  risk signals that never become settlement authority by themselves.
- Loopback token replay, realistic saturation traffic, and brittle
  client-side anchoring are explicit Phase 1-6 abuse cases: they require
  server-issued single-use nonces, replay ledgers, aggregate account-level
  checks, duty-cycle heuristics, strict concurrency limits, signed
  compatibility manifests, and fail-closed adapter preflights.
- Phase 7 is Reward Exchange, with cash still first-class and sponsor-funded
  credits optional, offer-based, backend-ledgered, held, reversible, and clearly
  labeled as credits.
- Phase 8 keeps nonlocal and messaging surfaces, including CLI/TUI, desktop,
  Hermes, Telegram, Discord, chat, and agent workflow surfaces, behind the same
  attestation, cap, hold, refund, reversal, user-control, and advertiser
  assurance requirements.
- Phases 9-10 cover backend-provided account/reward snapshots, audit exports,
  incident response, and responsible disclosure loops.

## Checks

Verified locally at `2026-06-12 19:11`:

```bash
cargo fmt --all -- --check                         # passed
git diff --check                                   # passed
rg -n "<{7}|={7}|>{7}" README.md SECURITY.md TRUST_ENGINE.md PR_DESCRIPTION.md src/app.rs src/trust_engine.rs src/main.rs src/install_system.rs Cargo.toml
                                                     # no matches
CARGO_TARGET_DIR=target\verify-full cargo test      # passed: kb 130 passed, 0 failed, 1 ignored; kickbacks 130 passed, 0 failed, 1 ignored
CARGO_TARGET_DIR=target\verify-clippy cargo clippy --all-targets -- -D warnings
                                                     # passed
CARGO_TARGET_DIR=target\verify-release cargo build --release
                                                     # passed
```

Additional targeted self-improvement gates:

```bash
CARGO_TARGET_DIR=target\verify-app-now cargo test app::tests -- --nocapture
                                                     # passed: kb 9 passed; kickbacks 9 passed
CARGO_TARGET_DIR=target\verify-trust-now cargo test trust_engine -- --nocapture
                                                     # passed: kb 12 passed; kickbacks 12 passed
```
