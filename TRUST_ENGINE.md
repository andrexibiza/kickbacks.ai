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

## Two-Way Founder Contract

Phase 0 should be easy for founders to explain in both directions:

- developers see when activity is local proof, an approved adapter candidate, a
  held or capped event, a backend-accepted event, or a released cash payout;
- advertisers see gross adapter events, holds, exclusions, refunds, reversals,
  final billable reach, and payout releases without trusting local-only logs;
- the backend remains the system of record for settlement, while local surfaces
  remain useful witnesses, status readers, and reconciliation inputs.

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
| `server_nonce_id`, `nonce_issued_at`, `nonce_expires_at`, and `nonce_used_at` | Proves a backend-issued single-use challenge was consumed once. |
| `signed_receipt`, `adapter_key_id`, and `session_binding_hash` | Blocks token-only replay and binds the receipt to an approved adapter/session. |
| `compatibility_manifest_id` and `anchor_fingerprint` | Proves the adapter was approved for the current third-party surface version. |

The adapter creates a candidate. It does not create a payout. Backend ledgers
still own caps, invalid-traffic review, advertiser refunds, billing acceptance,
and payout finality.

## Loopback Token And Saturation Immunity

Readable loopback tokens are bearer material, not earning proof. A token visible
inside VS Code, a local API client, or a diagnostic process cannot prove human
attention, viewability, freshness, campaign eligibility, or payout authority.
Token-only evidence must stay non-billable until a signed official adapter
receipt consumes a fresh server-issued nonce and clears backend replay checks.

Proof-of-concept traffic scripts such as `attack-real.mjs` are treated as a
realistic abuse class, not an edge case. Variable cadence, positive jitter,
irregular durations, alternating status-bar/terminal surfaces, continuous caps,
and rest cycles must be checked against aggregate backend state:

- account-level and campaign-level caps;
- duty-cycle and rest-window heuristics;
- strict concurrent-session limits across surfaces and machines;
- inter-arrival entropy, duration histograms, jitter distributions, and surface
  alternation signatures;
- IP/ASN/device/account/payout graph clusters;
- human review for high-similarity clusters before payout release.

The backend should emit advertiser-visible reason codes such as
`loopback_token_replay`, `server_nonce_missing`, `server_nonce_reused`,
`adapter_signature_invalid`, `saturation_cadence_similarity`,
`duty_cycle_cap_evasion`, `surface_alternation_synthetic`,
`strict_concurrency_exceeded`, and `adapter_anchor_incompatible`.

Third-party webview anchoring must fail closed. If a Claude, VS Code, Codex,
Hermes, Telegram, Discord, or other supported surface changes an expected
bundle anchor or template shape, the adapter becomes probe-only or incompatible
until a signed compatibility manifest and release gate approve the new surface
version. A broken anchor must never silently create earning candidates,
billable reach, or payable rewards.

## IDE-Local Trust Boundary

IDE-local evidence is hostile-by-default. Developer tools routinely hold source
code, local credentials, API keys, signing agents, and production context, so a
Kickback.ai adapter cannot treat local IDE state as settlement truth.

Rules:

- extension global state, workspace settings, loopback tokens, local artifact
  files, marketplace directory names, and debug logs are never payout authority;
- an official adapter must provide signed receipts, adapter ID/version, key ID,
  user opt-in, visibility proof, session binding, a server-issued single-use
  nonce, and a signed compatibility manifest;
- invasive patching of upstream IDE bundles, webviews, scripts, or template
  anchors is not an earning path; if an anchor drifts, the surface becomes
  probe-only until a signed release gate accepts the new version;
- update channels must fail closed on missing signatures, publisher mismatch, or
  compatibility-manifest mismatch;
- the backend, not the IDE, decides acceptance, rejection, holds, refunds,
  advertiser reporting, and payout release.

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
- loopback-token replay defense: readable local tokens prove bearer possession,
  not human attention or advertiser-safe reach
- billable event creation: campaign budgets, advertiser contracts, exposure
  ceilings, and accepted-event ledgers
- caps and velocity: hourly, daily, per-surface, campaign, new-account, and
  parallel-agent limits across users and machines
- duty-cycle and strict concurrency enforcement: rest-window patterns,
  surface-alternation sequences, and active sessions across users and machines
