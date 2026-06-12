# Kickbacks Trust Engine

The Trust Engine treats bot pressure as the product boundary. Kickbacks can pay
real developers only if advertisers can verify that official earning adapters,
local observations, probe traffic, caps, refunds, reversals, credits, holds, and
payouts are separated in auditable ledgers.

This repository implements the local read-only side: it classifies evidence,
names backend-required gates, and exposes a founder-facing contract. It does not
settle money, credits, or billable reach.

## Core Invariant

No event can become payable from local observation, installer probe, dashboard
state, skill output, repair flow, Hermes plugin output, Telegram/Discord bot
activity, or unauthenticated adapter telemetry.

Only the backend trust service can move an event into a payable state after
these gates clear:

1. official adapter attestation,
2. sync reconciliation,
3. duplicate rejection,
4. cap and velocity limits,
5. cluster and invalid-traffic filtering,
6. advertiser refund or credit buffer,
7. payout hold and reversal window,
8. Stripe/1099 payout readiness.

The Phase 0 payout posture should be explicit: payouts are reviewed for fraud,
and click-farm or bot earnings are held or rejected rather than paid. This Trust
Engine turns that product promise into explicit state transitions, ledgers,
model signals, review queues, and advertiser-visible evidence.

## Official Adapter Contract

Official earning adapters are the only path from developer activity to an
earning candidate. Dashboard, doctor, repair, skills, Hermes, Telegram, Discord,
and tests are non-earning probe surfaces unless Kickbacks ships a signed adapter
for that surface.

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
still own caps, invalid-traffic review, advertiser refunds, Reward Exchange
crediting, and payout finality.

## State Machine

Events move through explicit states:

| State | Advertiser billed | Developer paid | Meaning |
| :---- | :---------------- | :------------- | :------ |
| `probe_non_earning` | no | no | Install, repair, dashboard, skills, Hermes, Telegram/Discord bots, and diagnostics only. |
| `observed_local` | no | no | Local archive saw a creative; useful proof, not billable. |
| `candidate_adapter_attested` | no | no | Official adapter claims render and wait-state threshold. |
| `held_for_review` | no | no | Sync, cap, velocity, cluster, refund-window, credit-window, or reversal-window hold. |
| `eligible_but_capped` | no | no | Real attention but no incremental bill, cash payout, or credit beyond policy caps. |
| `backend_accepted` | yes | no | Backend accepted the event; payout and Reward Exchange settlement still wait. |
| `accepted_billable_after_refund_window` | yes | yes | Final enough for cash payout or eligible sponsor-credit release. |
| `paid` | yes | yes | Developer cash payout released. |
| `credited` | yes | yes | Optional sponsor-funded credit or blended reward posted by the backend Reward Exchange. |
| `reversed` | adjusted | adjusted | Cash, credit, or multiplier benefit was clawed back or adjusted. |
| `refunded` | no | no | Advertiser was credited or refunded after invalid, reversed, or adjusted traffic. |
| `rejected` | no | no | Not billable and not payable. |
| `fraudulent` | no | no | Blocked and removed from billable reach. |

## Advertiser Assurance Report

Advertisers need evidence that the bot problem is contained, not a generic
"trust score." The report should show:

| Metric | Definition |
| :----- | :--------- |
| `gross_adapter_events` | Official adapter events before filtering. |
| `held_events` | Events blocked pending sync, cap, cluster, review, refund, credit, or reversal clearance. |
| `rejected_or_fraudulent_events` | Events removed with terminal reason codes. |
| `refunded_events` | Previously billed events credited back to advertisers. |
| `reversed_rewards` | Developer cash, credits, or multiplier benefits clawed back after later review. |
| `final_billable_reach` | Events remaining after invalid-traffic filtering, caps, holds, refunds, and reversals. |
| `payouts_released_after_trust_window` | Developer cash payouts released only after gates clear. |
| `credits_released_after_trust_window` | Optional sponsor-funded credits released only after the same trust gates clear. |

Required ledgers:

- `event_classification_ledger`
- `adapter_attestation_ledger`
- `fraud_cluster_ledger`
- `advertiser_refund_ledger`
- `reward_exchange_ledger`
- `reward_reversal_ledger`
- `payout_hold_ledger`

## Reward Exchange Boundary

Reward Exchange is a backend roadmap layer, not a local desktop feature. The
Trust Engine should support it without weakening the cash payout contract.

Rules:

- cash remains the default reward and should continue to clear through backend
  acceptance, refund buffers, hold windows, and Stripe Connect payout readiness;
- optional sponsor-funded credits can be offered only when clearly labeled as
  credits, not cash;
- blended rewards can combine cash plus credits only after opt-in and backend
  settlement;
- exchange multipliers belong in backend ledgers and must show the sponsor,
  vendor, campaign, conversion terms, expiration, and reversal policy;
- linked vendor accounts must be explicit, revocable, and separated from the
  local archive;
- holds apply to cash, credits, and multiplier benefits until trust, refund,
  KYC, and reversal windows clear;
- reversals must adjust every affected reward type when an event is rejected,
  refunded, disputed, capped, or later classified as fraudulent.

The desktop app may display backend-provided Reward Exchange status in the
future. It must not create credits, choose multipliers, link vendor accounts,
release holds, or reverse balances locally.

## ML Signal Layer

ML is a fraud-detection signal layer, not a hard payout gate. Its job is to
surface data points and reason-code candidates into the ledger; deterministic
policy, manual review, and the backend state machine decide settlement.

Known bot accounts and bot events labeled by Kickbacks, when available, are
high-value training data. They let the MVP start with supervised learning
instead of only unsupervised anomaly detection.

Recommended layers:

| Layer | Output | Settlement authority |
| :---- | :----- | :------------------- |
| `supervised_event_classifier` | Risk data points and reason-code candidates from labeled bot and reviewed clean traffic. | Cannot pay, credit, reverse, or reject by itself. |
| `graph_cluster_model` | Account/device/IP/ASN/adapter/campaign/vendor cluster signals. | Can recommend review or hold evidence only. |
| `surface_behavior_anomaly_model` | Cadence, wait-state, click/view, parallel-agent, Telegram, Discord, and Hermes anomalies. | Adds evidence; policy gates remain decisive. |

Useful reason codes include `known_bot_similarity`, `high_parallelism_cluster`,
`new_account_high_velocity`, `shared_device_fingerprint`,
`wait_state_entropy_low`, `click_view_ratio_abnormal`,
`campaign_concentration_high`, `asn_cluster_risk`,
`vendor_account_reuse_risk`, and `refund_reversal_similarity`.

The feedback loop should include known bot labels, manual review decisions,
released holds, advertiser refunds, payout reversals, Reward Exchange credit
reversals, disputes, and confirmed clean power users.

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
1099/reporting, Connect account requirements, and reversal windows clear on the
Kickbacks backend.

The desktop app must never hold Stripe secret keys, create money movement,
release cash payouts, create sponsor credits, apply exchange multipliers, link
vendor accounts, or reverse balances.
