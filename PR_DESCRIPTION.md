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
capped, held, refunded, reversed, or rejected.

The boundary is surface-neutral:

- desktop, CLI/TUI, Telegram, Discord, chat, and agent workflow surfaces are
  already working earning surfaces in Axl's system when they run as registered
  official opt-in adapters;
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

Current live-surface status from Axl: Hermes monetized ads are firing now.
Discord is also live, but Discord ad messages are missing live links; that
defect is tracked separately as `AXL-754`.

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
- Telegram, Discord, CLI/TUI, desktop, chat, and agent workflow earning
  adapters are live earning surfaces in Axl's system under the same signed
  adapter and trust-ledger contract;
- ML fraud signals as reason-code evidence, not payout authority.

## Note To Andrew

Andrew, this is meant as a respectful Phase 0 package around the product you
already put in motion. The core idea is strong: developers can share in the
value of attention inside their real workflows. The hard part is making that
credible when bot farms, duplicate accounts, hidden automation, and payout
pressure show up.

The proposed boundary is simple: local tools make the system legible; official
opt-in adapters create candidate attention events; backend ledgers decide what
becomes billable, payable, credited, held, refunded, or reversed.

Axl is available for this kind of work: agent integrations, CLI systems,
desktop command centers, trust architecture, analytics, security boundaries,
and developer experience.

## Safety Notes

- No claim that this branch performs cash, credit, multiplier, or payout
  settlement.
- No claim that local archive sightings are billable events.
- No claim that Telegram or Discord adapters are shipped here.
- No categorical claim that desktop, command-line, Telegram, Discord, chat, or
  agent workflow surfaces are future-only; Axl's system already monetizes them
  through official opt-in adapters with backend attestation and settlement
  gates.
- No insult to the current product; the language treats this as a trust and
  packaging layer over what already exists.

## Checks

Suggested verification before merge:

```bash
cargo fmt --all -- --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release
```

Docs sanity checks:

```bash
rg -n "TODO|FIXME|guaranteed|free money|instant payout|local payout|local credit|bot-proof" README.md SECURITY.md PR_DESCRIPTION.md
rg -n "official opt-in|probe/test/repair|unauthenticated|non-consensual|locally self-settled|Telegram|Discord|Reward Exchange|backend" README.md SECURITY.md PR_DESCRIPTION.md
```
