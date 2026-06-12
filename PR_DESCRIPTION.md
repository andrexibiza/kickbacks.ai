# Phase 0 MVP: desktop trust console and advertiser assurance package

## Summary

This PR turns `kickbacks-kit` from a TUI-first companion into a Phase 0 local
control plane for Kickbacks.ai: developer activity stays grounded in official
earning adapters, the desktop console shows local install and ledger evidence,
and the Trust Engine explains what advertisers can audit before payouts or
credits become final.

It builds on what Kickbacks already shipped rather than dismissing it. The
extension and payout promise are the important foundation; this package makes the
trust boundary explicit enough for real users, advertisers, and future backend
work.

## Why this matters

Bot pressure is not just an abuse edge case for Kickbacks. It is the product
boundary. Real developers should be able to earn without bots draining
advertisers, and advertisers should see why paid reach is real, capped, held,
refunded, reversed, or rejected.

This PR frames that boundary in founder-facing docs:

- official earning adapters create candidates;
- local dashboard, doctor, repair, skills, Hermes, Telegram, Discord, and tests
  remain non-earning probe surfaces;
- backend ledgers decide settlement, refunds, holds, reversals, credits, and
  payout release;
- advertiser assurance reports separate gross events, held events, rejected or
  fraudulent events, refunds, final billable reach, and released payouts.

## What is shipped locally

- README now leads with verified developer activity, official earning adapters,
  the dark desktop control plane, Trust Engine, and advertiser assurance.
- The old archive/TUI companion story is still preserved, but it sits below the
  Phase 0 product pitch.
- Hermes is documented across intro, install, command, skill, safety, roadmap,
  test, Telegram, and Discord boundary surfaces where the source supports it.
- Trust Engine docs now include adapter contracts, state transitions,
  advertiser reports, ML signal boundaries, Stripe boundaries, and future
  messaging-surface guardrails.
- Reward Exchange is documented as backend roadmap: cash, optional
  sponsor-funded credits, blended rewards, exchange multipliers, linked vendor
  accounts, holds, and reversals.

## Backend roadmap clarified

The docs deliberately separate local shipped features from backend-owned product
work:

- official adapter receipts for every earning surface;
- append-only classification, attestation, refund, reward, reversal, and payout
  hold ledgers;
- Reward Exchange settlement for cash and sponsor-funded credits;
- Stripe Connect payout readiness on the backend;
- Telegram and Discord earning adapters only if they meet the same signed
  adapter and trust-ledger contract;
- ML fraud signals as reason-code evidence, not payout authority.

## Note to Andrew

Andrew, this is meant as a respectful Phase 0 package around the product you
already put in motion. The core idea is strong: developers can share in the value
of attention inside their real workflows. The hard part is making that credible
when bot farms, duplicate accounts, and payout pressure show up.

The proposed boundary is simple: local tools make the system legible; official
adapters create earning candidates; backend ledgers decide what becomes
billable, payable, credited, held, refunded, or reversed.

Axl is available for this kind of opportunity: agent integrations, CLI systems,
desktop control planes, trust architecture, analytics, and developer experience.

## Safety notes

- No claim that this branch settles cash, credits, multipliers, or payouts.
- No claim that local archive sightings are billable events.
- No claim that Telegram or Discord adapters are shipped here.
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
rg -n "TODO|FIXME|guaranteed|free money|instant payout|local payout|local credit" README.md TRUST_ENGINE.md PR_DESCRIPTION.md
rg -n "Hermes|Telegram|Discord|Reward Exchange|official adapter|backend" README.md TRUST_ENGINE.md PR_DESCRIPTION.md
```
