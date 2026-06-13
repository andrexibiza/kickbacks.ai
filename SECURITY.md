# Security Policy

Kickback.ai must keep the earning boundary boring and explicit. Desktop,
CLI/TUI, Telegram, Discord, chat, and agent workflow surfaces may become earning
inventory only when they run as registered official opt-in earning adapters with
explicit user controls, proof, backend acceptance, refund windows, and
settlement gates.

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
- loopback or VS Code-readable tokens used as bearer material to forge ad
  revenue;
- proof-of-concept saturation scripts, including `attack-real.mjs`-style
  realistic traffic generators, that mimic variable cadence, positive jitter,
  irregular durations, alternating surfaces, continuous caps, and rest cycles;
- brittle client-side anchors in third-party webviews that break or drift after
  upstream bundle changes;
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
whether events move through `backend_accepted`,
`accepted_billable_after_refund_window`, `paid`, `refunded`, `rejected`, or
`fraudulent`.

## Loopback Token, Saturation, And Anchor Immunity

Loopback tokens and locally readable developer-tool tokens are not attention
proof. A token visible to VS Code, a local API client, or a diagnostic tool can
prove only that a local process had bearer material. It cannot prove a real
developer, visible creative, fresh session, advertiser-safe event, or payable
earning.

Every candidate earning event must survive five independent controls:

1. a signed official adapter receipt with adapter ID/version, key ID, session
   binding, user opt-in, visibility proof, and a compatibility manifest;
2. a server-issued single-use nonce with a short TTL, backend challenge/receipt
   pairing, duplicate rejection, and an idempotency key;
3. aggregate account-level checks for campaign caps, duty cycle, strict
   concurrency, surface alternation entropy, jitter and duration distributions,
   rest windows, and account/device/IP/ASN graph clusters;
4. human-in-the-loop ML scoring that emits reason codes such as
   `loopback_token_replay`, `server_nonce_reused`,
   `saturation_cadence_similarity`, `strict_concurrency_exceeded`, and
   `adapter_anchor_incompatible`;
5. backend billing, refund, hold, reversal, and payout ledgers that keep
   advertiser billable reach separate from developer payout release.

A leaked loopback token, missing nonce, expired nonce, reused nonce, unsigned
adapter event, or token-only receipt must be rejected or held before advertiser
billing. Realistic-looking impression traffic must still clear backend
duty-cycle heuristics, strict concurrency limits, aggregate account checks, and
manual review before it can become billable.

Third-party webview anchoring must fail closed. If an upstream surface changes
an expected anchor, bundle shape, or compatibility fingerprint, the adapter
enters probe or incompatible mode until a signed compatibility manifest and
release gate approve the new surface version. Anchor drift must never silently
create earning candidates, billable reach, or payable developer rewards.

### IDE-Local File And Extension Trust Boundary

Developer environments hold source code, private repositories, production
credentials, API keys, signing material, SSH agents, and customer context. Any
Kickback.ai adapter that reads or modifies IDE-local files starts from that
trust deficit and must stay intentionally narrow.

Current local control surfaces may read local artifacts such as
`~/.vibe-ads/cli-ad.json`, `~/.vibe-ads/debug.log`, and the presence of
`~/.kickbacks/auth.json`. That evidence is diagnostic only. It must never become
human-attention proof, billing authority, payout readiness, Stripe readiness, or
advertiser proof by itself.

Design rules for IDE integrations:

- do not patch third-party IDE bundles, webviews, scripts, templates, or
  upstream-owned extension files to inject monetization UI;
- do not store long-lived bearer tokens, refresh tokens, payout identifiers,
  Stripe secrets, advertiser secrets, or backend signing material in extension
  global state, workspace settings, checked-in files, logs, prompts, or
  screenshots;
- treat any token visible to VS Code, another extension, an agent, or a local
  process as bearer material only, never as proof of viewability or work;
- prefer official APIs, extension points, OS keychain or platform secret
  storage, short-lived scoped tokens, and backend-issued single-use nonces;
- require signed adapter releases, signed compatibility manifests, publisher
  identity checks, and fail-closed update and anchor preflights before an
  adapter can create earning candidates;
- if an IDE or extension marketplace update, upstream template, or bundle anchor
  changes, fall back to probe-only mode until the backend approves the new
  signed compatibility state.

