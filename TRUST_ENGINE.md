# Kickbacks Trust Engine

This implementation treats the bot problem as the product boundary. Kickbacks can
pay real users only if advertisers can verify that bot farms, click farms, probe
traffic, caps, refunds, and payouts are separated in an auditable ledger.

## Core Invariant

No event can become payable from local observation, installer probe, dashboard
state, skill output, repair flow, or unauthenticated adapter telemetry.

Only the backend trust service can move an event into a payable state after these
gates clear:

1. official adapter attestation,
2. sync reconciliation,
3. duplicate rejection,
4. cap and velocity limits,
5. cluster and invalid-traffic filtering,
6. advertiser refund buffer,
7. Stripe/1099 payout readiness.

The existing payout warning on the live product already sets the right policy:
every payout is reviewed for fraud, and click-farm or bot earnings are not paid.
This Trust Engine turns that promise into explicit state transitions, ledgers,
model signals, review queues, and advertiser-visible evidence.

## State Machine

Events move through explicit states:

| State | Advertiser billed | Developer paid | Meaning |
| :---- | :---------------- | :------------- | :------ |
| `probe_non_earning` | no | no | Install, repair, dashboard, skills, and diagnostics only. |
| `observed_local` | no | no | Local archive saw a creative; useful proof, not billable. |
| `candidate_adapter_attested` | no | no | Official adapter claims render and wait-state threshold. |
| `held_for_review` | no | no | Sync, cap, velocity, cluster, or refund-window hold. |
| `eligible_but_capped` | no | no | Real attention but no incremental bill or payout. |
| `backend_accepted` | yes | no | Backend accepted the event; payout still waits. |
| `accepted_billable_after_refund_window` | yes | yes | Final enough for Stripe payout release. |
| `paid` | yes | yes | Developer payout released. |
| `rejected` | no | no | Not billable and not payable. |
| `fraudulent` | no | no | Blocked and removed from billable reach. |

## Advertiser Assurance Report

Advertisers need evidence that the bot problem is contained, not a generic
"trust score." The report should show:

| Metric | Definition |
| :----- | :--------- |
| `gross_adapter_events` | Official adapter events before filtering. |
| `held_events` | Events blocked pending sync, cap, cluster, or review clearance. |
| `rejected_or_fraudulent_events` | Events removed with terminal reason codes. |
| `refunded_events` | Previously billed events credited back to advertisers. |
| `final_billable_reach` | Events remaining after invalid-traffic filtering and refunds. |
| `payouts_released_after_trust_window` | Developer payouts released only after gates clear. |

Required ledgers:

- `event_classification_ledger`
- `adapter_attestation_ledger`
- `fraud_cluster_ledger`
- `advertiser_refund_ledger`
- `payout_hold_ledger`

## ML Signal Layer

ML is a fraud-detection signal layer, not a hard payout gate. Its job is to
surface data points and reason-code candidates into the ledger; deterministic
policy, manual review, and the backend state machine decide settlement.

Known bot accounts and bot events already labeled by Kickbacks are high-value
training data. They let the MVP start with supervised learning instead of only
unsupervised anomaly detection.

Recommended layers:

| Layer | Output | Settlement authority |
| :---- | :----- | :------------------- |
| `supervised_event_classifier` | risk data points and reason-code candidates from labeled bot and reviewed clean traffic | cannot pay or reject by itself |
| `graph_cluster_model` | account/device/IP/ASN/adapter/campaign cluster signals | can recommend review/hold evidence only |
| `surface_behavior_anomaly_model` | cadence, wait-state, click/view, and parallel-agent anomalies | adds evidence; policy gates remain decisive |

Useful reason codes include `known_bot_similarity`, `high_parallelism_cluster`,
`new_account_high_velocity`, `shared_device_fingerprint`,
`wait_state_entropy_low`, `click_view_ratio_abnormal`,
`campaign_concentration_high`, `asn_cluster_risk`, and
`refund_reversal_similarity`.

The feedback loop should include known bot labels, manual review decisions,
released holds, advertiser refunds, payout reversals, disputes, and confirmed
clean power users.

## Threat Model

The Trust Engine uses standard ad-fraud language:

- OWASP OAT-003 Cost-Inflation Fraud / Ad Fraud: fake ad displays or clicks.
- OWASP OAT-016 Skewing: distorted campaign metrics and trust scores.
- OWASP OAT-019 Account Creation: farmed accounts for payout extraction.
- MRC/IAB invalid-traffic practice: non-human or non-measurable traffic filtering.

## Stripe Boundary

Stripe Connect is payout infrastructure, not the trust engine. Stripe should
release funds only after accepted earning, refund buffers, payout holds, KYC,
1099/reporting, and Connect account requirements clear on the Kickbacks backend.
The desktop app must never hold Stripe secret keys or create money movement.
