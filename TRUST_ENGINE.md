# Kickback.ai Trust Engine

The Trust Engine treats bot pressure as the product boundary. Kickback.ai can pay
real developers only if advertisers can verify that official opt-in earning
adapters, local observations, probe traffic, caps, refunds, holds, and payouts
are separated in auditable ledgers.

This repository implements the local trust side: it classifies evidence, records
local observation/probe state, permits official opt-in adapter candidates, names
backend-required gates, and exposes a founder-facing contract. It does not
settle money or final billable reach.

Local observations are evidence for display and reconciliation. They are not
backend-owned certainty about adapter acceptance, advertiser billing, payout
eligibility, fraud clearance, refund finality, or Stripe release.

## Core Invariant

Official opt-in earning adapters may run across CLI/TUI, desktop, Telegram,
Discord, Hermes, and agent workflow surfaces. They create earning candidates,
not payouts.

Every agent interaction with developer attention can be advertising inventory
only when it is an official opt-in adapter with visibility proof, backend
attestation, reconciliation, caps, refund windows, user controls, and settlement
gates.

No event can become payable from local observation, installer probe, dashboard
state, skill output, repair flow, unauthenticated adapter telemetry, or a plain
bot/status message. Telegram, Discord, CLI/TUI, desktop, and agent workflow
surfaces may monetize only when they run an official opt-in adapter with proof
and backend settlement gates.

Only backend-owned trust, billing, and payout ledgers can move an event into a
payable state after these gates clear:

1. official adapter attestation,
2. sync reconciliation,
3. duplicate rejection,
4. cap and velocity limits,
5. cluster and invalid-traffic filtering,
6. advertiser refund buffer,
7. payout hold and reversal window,
8. Stripe/1099 payout readiness.

The Phase 0 payout posture should be explicit: payouts are reviewed for fraud,
and click-farm or bot earnings are held or rejected rather than paid. This Trust
Engine turns that product promise into explicit state transitions, ledgers,
model signals, review queues, and advertiser-visible evidence.

## Official Adapter Contract

Official opt-in earning adapters are the only path from developer activity to
an earning candidate. They may exist on CLI/TUI, desktop, Telegram, Discord,
Hermes, and agent workflow surfaces. Dashboard, doctor, repair, skills, bots,
status views, and tests remain non-earning probe surfaces unless they are the
signed registered opt-in adapter for that surface.

An earning adapter should provide:

| Field | Purpose |
| :---- | :------ |
| `surface_id` | Names VS Code, Claude, Codex, Hermes, Telegram, Discord, or another approved surface. |
| `adapter_id` and `adapter_version` | Proves the event came from an approved adapter build. |
| `user_id` and `session_id` | Supports account, device, and velocity checks. |
| `campaign_id` and `creative_id` | Ties activity to advertiser budget and reporting. |
| `rendered_at` | Records when the creative was shown. |
| `wait_state_proof` | Shows the developer was in a measurable wait state. |
| `threshold_reached_at` | Proves the minimum visibility or attention threshold. |
| `cap_context` | Makes campaign, user, and surface caps explainable. |
| `backend_nonce` or `signed_receipt` | Blocks replay and unauthenticated event creation. |

The adapter creates a candidate. It does not create a payout. Backend ledgers
still own caps, invalid-traffic review, advertiser refunds, billing acceptance,
and payout finality.

## State Machine

Events move through explicit states. The "backend only" values below are state
meanings only when the backend reports that state; local surfaces must not
populate those counts from local evidence.

| State | Can enter advertiser billing ledger | Can enter developer reward ledger | Meaning |
| :---- | :---------------------------------- | :-------------------------------- | :------ |
| `probe` | no | no | Install, repair, dashboard, skills, bots, status views, and diagnostics only. |
| `observed_local` | no | no | Local archive saw a creative; useful proof, not billable. |
| `candidate_adapter_attested` | no | no | Official opt-in adapter claims user opt-in, render, receipt, and wait-state threshold. |
| `held_for_review` | no | no | Sync, cap, velocity, cluster, refund-window, payout-hold, or reversal-window review. |
| `eligible_but_capped` | no | no | Real attention but no incremental bill or payout beyond policy caps. |
| `backend_accepted` | backend only | no | Backend accepted the event into a billable ledger; payout still waits. |
| `accepted_billable_after_refund_window` | backend only | backend only | Final enough for payout release. |
| `paid` | backend only | backend only | Developer cash payout released. |
| `refunded` | no | no | Advertiser was credited or refunded after invalid or adjusted traffic. |
| `rejected` | no | no | Not billable and not payable. |
| `fraudulent` | no | no | Blocked and removed from billable reach. |

## Transition Rules

Local and probe states are terminal from the local surface's point of view:

| From | To | Owner | Money impact |
| :--- | :-- | :---- | :----------- |
| `probe` | `probe` | installer, repair, doctor, dashboard, skill, bot, or diagnostic surface | never billable, never payable |
| `observed_local` | `observed_local` | local archive | never billable, never payable |
| `candidate_adapter_attested` | `candidate_adapter_attested` | official opt-in adapter on an approved surface | candidate only; never billable or payable by itself |
| `candidate_adapter_attested` | `held_for_review` / `eligible_but_capped` / `backend_accepted` / `rejected` / `fraudulent` | backend trust service | backend may create billable status only at `backend_accepted` |
| `held_for_review` | `backend_accepted` / `rejected` / `fraudulent` | backend trust service or manual review | backend may create billable status only with preserved release evidence |
| `backend_accepted` | `accepted_billable_after_refund_window` / `refunded` / `rejected` / `fraudulent` | billing, refund, and trust ledgers | payout eligibility starts only after refund and hold windows clear |
| `accepted_billable_after_refund_window` | `paid` / `refunded` | backend payout and Stripe Connect ledgers | payout release or later adjustment only |