Marketplace malware and same-host extension risks are part of the threat model.
An unrelated malicious extension or local dependency may read accessible files,
observe workspace state, alter user configuration, or exfiltrate developer
secrets. Kickback.ai's defense is to keep client-side evidence minimal and
revocable, keep settlement server-owned, and make local IDE state insufficient
for billable or payable events.

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
candidates. This rule is surface-neutral: desktop, CLI/TUI, Telegram, Discord,
chat, and agent workflow surfaces may monetize only when they are registered,
consented, proof-backed, and backend settled.

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
  timestamp, cap context, visibility proof, signed receipt, server-issued
  single-use nonce, and backend replay ledger status;
- rate limits, campaign caps, duplicate rejection, and fraud-review hooks;
- backend attestation and reconciliation before advertiser billing;
- refund windows, KYC/vendor eligibility, and settlement gates before payout or
  credit release.

An adapter candidate is not settlement authority. It must be accepted by backend
controls before it can become billable, and it must pass review, refund, and
payout windows before it can become payable.

Unofficial adapters, local dashboard actions, diagnostics, slash commands,
repair tests, and generated notes stay in `probe` or `observed_local` states.
Those local states are never payable and must not be promoted by local code.

### Backend Trust And Settlement

The Kickback.ai backend owns adapter receipt acceptance, server nonce issuance
and consumption, duplicate rejection, caps, duty-cycle checks, strict
concurrency limits, velocity checks, invalid-traffic filtering, advertiser
billable counts, refund or credit decisions, payout holds, and payout release.
Backend ledgers are the source of truth for `backend_accepted`,
`accepted_billable_after_refund_window`, `paid`, `refunded`, `rejected`, and
`fraudulent` states.

### Stripe And Vendor Credit Rails

Stripe Connect and any vendor credit rail are payout and money-movement
infrastructure, not local app capabilities. Local software may display
backend-provided onboarding, requirements, account, payout-readiness, credit,
refund, or reversal status, but it must never hold Stripe secret keys, create
charges, create transfers, create payouts, issue refunds, mint credits, choose
credit multipliers, link vendor accounts silently, or infer payout finality from
local logs.

International payout readiness is backend-owned. The backend must handle
connected-account country support, requested capabilities, account-link
expiration and return/refresh URLs, onboarding completion, verification
requirements, tax/reporting status, payout holds, and unsupported-country
fallbacks before the UI presents a user as payout-ready.

Official Stripe policy is part of this security boundary. As checked at
`2026-06-12 19:23`, Stripe's Connect documentation says account configuration
affects responsibility for fraud, abuse, negative balances, and identity
verification; connected-account KYC requirements vary by country, capability,
business type, service agreement, and risk level; and charges or payouts can be
paused when required information is missing or unverified. If Kickback.ai uses
marketplace-style accounts, the selected responsibility model must be tracked as
backend risk state before payout release.

The backend must therefore:

- persist the selected Connect account/controller responsibility model and who
  owns losses, fraud/abuse handling, fees, identity collection, and payout
  controls;
- monitor Stripe account and person requirement updates through backend APIs or
  webhooks, not local logs;
- keep connected-account onboarding, account-link refresh/return handling,
  requirements, reserves, negative balances, disputes, refunds, payout holds,
  and payout release in backend ledgers;
- block local code from creating account links, connected accounts, charges,
  transfers, payouts, refunds, credits, reversals, or money movement;
- keep Stripe secret keys, account tokens, payout identifiers, tax data, and
  connected-account credentials out of client storage, prompts, screenshots,
  public issues, fixtures, and generated notes.

Stripe's restricted-business policy also creates a copy and product-design
security rule. Kickback.ai must describe verified developer attention,
advertiser assurance, and final billable reach after fraud filtering. It must
not imply resale of online traffic or engagement, unrealistic incentives,
guaranteed rewards, or fast/easy money.

### ML And Bot Signals

ML is a signal layer, not settlement authority. Models may provide risk scores,
cluster evidence, anomaly signals, saturation-script similarity, nonce-replay
signals, anchor-compatibility signals, and reason-code candidates for backend
review, but deterministic policy, review evidence, and backend event-state
ledgers decide whether an event becomes `backend_accepted`,
`accepted_billable_after_refund_window`, `refunded`, `fraudulent`, `rejected`,
or `paid`.

### Hermes, Chat, Skills, And Developer Notes

Hermes/chat integrations, Claude/Codex/Hermes skills, slash commands, generated
developer notes, and plugin tools are explanation and repair surfaces unless
they invoke a registered official opt-in adapter for that surface. They can
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
`probe`.

## Responsible Disclosure

No official public security contact is known in this repository yet.

Use the project's private GitHub security advisory flow if it is enabled, or
open a minimal public issue asking for a private contact without exploit
details. Until an official contact is published, keep secrets, tokens, proofs of
exploit, and user data out of public issues, generated notes, screenshots, and
logs.