- fraud clusters and invalid traffic: IP, ASN, device, payout identity, account,
  cadence, jitter, duration, and advertiser-wide traffic quality
- adapter compatibility: signed compatibility manifests, anchor fingerprints,
  and fail-closed preflight decisions for third-party surface drift
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
- `server_nonce_replay_ledger`
- `fraud_cluster_ledger`
- `adapter_compatibility_ledger`
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
| `surface_behavior_anomaly_model` | Cadence, wait-state, click/view, saturation-script, parallel-agent, Telegram, Discord, and Hermes anomalies. | Adds evidence; policy gates remain decisive. |
| `adapter_integrity_model` | Nonce replay, token-only evidence, signature validity, and adapter-anchor compatibility signals. | Cannot settle; replay policy and review own holds or rejection. |

Useful reason codes include `known_bot_similarity`, `high_parallelism_cluster`,
`new_account_high_velocity`, `shared_device_fingerprint`,
`wait_state_entropy_low`, `click_view_ratio_abnormal`,
`campaign_concentration_high`, `asn_cluster_risk`,
`vendor_account_reuse_risk`, `refund_reversal_similarity`,
`vscode_loopback_token_exposed`, `loopback_token_replay`,
`server_nonce_missing`, `server_nonce_reused`,
`adapter_signature_invalid`, `saturation_cadence_similarity`,
`duty_cycle_cap_evasion`, `surface_alternation_synthetic`,
`strict_concurrency_exceeded`, and `adapter_anchor_incompatible`.

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
- Loopback-token replay: leaked local bearer material used to forge ad revenue
  without a fresh server nonce or signed adapter receipt.
- Realistic saturation attacks: scripts that mimic variable cadence, positive
  jitter, irregular durations, alternating surfaces, continuous caps, and rest
  cycles to look like normal developer attention.
- Brittle client-side anchoring: uncoordinated third-party file modifications
  that break after upstream bundle changes and must fail closed before earning.

The same boundaries apply to developer-tool surfaces and future messaging
surfaces. Hermes, Telegram, and Discord can help users inspect or receive
status, but they cannot become settlement authority.

## Stripe Boundary

Stripe Connect is payout infrastructure, not the trust engine. Stripe should
release funds only after accepted earning, refund buffers, payout holds, KYC,
1099/reporting, and Connect account requirements clear on the
Kickback.ai backend.

Official Stripe references checked at `2026-06-12 19:23` make this a
compliance and risk boundary, not just an API placement decision:

- [Connect risk and liability](https://docs.stripe.com/connect/risk-management)
  requires the platform to decide and track responsibility for losses, fraud
  and abuse, negative balances, pricing/fees, and payout controls;
- [connected account types](https://docs.stripe.com/connect/accounts) determine
  liability and support responsibilities, and cannot be treated as
  interchangeable after account creation;
- [identity verification](https://docs.stripe.com/connect/identity-verification)
  and [API verification handling](https://docs.stripe.com/connect/handling-api-verification)
  require dynamic KYC and requirements monitoring before charges and payouts;
- [marketplace account creation](https://docs.stripe.com/connect/marketplace/tasks/create)
  can make the platform responsible for negative balances and credit or fraud
  risk, depending on the selected responsibility model;
- [Stripe restricted-business policy](https://stripe.com/legal/restricted-businesses)
  makes product positioning part of the risk control: Kickback.ai must frame
  verified developer attention and final billable reach, not traffic resale,
  unrealistic incentives, guaranteed rewards, or fast/easy money.

International onboarding is a backend settlement concern, not a local repair
task. Country support, requested capabilities, account-link expiration,
return/refresh handling, onboarding completion, verification requirements,
tax/reporting status, payout holds, and unsupported-country fallbacks must be
ledger-visible before the UI presents a user as payout-ready.

Local surfaces must never hold Stripe secret keys, create money movement,
release cash payouts, create sponsor credits, apply exchange multipliers, link
vendor accounts, or reverse balances.

The Trust Engine should expose Stripe-related state only as backend-provided
facts, for example:

- selected Connect responsibility model and account type/controller properties;
- currently due, eventually due, pending verification, disabled reason, and
  payout/charge capability state;
- payout hold, reserve, negative-balance, refund, dispute, reversal, and release
  ledger entries;
- compliance copy review status when product language approaches online traffic
  or engagement resale, high-reward incentive, or easy-money claims.
