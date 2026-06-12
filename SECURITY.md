# Security Policy

Kickbacks.ai must keep the earning boundary boring and explicit: local tools can
help a user see, diagnose, install, and repair their setup, but local tools never
create payable events. No desktop dashboard state, installer probe, repair flow,
skill output, developer note, Hermes/chat surface, or local archive row can turn
itself into a billable advertiser event or a developer payout.

## Trust Boundaries

### Local App And CLI

The desktop app, `kb`/`kickbacks` CLI, archive, sync monitor, doctor, statusline,
and local API are read-only observation surfaces. They may read local extension
artifacts, local archive rows, account-ledger watermarks, install state, and
backend-provided status summaries. They must not post impressions, views, clicks,
credits, balances, metrics, billing events, payout requests, or Stripe money
movement requests.

The local app should bind to loopback by default. If a future operator exposes it
to a network, that exposure must be explicit and treated as a separate deployment
risk.

### Official Adapters

Official earning adapters are the only surfaces allowed to create earning
candidates. An adapter candidate is still not settlement authority. It must be
accepted by backend controls before it can become billable, and it must pass the
refund and payout windows before it can become payable.

Unofficial adapters, local dashboard actions, diagnostics, slash commands, and
repair tests stay in `probe_non_earning` or `observed_local` states.

### Backend Trust And Settlement

The Kickbacks backend owns adapter receipt acceptance, duplicate rejection, caps,
velocity checks, invalid-traffic filtering, advertiser billable counts, refund or
credit decisions, payout holds, and payout release. Backend ledgers are the source
of truth for accepted, billable, payable, refunded, rejected, and fraudulent
states.

### Stripe And Vendor Credit Rails

Stripe Connect and any vendor credit rail are payout and money-movement
infrastructure, not local app capabilities. Local software may display
backend-provided onboarding, requirements, account, payout-readiness, or refund
status, but it must never hold Stripe secret keys, create charges, create
transfers, create payouts, issue refunds, or infer payout finality from local
logs.

### ML And Bot Signals

ML is a signal layer, not settlement authority. Models may provide risk scores,
cluster evidence, anomaly signals, and reason-code candidates for backend review,
but deterministic policy, review evidence, and backend event-state ledgers decide
whether an event is accepted, billed, rejected, refunded, held, or paid.

### Hermes, Chat, Skills, And Developer Notes

Hermes/chat integrations, Claude/Codex/Hermes skills, slash commands, generated
developer notes, and plugin tools are explanation and repair surfaces. They can
run local read-only commands, summarize ledger freshness, inspect install state,
and hand implementation work to Codex. They must not call payable metrics/events
routes, fabricate impressions, create credits, or invoke Stripe/vendor money
movement APIs.

### Installer And Repair

Installer and repair flows may write marker-owned local integration files, wrap
supported commands, and restore marker-owned artifacts. They are non-earning
probes. Setup tests and repair checks are never payable and must not advance an
event beyond `probe_non_earning`.

## Responsible Disclosure

No official public security contact is known in this repository yet.

Placeholder contact: `security@example.invalid` or the repository maintainer via
the project's private GitHub security advisory flow, if enabled. Until an
official contact is published, avoid posting sensitive exploit details in public
issues; share a minimal public report and keep secrets, tokens, proofs of exploit,
and user data private.