No transition initiated by a local surface may create `backend_accepted`,
`accepted_billable_after_refund_window`, or `paid`.

## Backend-Owned Boundaries

These decisions require global state and must remain backend-owned:

- adapter receipt acceptance: server nonce, signing keys, duplicate rejection,
  and replay defense
- billable event creation: campaign budgets, advertiser contracts, exposure
  ceilings, and accepted-event ledgers
- caps and velocity: hourly, daily, per-surface, campaign, new-account, and
  parallel-agent limits across users and machines
- fraud clusters and invalid traffic: IP, ASN, device, payout identity, account,
  cadence, and advertiser-wide traffic quality
- refunds and adjustments: advertiser billing ledger, campaign period, refund
  window, and final invalid-traffic decision
- payout release: Stripe/KYC/1099 readiness, held balances, refund buffers, and
  payout schedules

Local UX, CLI/TUI status, and bot/status surfaces may explain these boundaries
and show backend-provided status. They may not claim backend certainty from a
local render, log line, skill output, bot message, or doctor result.

## Advertiser Assurance Report

Advertisers need evidence that the bot problem is contained, not a generic
"trust score." The report should show:

| Metric | Definition |
| :----- | :--------- |
| `gross_adapter_events` | Official opt-in adapter events before filtering. |
| `held_events` | Events blocked pending sync, cap, cluster, review, refund, or payout-hold clearance. |
| `rejected_or_fraudulent_events` | Events removed with terminal reason codes. |
| `refunded_events` | Previously billed events credited back to advertisers. |
| `final_billable_reach` | Events remaining after invalid-traffic filtering, caps, holds, refunds, and reversals. |
| `payout_releases_after_trust_window` | Developer cash payout releases counted only after gates clear. |

Required ledgers:

- `event_classification_ledger`
- `adapter_attestation_ledger`
- `fraud_cluster_ledger`
- `advertiser_refund_ledger`
- `payout_hold_ledger`

## Reward Exchange Boundary

Reward Exchange is a backend roadmap layer, not a local desktop feature. The
Trust Engine should support it without weakening the cash payout contract. It is
not an event state in the Phase 0 state machine above.

Rules:

- cash remains the default reward and should continue to clear through backend
  acceptance, refund buffers, hold windows, and Stripe Connect payout readiness;
- optional sponsor-funded credits can be offered only when clearly labeled as
  credits, not cash;
- blended rewards can combine cash plus credits only after a separate opt-in and
  backend settlement;
- exchange multipliers belong in backend ledgers and must show the sponsor,
  vendor, campaign, conversion terms, expiration, and reversal policy;
- linked vendor accounts must be explicit, revocable, and separated from the
  local archive;
- holds apply to cash, credits, and multiplier benefits until trust, refund,
  KYC, and reversal windows clear;
- reversals must adjust every affected reward type when an event is rejected,
  refunded, disputed, capped, or later classified as fraudulent.

Local surfaces may display backend-provided Reward Exchange status in the
future. They must not create credits, choose multipliers, link vendor accounts,
release holds, or reverse balances locally.

## ML Signal Layer

ML is a fraud-detection signal layer, not a hard payout gate. Its job is to
surface data points and reason-code candidates into the ledger; deterministic
policy, manual review, and the backend state machine decide settlement.

Known bot accounts and bot events labeled by Kickback.ai, when available, are
high-value training data. They let the MVP start with supervised learning
instead of only unsupervised anomaly detection.

Recommended layers:

| Layer | Output | Settlement authority |
| :---- | :----- | :------------------- |
| `supervised_event_classifier` | Risk data points and reason-code candidates from labeled bot and reviewed clean traffic. | Cannot pay, accept, or reject by itself. |
| `graph_cluster_model` | Account/device/IP/ASN/adapter/campaign/vendor cluster signals. | Can recommend review or hold evidence only. |
| `surface_behavior_anomaly_model` | Cadence, wait-state, click/view, parallel-agent, Telegram, Discord, and Hermes anomalies. | Adds evidence; policy gates remain decisive. |

Useful reason codes include `known_bot_similarity`, `high_parallelism_cluster`,
`new_account_high_velocity`, `shared_device_fingerprint`,
`wait_state_entropy_low`, `click_view_ratio_abnormal`,
`campaign_concentration_high`, `asn_cluster_risk`,
`vendor_account_reuse_risk`, and `refund_reversal_similarity`.

The feedback loop should include known bot labels, manual review decisions,
released holds, advertiser refunds, payout adjustments, disputes, and confirmed
clean power users.

## Threat Model

The Trust Engine uses standard ad-fraud language:

- OWASP OAT-003 Cost-Inflation Fraud / Ad Fraud: fake ad displays or clicks.
- OWASP OAT-016 Skewing: distorted campaign metrics and trust scores.
- OWASP OAT-019 Account Creation: farmed accounts for payout extraction.
- MRC/IAB invalid-traffic practice: non-human or non-measurable traffic
  filtering.

The same boundaries apply to developer-tool surfaces and future messaging
surfaces. Hermes, Telegram, and Discord can help users inspect or receive
status, but they cannot become settlement authority.

## Stripe Boundary

Stripe Connect is payout infrastructure, not the trust engine. Stripe should
release funds only after accepted earning, refund buffers, payout holds, KYC,
1099/reporting, and Connect account requirements clear on the
Kickback.ai backend.

Local surfaces must never hold Stripe secret keys, create money movement,
release cash payouts, create sponsor credits, apply exchange multipliers, link
vendor accounts, or reverse balances.
