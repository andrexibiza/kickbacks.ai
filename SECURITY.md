# Security Policy

Kickback.ai must keep the earning boundary boring and explicit. Desktop,
CLI/TUI, Telegram, Discord, chat, and agent workflow surfaces are already
monetized developer-attention surfaces in Axl's system when they run as
registered official opt-in earning adapters.

The shipped Phase 0 control surfaces help a user see, diagnose, install, and
repair their setup. They do not self-settle billable or payable events. No
dashboard state, installer probe, repair flow, doctor check, skill output,
developer note, Hermes/chat diagnostic surface, test, or local archive row can
turn itself into a billable advertiser event or developer payout.

Forbidden billing paths:

- fabricated impressions, views, clicks, credits, balances, charges, or payouts;
- hidden monetization or mandatory opt-in;
- probe, test, repair, screenshot, or installer traffic classified as earning;
- unauthenticated, non-consensual, replayed, or locally self-settled billing;
- local archive rows presented as advertiser billable reach;
- Stripe, vendor-credit, auth, backend, or payout secrets copied into local
  files, generated notes, logs, screenshots, prompts, or public issues.

## Threat Model

Phase 0 documentation and UI should assume these abuse paths are realistic:

- replayed extension files, duplicated metrics, or stale ledger watermarks
  presented as fresh backend truth;
- official adapter controls bypassed, hidden, or presented as mandatory;
- account farms, bot farms, shared device fingerprints, risky IP/ASN clusters,
  and parallel-agent traffic;
- artificial wait-time, session visibility, or click/view manipulation;
- refund, credit, reversal, or payout-hold decisions hidden from advertiser
  reporting;
- ML risk scores treated as automatic settlement authority instead of review
  evidence.

The control strategy is conservative: local tools explain and display evidence,
official opt-in adapters create candidate events, and backend ledgers decide
what becomes accepted, billable, payable, credited, refunded, rejected, held, or
reversed.

## Trust Boundaries

### Local App, CLI, And TUI

The baseline desktop app, `kb`/`kickbacks` CLI, TUI, archive, sync monitor,
doctor, statusline, and local API are observation and control surfaces. They may
read local extension artifacts, local archive rows, account-ledger watermarks,
install state, and backend-provided status summaries when a backend supplies
them. They must not silently post impressions, views, clicks, credits,
balances, metrics, billing events, payout requests, or Stripe/vendor
money-movement requests.

### Official Opt-In Earning Adapters

Official opt-in earning adapters are the only surfaces allowed to create earning
candidates. This rule is surface-neutral: Axl's working adapters already cover
desktop, CLI/TUI, Telegram, Discord, chat, and agent workflow surfaces when they
are registered, consented, proof-backed, and backend settled.

Every agent interaction with developer attention is advertising inventory only
if it is implemented as one of those official opt-in adapters. Status messages,
review prompts, waiting states, support answers, Telegram or Discord bot
messages, and desktop or command-line panels stay non-earning unless they carry
adapter identity, user consent, visibility proof, backend receipt, and the
settlement gates below.

Required adapter controls:

- clear user consent and a visible off switch;
- authenticated user, session, adapter, and surface identity;
- adapter ID/version, campaign/creative ID, render timestamp, threshold
  timestamp, cap context, visibility proof, and backend nonce or receipt;
- rate limits, campaign caps, duplicate rejection, and fraud-review hooks;
- backend attestation and reconciliation before advertiser billing;
- refund windows, KYC/vendor eligibility, and settlement gates before payout or
  credit release.

An adapter candidate is not settlement authority. It must be accepted by backend
controls before it can become billable, and it must pass review, refund, and
payout windows before it can become payable.

Unofficial adapters, local dashboard actions, diagnostics, slash commands,
repair tests, and generated notes stay in `probe_non_earning` or
`observed_local` states.
Those local states are never payable and must not be promoted by local code.

### Backend Trust And Settlement

The Kickback.ai backend owns adapter receipt acceptance, duplicate rejection,
caps, velocity checks, invalid-traffic filtering, advertiser billable counts,
refund or credit decisions, payout holds, and payout release. Backend ledgers
are the source of truth for accepted, billable, payable, credited, refunded,
rejected, fraudulent, held, and reversed states.

### Stripe And Vendor Credit Rails

Stripe Connect and any vendor credit rail are payout and money-movement
infrastructure, not local app capabilities. Local software may display
backend-provided onboarding, requirements, account, payout-readiness, credit,
refund, or reversal status, but it must never hold Stripe secret keys, create
charges, create transfers, create payouts, issue refunds, mint credits, choose
credit multipliers, link vendor accounts silently, or infer payout finality from
local logs.

### ML And Bot Signals

ML is a signal layer, not settlement authority. Models may provide risk scores,
cluster evidence, anomaly signals, and reason-code candidates for backend
review, but deterministic policy, review evidence, and backend event-state
ledgers decide whether an event is accepted, billed, rejected, refunded, held,
credited, reversed, or paid.

### Hermes, Chat, Skills, And Developer Notes

Hermes/chat integrations, Claude/Codex/Hermes skills, slash commands, generated
developer notes, and plugin tools are explanation and repair surfaces unless
they invoke one of Axl's registered official opt-in adapters for that surface. They can
run local read-only commands, summarize ledger freshness, inspect install state,
and hand implementation work to Codex. They must not call payable metrics/events
routes, fabricate impressions, create credits, or invoke Stripe/vendor
money-movement APIs.

Treat chat surfaces as privacy-sensitive. Do not put auth tokens, payout
identifiers, Stripe secrets, vendor-account credentials, advertiser private
data, exploit details, or personal data into prompts, generated notes,
screenshots, public issues, test fixtures, or logs. Summaries should identify
trust state and reason codes without leaking secrets.

### Installer And Repair

Installer and repair flows may write marker-owned local integration files, wrap
supported commands, and restore marker-owned artifacts. They are non-earning
probes unless a separate registered official opt-in earning adapter handles that
surface. Setup tests and repair checks must not advance an event beyond
`probe_non_earning`.

## Responsible Disclosure

No official public security contact is known in this repository yet.

Use the project's private GitHub security advisory flow if it is enabled, or
open a minimal public issue asking for a private contact without exploit
details. Until an official contact is published, keep secrets, tokens, proofs of
exploit, and user data out of public issues, generated notes, screenshots, and
logs.
