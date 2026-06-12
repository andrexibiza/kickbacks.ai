//! Two-way trust ledger for Kickbacks.
//!
//! The desktop app needs to prove two things at once:
//! developers can see why their real local activity is or is not syncing, and
//! advertisers can see why billed attention is protected from bots, click farms,
//! probe traffic, and payout abuse. This module is deliberately read-only. It
//! classifies local evidence and names backend-required signals, but it never
//! creates earning events.

use anyhow::Result;
use serde::Serialize;

use crate::archive::{Archive, LedgerEvent, Stats};
use crate::{integrations, sync_health, util};

const EVENT_STATES: &[&str] = &[
    "probe_non_earning",
    "observed_local",
    "candidate_adapter_attested",
    "held_for_review",
    "eligible_but_capped",
    "backend_accepted",
    "accepted_billable_after_refund_window",
    "paid",
    "refunded",
    "rejected",
    "fraudulent",
];

#[derive(Debug, Clone, Serialize)]
pub struct TrustEngineSnapshot {
    pub title: &'static str,
    pub pitch: &'static str,
    pub mode: &'static str,
    pub trust_boundaries: Vec<TrustBoundary>,
    pub backend_owned_boundaries: Vec<BackendOwnedBoundary>,
    pub settlement_gates: Vec<SettlementGate>,
    pub finality_model: FinalityModel,
    pub advertiser_assurance: AdvertiserAssuranceReport,
    pub threat_model: Vec<ThreatModelItem>,
    pub ml_signal_layer: MlSignalLayer,
    pub user_risk_score: u8,
    pub user_risk_band: &'static str,
    pub surface_risk_score: u8,
    pub surface_risk_band: &'static str,
    pub advertiser_refund_exposure: ExposureSummary,
    pub suspicious_event_queue: QueueSummary,
    pub payout_hold_queue: QueueSummary,
    pub cap_reason_ledger: Vec<CapReason>,
    pub earning_eligibility_state: Vec<EligibilityBucket>,
    pub event_state_buckets: Vec<EventStateBucket>,
    pub surface_attestations: Vec<SurfaceAttestation>,
    pub cluster_detection: Vec<ClusterSignal>,
    pub advertiser_protection: AdvertiserProtection,
    pub trusted_user_ladder: Vec<TrustLadderStep>,
    pub non_earning_probe_mode: ProbeMode,
    pub safety_policy: SafetyPolicy,
    pub recent_event_proofs: Vec<EventProof>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExposureSummary {
    pub status: &'static str,
    pub local_visible_non_billable: i64,
    pub held_for_sync_review: usize,
    pub backend_required: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrustBoundary {
    pub stage: &'static str,
    pub owner: &'static str,
    pub evidence: Vec<&'static str>,
    pub allowed_to_advance: &'static str,
    pub can_make_payable: bool,
    pub failure_mode: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendOwnedBoundary {
    pub decision: &'static str,
    pub why_backend_owned: &'static str,
    pub local_snapshot_policy: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettlementGate {
    pub gate: &'static str,
    pub required_evidence: &'static str,
    pub local_status: &'static str,
    pub backend_status: &'static str,
    pub blocks_payout: bool,
    pub protects_advertiser: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FinalityModel {
    pub invariant: &'static str,
    pub payable_state: &'static str,
    pub billing_state_machine: Vec<BillingState>,
    pub hard_stop_rules: Vec<HardStopRule>,
    pub finality_rules: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BillingState {
    pub state: &'static str,
    pub owner: &'static str,
    pub meaning: &'static str,
    pub can_bill_advertiser: bool,
    pub can_pay_developer: bool,
    pub next_allowed: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HardStopRule {
    pub rule: &'static str,
    pub action: &'static str,
    pub final_until: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdvertiserAssuranceReport {
    pub title: &'static str,
    pub proof_standard: &'static str,
    pub public_claim: &'static str,
    pub required_tables: Vec<AssuranceTable>,
    pub control_evidence: Vec<ControlEvidence>,
    pub report_metrics: Vec<AdvertiserMetric>,
    pub audit_artifacts: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssuranceTable {
    pub table: &'static str,
    pub grain: &'static str,
    pub purpose: &'static str,
    pub minimum_fields: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ControlEvidence {
    pub control: &'static str,
    pub evidence: &'static str,
    pub advertiser_visible: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdvertiserMetric {
    pub metric: &'static str,
    pub definition: &'static str,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreatModelItem {
    pub threat: &'static str,
    pub standard_or_taxonomy: &'static str,
    pub attacker_goal: &'static str,
    pub required_controls: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MlSignalLayer {
    pub title: &'static str,
    pub authority_boundary: &'static str,
    pub labeled_training_data: &'static str,
    pub feature_row: Vec<&'static str>,
    pub model_layers: Vec<ModelLayer>,
    pub reason_codes: Vec<&'static str>,
    pub feedback_loop: Vec<&'static str>,
    pub rollout_policy: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelLayer {
    pub layer: &'static str,
    pub role: &'static str,
    pub output: &'static str,
    pub settlement_authority: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueueSummary {
    pub count: usize,
    pub severity: &'static str,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapReason {
    pub reason: &'static str,
    pub state: &'static str,
    pub advertiser_safe: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EligibilityBucket {
    pub state: &'static str,
    pub count: Option<i64>,
    pub payout_impact: &'static str,
    pub advertiser_impact: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventStateBucket {
    pub state: &'static str,
    pub bucket: &'static str,
    pub owner: &'static str,
    pub local_count: Option<i64>,
    pub can_bill_advertiser: bool,
    pub can_pay_developer: bool,
    pub local_desktop_authority: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct SurfaceAttestation {
    pub surface: String,
    pub detected: bool,
    pub enabled: bool,
    pub app_installed: bool,
    pub adapter_booted: bool,
    pub wait_state_visible: Option<bool>,
    pub ad_rendered: Option<bool>,
    pub threshold_reached: Option<bool>,
    pub under_caps: Option<bool>,
    pub official_adapter: bool,
    pub can_earn: bool,
    pub can_observe: bool,
    pub probe_mode_available: bool,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterSignal {
    pub signal: &'static str,
    pub severity: &'static str,
    pub local_evidence: String,
    pub backend_signal_needed: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdvertiserProtection {
    pub proof_statement: &'static str,
    pub billing_counts_backend_owned: bool,
    pub local_counts_are_not_invoiceable: bool,
    pub billed_impressions: Option<i64>,
    pub rejected_impressions: Option<i64>,
    pub refunded_impressions: Option<i64>,
    pub suspicious_clusters_removed: Option<i64>,
    pub bot_filtered_reach: Option<i64>,
    pub campaign_exposure_limits: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrustLadderStep {
    pub step: &'static str,
    pub state: &'static str,
    pub unlocks: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeMode {
    pub enabled: bool,
    pub event_state: &'static str,
    pub can_create_payable_events: bool,
    pub statement: &'static str,
    pub safe_commands: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SafetyPolicy {
    pub earning_integrity_invariant: &'static str,
    pub official_adapters_only: bool,
    pub dashboard_may_read: Vec<&'static str>,
    pub dashboard_must_not: Vec<&'static str>,
    pub event_states: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventProof {
    pub advertiser: String,
    pub ad_id: String,
    pub observed_ms: i64,
    pub state: &'static str,
    pub classification: &'static str,
    pub billable: bool,
    pub payable: bool,
    pub backend_required: Vec<&'static str>,
    pub proof: &'static str,
}

pub fn current(archive: &Archive) -> Result<TrustEngineSnapshot> {
    let now = util::now_ms();
    let stats = archive.stats(now)?;
    let sync = sync_health::current(archive)?;
    let integrations = integrations::integrations()?;
    let recent = archive.recent_ledger(8)?;

    let held_for_sync_review = held_for_sync_review_count(&sync);
    let suspicious_count = suspicious_event_count(&stats, &sync);
    let active_surface_count = integrations.iter().filter(|i| i.enabled).count();
    let official_earning_surface_count = integrations
        .iter()
        .filter(|i| is_official_earning_adapter(i))
        .count();

    let user_risk_score = risk_score(
        18,
        [
            (sync.severity == sync_health::SyncSeverity::Critical, 22),
            (sync.local_events_after_account_sync > 0, 4),
            (stats.sightings_today > 250, 14),
            (stats.sightings_today > 1000, 18),
            (active_surface_count > 3, 10),
        ],
    );
    let surface_risk_score = risk_score(
        14,
        [
            (official_earning_surface_count == 0, 18),
            (sync.severity == sync_health::SyncSeverity::Critical, 18),
            (stats.sightings_today > 250, 12),
            (active_surface_count > 3, 10),
            (
                sync.recent_metric_sends == 0 && stats.total_sightings > 0,
                12,
            ),
        ],
    );

    Ok(TrustEngineSnapshot {
        title: "Kickbacks Trust Engine",
        pitch: "Official adapters create earning candidates; backend ledgers decide settlement; ML contributes data points, not payout authority.",
        mode: "read-only local trust ledger plus backend-required fraud contract",
        trust_boundaries: trust_boundaries(),
        backend_owned_boundaries: backend_owned_boundaries(),
        settlement_gates: settlement_gates(&sync, official_earning_surface_count),
        finality_model: finality_model(),
        advertiser_assurance: advertiser_assurance_report(),
        threat_model: threat_model(),
        ml_signal_layer: ml_signal_layer(),
        user_risk_score,
        user_risk_band: band(user_risk_score),
        surface_risk_score,
        surface_risk_band: band(surface_risk_score),
        advertiser_refund_exposure: ExposureSummary {
            status: if held_for_sync_review > 0 {
                "ledger_visibility_review"
            } else {
                "local_only_no_billing_claim"
            },
            local_visible_non_billable: stats.total_sightings,
            held_for_sync_review,
            backend_required: vec![
                "billed impression ledger",
                "refund ledger",
                "campaign exposure limits",
                "IP/ASN/device cluster graph",
                "Stripe payout hold state",
            ],
        },
        suspicious_event_queue: QueueSummary {
            count: suspicious_count,
            severity: if suspicious_count > 0 { "review" } else { "clear" },
            reason: suspicious_reason(&stats, &sync),
        },
        payout_hold_queue: QueueSummary {
            count: held_for_sync_review,
            severity: if held_for_sync_review > 0 {
                "hold_until_reconciled"
            } else {
                "clear"
            },
            reason: if held_for_sync_review > 0 {
                "Local adapter sends are newer than the visible account ledger watermark; this should trigger account-display reconciliation, not a claim that Stripe delivery failed. Backend acceptance still owns payability.".to_string()
            } else {
                "No local evidence currently requires a payout hold.".to_string()
            },
        },
        cap_reason_ledger: cap_reason_ledger(),
        earning_eligibility_state: eligibility_buckets(&stats, held_for_sync_review),
        event_state_buckets: event_state_buckets(&stats, held_for_sync_review),
        surface_attestations: surface_attestations(&integrations, &sync),
        cluster_detection: cluster_signals(&stats, &sync, active_surface_count),
        advertiser_protection: advertiser_protection(),
        trusted_user_ladder: trusted_user_ladder(active_surface_count),
        non_earning_probe_mode: ProbeMode {
            enabled: true,
            event_state: "probe_non_earning",
            can_create_payable_events: false,
            statement: "Install, repair, doctor, skills, dashboard, and Trust Engine flows are probe-only: they can validate setup without creating payable events.",
            safe_commands: vec![
                "kickbacks doctor",
                "kickbacks sync status",
                "kickbacks api trust",
                "kickbacks install --all --yes",
                "kickbacks repair --all --yes",
            ],
        },
        safety_policy: SafetyPolicy {
            earning_integrity_invariant:
                "Only official earning adapters may report eligible impressions, views, or clicks. Everything else is read-only observation, diagnosis, or non-earning probe mode.",
            official_adapters_only: true,
            dashboard_may_read: vec![
                "local archive",
                "debug log tail",
                "account ledger watermark",
                "install status",
                "backend-provided trust summaries",
            ],
            dashboard_must_not: vec![
                "post metrics",
                "retry earning events",
                "hold Stripe secrets",
                "create charges",
                "fabricate impressions",
                "turn repair tests into payable events",
            ],
            event_states: event_state_names(),
        },
        recent_event_proofs: recent_event_proofs(recent),
    })
}

fn event_state_names() -> Vec<&'static str> {
    EVENT_STATES.to_vec()
}

fn held_for_sync_review_count(sync: &sync_health::SyncHealth) -> usize {
    if sync.local_events_after_account_sync > 0 && sync.severity != sync_health::SyncSeverity::Ok {
        sync.local_events_after_account_sync
    } else {
        0
    }
}

fn is_official_earning_adapter(item: &integrations::IntegrationStatus) -> bool {
    item.id == "vscode"
        && item.detected
        && matches!(&item.capability, integrations::IntegrationCapability::Earn)
}

fn risk_score<const N: usize>(base: u8, additions: [(bool, u8); N]) -> u8 {
    additions
        .into_iter()
        .fold(
            base,
            |score, (on, add)| {
                if on {
                    score.saturating_add(add)
                } else {
                    score
                }
            },
        )
        .min(100)
}

fn band(score: u8) -> &'static str {
    match score {
        0..=24 => "low",
        25..=49 => "watch",
        50..=74 => "review",
        _ => "hold",
    }
}

fn suspicious_event_count(stats: &Stats, sync: &sync_health::SyncHealth) -> usize {
    let mut count = 0;
    if sync.severity != sync_health::SyncSeverity::Ok && sync.local_events_after_account_sync > 0 {
        count += sync.local_events_after_account_sync;
    }
    if stats.sightings_today > 250 {
        count += 1;
    }
    if sync.recent_metric_sends == 0 && stats.total_sightings > 0 {
        count += 1;
    }
    count
}

fn suspicious_reason(stats: &Stats, sync: &sync_health::SyncHealth) -> String {
    if sync.severity != sync_health::SyncSeverity::Ok && sync.local_events_after_account_sync > 0 {
        return format!(
            "{} local metric sends need account-ledger reconciliation before any payout release",
            sync.local_events_after_account_sync
        );
    }
    if stats.sightings_today > 250 {
        return format!(
            "{} local sightings in the last day should be checked against caps and wait-state diversity",
            stats.sightings_today
        );
    }
    if sync.recent_metric_sends == 0 && stats.total_sightings > 0 {
        return "Local archive has sightings but no recent metric send in the scanned log tail"
            .to_string();
    }
    "No local suspicious queue items; backend cluster signals are still required for advertiser-grade proof.".to_string()
}

fn cap_reason_ledger() -> Vec<CapReason> {
    vec![
        CapReason {
            reason: "hourly_cap",
            state: "cap_extra_events_as_visible_non_billable",
            advertiser_safe: true,
        },
        CapReason {
            reason: "daily_cap",
            state: "eligible_but_capped_after_limit",
            advertiser_safe: true,
        },
        CapReason {
            reason: "new_account_velocity",
            state: "hold_for_review_or_delay_payout",
            advertiser_safe: true,
        },
        CapReason {
            reason: "parallel_agent_limit",
            state: "cap_or_hold_when_concurrent_earners_exceed_policy",
            advertiser_safe: true,
        },
        CapReason {
            reason: "probe_mode",
            state: "non_earning_test_event",
            advertiser_safe: true,
        },
    ]
}

fn backend_owned_boundaries() -> Vec<BackendOwnedBoundary> {
    vec![
        BackendOwnedBoundary {
            decision: "adapter_receipt_acceptance",
            why_backend_owned:
                "server nonce, adapter signing keys, duplicate rejection, and replay defense are not knowable from the desktop archive",
            local_snapshot_policy:
                "show adapter candidates only; never treat a local render or log line as accepted",
        },
        BackendOwnedBoundary {
            decision: "billable_event_creation",
            why_backend_owned:
                "campaign budget, exposure ceilings, advertiser contracts, and accepted-event ledgers live on the backend",
            local_snapshot_policy:
                "do not create, retry, or imply payable/billing events from dashboard, doctor, repair, skills, or trust views",
        },
        BackendOwnedBoundary {
            decision: "cap_and_velocity_enforcement",
            why_backend_owned:
                "hourly, daily, new-account, per-surface, and campaign caps require a global view across machines and users",
            local_snapshot_policy:
                "name the cap reason and mark local evidence provisional until backend enforcement returns",
        },
        BackendOwnedBoundary {
            decision: "fraud_cluster_or_ivt_decision",
            why_backend_owned:
                "IP, ASN, device, payout identity, account graph, and advertiser-wide traffic quality require cross-user correlation",
            local_snapshot_policy:
                "surface local cadence and missing-proof signals only; no local fraud acquittal",
        },
        BackendOwnedBoundary {
            decision: "refund_or_credit_decision",
            why_backend_owned:
                "advertiser credits depend on the billing ledger, refund window, campaign period, and final invalid-traffic decision",
            local_snapshot_policy:
                "display backend-provided refund exposure only; local counts remain non-invoiceable",
        },
        BackendOwnedBoundary {
            decision: "payout_hold_or_release",
            why_backend_owned:
                "Stripe/KYC/1099 readiness, held balances, refund buffers, and payout schedules are backend plus Stripe Connect concerns",
            local_snapshot_policy:
                "hold claims at the trust boundary; never let desktop state release or promise funds",
        },
    ]
}

fn trust_boundaries() -> Vec<TrustBoundary> {
    vec![
        TrustBoundary {
            stage: "local_observation",
            owner: "desktop app / local archive",
            evidence: vec![
                "cli-ad.json creative",
                "debug.log lifecycle tail",
                "archive sighting row",
            ],
            allowed_to_advance: "visible_but_non_billable only",
            can_make_payable: false,
            failure_mode: "Local archive is useful proof for the user, but cannot bill an advertiser.",
        },
        TrustBoundary {
            stage: "official_adapter_attestation",
            owner: "Kickbacks earning adapter",
            evidence: vec![
                "adapter identity",
                "adapter version",
                "surface id",
                "render event",
                "wait-state threshold",
                "monotonic sequence",
                "server nonce or signed receipt",
            ],
            allowed_to_advance: "eligible or eligible_but_capped candidate",
            can_make_payable: false,
            failure_mode:
                "An adapter can prove a candidate event, but payability still waits for backend caps and fraud checks.",
        },
        TrustBoundary {
            stage: "backend_acceptance",
            owner: "Kickbacks backend trust service",
            evidence: vec![
                "account/session graph",
                "IP/ASN/device cluster checks",
                "velocity limits",
                "cap ledger",
                "campaign exposure limits",
                "duplicate-event rejection",
            ],
            allowed_to_advance: "billable, held_for_review, rejected, or fraudulent",
            can_make_payable: true,
            failure_mode:
                "Without backend acceptance, a local or adapter event must remain non-payable or held.",
        },
        TrustBoundary {
            stage: "advertiser_settlement",
            owner: "Kickbacks billing/refund ledger",
            evidence: vec![
                "eligible event ledger",
                "rejected event ledger",
                "refund ledger",
                "bot-filtered reach report",
                "campaign spend ceiling",
            ],
            allowed_to_advance: "invoiceable or refundable advertiser ledger row",
            can_make_payable: false,
            failure_mode:
                "Advertisers need gross, filtered, rejected, refunded, and final billable counts split apart.",
        },
        TrustBoundary {
            stage: "stripe_payout_finality",
            owner: "Kickbacks backend plus Stripe Connect",
            evidence: vec![
                "Connect account requirements",
                "KYC status",
                "held balance",
                "refund buffer",
                "payout schedule",
                "1099/reporting state",
            ],
            allowed_to_advance: "developer payout release",
            can_make_payable: false,
            failure_mode:
                "Stripe payout readiness is downstream of accepted earning and cannot repair trust gaps.",
        },
    ]
}

fn settlement_gates(
    sync: &sync_health::SyncHealth,
    official_earning_surface_count: usize,
) -> Vec<SettlementGate> {
    let sync_local_status = if sync.severity == sync_health::SyncSeverity::Critical {
        "delivery_or_auth_review"
    } else if sync.local_events_after_account_sync > 0 {
        "ledger_visibility_review"
    } else if sync.account_ledger_last_synced_ms.is_none() && sync.recent_metric_sends > 0 {
        "backend_required_no_visible_watermark"
    } else {
        "clear"
    };
    let sync_blocks_payout = sync_local_status != "clear";
    let adapter_local_status = if official_earning_surface_count > 0 {
        "official earning adapter observed locally; backend still verifies id/version/signature"
    } else {
        "no official earning adapter observed locally"
    };
    vec![
        SettlementGate {
            gate: "non_earning_probe_mode",
            required_evidence:
                "Install, repair, doctor, dashboard, and skills must be marked non-payable.",
            local_status: "implemented",
            backend_status: "must ignore probe events if ever reported",
            blocks_payout: true,
            protects_advertiser: true,
        },
        SettlementGate {
            gate: "official_adapter_only",
            required_evidence:
                "Event came from an approved earning adapter, not dashboard/skill/repair code.",
            local_status: adapter_local_status,
            backend_status: "must verify adapter id/version/signature",
            blocks_payout: true,
            protects_advertiser: true,
        },
        SettlementGate {
            gate: "sync_reconciliation",
            required_evidence:
                "Visible account ledger watermark catches up to adapter sends; local lag alone is not evidence of Stripe failure.",
            local_status: sync_local_status,
            backend_status: "must reconcile submitted events before payout release",
            blocks_payout: sync_blocks_payout,
            protects_advertiser: true,
        },
        SettlementGate {
            gate: "cap_and_velocity_engine",
            required_evidence:
                "Hourly, daily, per-surface, new-account, and parallel-agent caps applied.",
            local_status: "policy visible; backend required for enforcement",
            backend_status: "required",
            blocks_payout: true,
            protects_advertiser: true,
        },
        SettlementGate {
            gate: "cluster_and_ivt_filter",
            required_evidence:
                "IP/ASN/device/account graph, cadence, click/view, and wait-state diversity checks.",
            local_status: "backend_required",
            backend_status: "required",
            blocks_payout: true,
            protects_advertiser: true,
        },
        SettlementGate {
            gate: "refund_buffer",
            required_evidence: "Held balance window before Stripe payout finality.",
            local_status: "backend_required",
            backend_status: "required",
            blocks_payout: true,
            protects_advertiser: true,
        },
    ]
}

fn finality_model() -> FinalityModel {
    FinalityModel {
        invariant: "No event can become payable from local observation, installer probe, dashboard state, skill output, repair flow, or unauthenticated adapter telemetry.",
        payable_state: "accepted_billable_after_refund_window",
        billing_state_machine: vec![
            BillingState {
                state: "probe_non_earning",
                owner: "installer / repair / doctor / dashboard / skill",
                meaning: "Setup or diagnostics proved wiring only.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec!["probe_non_earning"],
            },
            BillingState {
                state: "observed_local",
                owner: "desktop archive",
                meaning: "A creative was observed locally; useful to the user, not billable, and unable to advance itself.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec!["observed_local"],
            },
            BillingState {
                state: "candidate_adapter_attested",
                owner: "official earning adapter",
                meaning: "Adapter claims render/wait-state threshold with official identity.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec![
                    "held_for_review",
                    "eligible_but_capped",
                    "rejected",
                    "fraudulent",
                    "backend_accepted",
                ],
            },
            BillingState {
                state: "held_for_review",
                owner: "backend trust service",
                meaning: "Potentially valid but blocked by delivery review, caps, velocity, cluster, or refund-buffer requirements.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec!["backend_accepted", "rejected", "fraudulent"],
            },
            BillingState {
                state: "eligible_but_capped",
                owner: "backend trust service",
                meaning: "Real attention, but no incremental bill or payout beyond policy caps.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec!["eligible_but_capped"],
            },
            BillingState {
                state: "backend_accepted",
                owner: "backend trust service",
                meaning: "Adapter proof, sync, caps, cluster checks, campaign limits, and duplicate rejection passed.",
                can_bill_advertiser: true,
                can_pay_developer: false,
                next_allowed: vec![
                    "accepted_billable_after_refund_window",
                    "refunded",
                    "rejected",
                    "fraudulent",
                ],
            },
            BillingState {
                state: "accepted_billable_after_refund_window",
                owner: "billing and payout ledger",
                meaning: "Advertiser ledger is final enough to release developer payout under Stripe policy.",
                can_bill_advertiser: true,
                can_pay_developer: true,
                next_allowed: vec!["paid", "refunded"],
            },
            BillingState {
                state: "paid",
                owner: "Stripe Connect payout flow",
                meaning: "Developer payout released after trust and refund windows.",
                can_bill_advertiser: true,
                can_pay_developer: true,
                next_allowed: vec!["paid"],
            },
            BillingState {
                state: "refunded",
                owner: "billing and refund ledger",
                meaning: "Advertiser was credited or refunded after invalid, reversed, or adjusted traffic.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec!["refunded"],
            },
            BillingState {
                state: "rejected",
                owner: "backend trust service",
                meaning: "Event is not billable and not payable.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec!["rejected"],
            },
            BillingState {
                state: "fraudulent",
                owner: "backend trust service",
                meaning: "Event/account/cluster is blocked and excluded from advertiser reach.",
                can_bill_advertiser: false,
                can_pay_developer: false,
                next_allowed: vec!["fraudulent"],
            },
        ],
        hard_stop_rules: vec![
            HardStopRule {
                rule: "sync_lag_after_account_watermark",
                action: "hold_all_newer_events",
                final_until: "backend ledger reconciliation proves acceptance or rejection",
            },
            HardStopRule {
                rule: "probe_or_repair_origin",
                action: "force_probe_non_earning",
                final_until: "forever; probes never become payable",
            },
            HardStopRule {
                rule: "unofficial_adapter_or_missing_signature",
                action: "reject_or_visible_non_billable",
                final_until: "official adapter attestation exists",
            },
            HardStopRule {
                rule: "cap_exceeded",
                action: "eligible_but_capped_or_visible_non_billable",
                final_until: "cap window resets or trust tier increases",
            },
            HardStopRule {
                rule: "cluster_fraud_or_click_farm",
                action: "fraudulent_and_remove_from_billable_reach",
                final_until: "manual review clears the cluster with auditable evidence",
            },
            HardStopRule {
                rule: "stripe_kyc_or_1099_incomplete",
                action: "hold_payout_not_event_acceptance",
                final_until: "Stripe/Kickbacks payout requirements are complete",
            },
        ],
        finality_rules: vec![
            "Advertiser billable counts and developer payable counts are related but not identical.",
            "Every event keeps a terminal reason: paid, capped, rejected, fraudulent, refunded, or held.",
            "Refund windows and payout holds protect advertisers before developer payout finality.",
            "Manual review can release holds but must preserve the reason ledger.",
            "Dashboard and skills are never settlement authorities.",
        ],
    }
}

fn advertiser_assurance_report() -> AdvertiserAssuranceReport {
    AdvertiserAssuranceReport {
        title: "Advertiser Trust Assurance Report",
        proof_standard:
            "Show filtered, rejected, held, refunded, and final billable reach separately; never collapse them into one opaque impression count.",
        public_claim:
            "Kickbacks filters invalid traffic before payout finality and gives advertisers an auditable reason ledger for every non-billable or refunded event.",
        required_tables: vec![
            AssuranceTable {
                table: "event_classification_ledger",
                grain: "one row per adapter event",
                purpose: "Explain each event's current and terminal state.",
                minimum_fields: vec![
                    "event_id",
                    "campaign_id",
                    "advertiser_id",
                    "publisher_user_id",
                    "surface_id",
                    "adapter_id",
                    "adapter_version",
                    "event_state",
                    "reason_code",
                    "observed_at",
                    "accepted_at",
                    "terminal_at",
                ],
            },
            AssuranceTable {
                table: "adapter_attestation_ledger",
                grain: "one row per official adapter receipt",
                purpose: "Prove the event came from an official earning adapter and a visible wait state.",
                minimum_fields: vec![
                    "receipt_id",
                    "event_id",
                    "server_nonce_id",
                    "adapter_signature",
                    "surface_id",
                    "render_started_at",
                    "threshold_reached_at",
                    "viewport_or_wait_state_proof",
                ],
            },
            AssuranceTable {
                table: "fraud_cluster_ledger",
                grain: "one row per cluster decision",
                purpose: "Prove bot farms, click farms, and parallel-agent clusters were removed or held.",
                minimum_fields: vec![
                    "cluster_id",
                    "cluster_type",
                    "risk_score",
                    "accounts_impacted",
                    "events_impacted",
                    "decision",
                    "reviewer_or_rule_id",
                    "decision_at",
                ],
            },
            AssuranceTable {
                table: "advertiser_refund_ledger",
                grain: "one row per campaign/refund adjustment",
                purpose: "Tie invalid or reversed traffic to advertiser credit/refund exposure.",
                minimum_fields: vec![
                    "advertiser_id",
                    "campaign_id",
                    "period",
                    "gross_events",
                    "rejected_events",
                    "refunded_events",
                    "final_billable_events",
                    "refund_amount",
                    "refund_reason",
                ],
            },
            AssuranceTable {
                table: "payout_hold_ledger",
                grain: "one row per user hold or release",
                purpose: "Prove developer payouts wait until trust and refund windows clear.",
                minimum_fields: vec![
                    "user_id",
                    "hold_id",
                    "hold_reason",
                    "held_amount",
                    "events_covered",
                    "opened_at",
                    "released_at",
                    "release_reason",
                ],
            },
        ],
        control_evidence: vec![
            ControlEvidence {
                control: "official_adapter_only",
                evidence: "Adapter id/version/signature plus server nonce; dashboard and repair code paths cannot post metrics.",
                advertiser_visible: true,
            },
            ControlEvidence {
                control: "non_earning_probe_mode",
                evidence: "Installer, repair, doctor, app, and skills are classified as non-payable forever.",
                advertiser_visible: true,
            },
            ControlEvidence {
                control: "cap_and_velocity_limits",
                evidence:
                    "Per-user, per-surface, new-account, parallel-agent, hourly, and daily cap reason ledger.",
                advertiser_visible: true,
            },
            ControlEvidence {
                control: "cluster_filtering",
                evidence: "IP/ASN/device/account/cadence/click-view/wait-state diversity cluster decisions.",
                advertiser_visible: true,
            },
            ControlEvidence {
                control: "refund_buffer_before_payout",
                evidence:
                    "Held balances are not released to Stripe payout until advertiser refund windows and review holds clear.",
                advertiser_visible: true,
            },
        ],
        report_metrics: vec![
            AdvertiserMetric {
                metric: "gross_adapter_events",
                definition: "All official adapter events before trust filtering.",
                source: "adapter_attestation_ledger",
            },
            AdvertiserMetric {
                metric: "held_events",
                definition: "Events blocked from billing/payout pending sync, cap, cluster, or review clearance.",
                source: "event_classification_ledger",
            },
            AdvertiserMetric {
                metric: "rejected_or_fraudulent_events",
                definition: "Events removed from billable reach with terminal reason codes.",
                source: "event_classification_ledger and fraud_cluster_ledger",
            },
            AdvertiserMetric {
                metric: "refunded_events",
                definition: "Previously billed events credited back to advertisers.",
                source: "advertiser_refund_ledger",
            },
            AdvertiserMetric {
                metric: "final_billable_reach",
                definition: "Events remaining after invalid traffic filtering, caps, holds, and refund adjustments.",
                source: "advertiser_refund_ledger",
            },
            AdvertiserMetric {
                metric: "payouts_released_after_trust_window",
                definition: "Developer payouts released only after trust gates and refund buffer clear.",
                source: "payout_hold_ledger and Stripe Connect payout state",
            },
        ],
        audit_artifacts: vec![
            "monthly advertiser trust report",
            "campaign-level invalid traffic appendix",
            "cluster decision export with reason codes",
            "refund and credit memo ledger",
            "payout hold/release ledger",
            "adapter version and signing-key change log",
        ],
    }
}

fn threat_model() -> Vec<ThreatModelItem> {
    vec![
        ThreatModelItem {
            threat: "ad_fraud_cost_inflation",
            standard_or_taxonomy: "OWASP OAT-003 Cost-Inflation Fraud / Ad Fraud",
            attacker_goal: "inflate payable ad views or clicks to drain advertiser budgets",
            required_controls: vec![
                "official adapter attestation",
                "server nonce or signed receipt",
                "duplicate rejection",
                "cap ledger",
                "held payout until backend acceptance",
            ],
        },
        ThreatModelItem {
            threat: "metric_skewing",
            standard_or_taxonomy: "OWASP OAT-016 Skewing",
            attacker_goal: "distort campaign analytics or trust scores without necessarily creating valid billable events",
            required_controls: vec![
                "separate observed, eligible, billed, rejected, and refunded counts",
                "non-earning probe mode",
                "bot-filtered reach reporting",
            ],
        },
        ThreatModelItem {
            threat: "fake_or_farmed_accounts",
            standard_or_taxonomy: "OWASP OAT-019 Account Creation plus IVT practice",
            attacker_goal: "farm new accounts, parallel agents, or duplicate devices for payout extraction",
            required_controls: vec![
                "trusted user ladder",
                "new-account caps",
                "Stripe/KYC requirements",
                "account/device/IP/ASN cluster graph",
                "refund buffer before payout finality",
            ],
        },
        ThreatModelItem {
            threat: "invalid_traffic",
            standard_or_taxonomy: "MRC IVT / IAB bots and spiders practice",
            attacker_goal: "make non-human or non-measurable activity look like legitimate attention",
            required_controls: vec![
                "GIVT/SIVT-style filter buckets",
                "known bot/spider filtering",
                "wait-state and viewability proof",
                "human-use pattern checks",
                "advertiser-visible rejected/refunded ledger",
            ],
        },
    ]
}

fn ml_signal_layer() -> MlSignalLayer {
    MlSignalLayer {
        title: "ML fraud signals, not payout authority",
        authority_boundary:
            "ML outputs are data points and reason-code candidates. Deterministic policy, manual review, and the backend event state machine decide settlement.",
        labeled_training_data:
            "Known bot accounts and bot events already labeled by Kickbacks should bootstrap supervised training, validation, and precision/recall reporting.",
        feature_row: vec![
            "account_age",
            "kyc_status",
            "surface_type",
            "adapter_version",
            "session_duration",
            "wait_state_duration",
            "render_to_threshold_ms",
            "events_per_hour",
            "events_per_day",
            "click_view_ratio",
            "advertiser_mix",
            "device_fingerprint_stability",
            "ip_asn_reputation",
            "geovelocity",
            "parallel_agent_count",
            "account_cluster_similarity",
            "refund_reversal_history",
            "campaign_concentration",
        ],
        model_layers: vec![
            ModelLayer {
                layer: "supervised_event_classifier",
                role:
                    "Use known labeled bots and clean reviewed traffic to score candidate events at ingestion.",
                output:
                    "risk data point plus reason-code candidates such as known_bot_similarity or new_account_high_velocity",
                settlement_authority:
                    "cannot pay or reject by itself; feeds state-machine evidence and review queues",
            },
            ModelLayer {
                layer: "graph_cluster_model",
                role:
                    "Connect accounts, devices, IPs, ASNs, adapters, surfaces, campaigns, and payout identities.",
                output:
                    "cluster data points such as shared_device_fingerprint, farmed_asn_cluster, or campaign_concentration_high",
                settlement_authority:
                    "can recommend hold/review but policy ledger owns the transition",
            },
            ModelLayer {
                layer: "surface_behavior_anomaly_model",
                role:
                    "Learn normal developer-tool behavior per surface and detect cadence or wait-state patterns that simple thresholds miss.",
                output:
                    "anomaly data points such as wait_state_entropy_low, impossible_cadence, or parallel_agent_pattern_shift",
                settlement_authority:
                    "adds evidence only; manual review and deterministic caps remain decisive",
            },
        ],
        reason_codes: vec![
            "known_bot_similarity",
            "high_parallelism_cluster",
            "new_account_high_velocity",
            "shared_device_fingerprint",
            "wait_state_entropy_low",
            "click_view_ratio_abnormal",
            "campaign_concentration_high",
            "asn_cluster_risk",
            "refund_reversal_similarity",
        ],
        feedback_loop: vec![
            "manual_review_decisions",
            "known_bot_labels",
            "released_hold_negative_examples",
            "advertiser_refunds",
            "payout_reversals",
            "chargebacks_or_disputes",
            "confirmed_clean_power_users",
        ],
        rollout_policy: vec![
            "start with shadow scoring and calibration against known labeled bots",
            "graduate to review queue prioritization when precision is measurable",
            "allow holds only when model signals combine with deterministic policy evidence",
            "reserve rejection for policy violations, duplicate/replay proof, confirmed bot labels, or high-precision reviewed clusters",
            "publish model reason codes into the event classification ledger",
        ],
    }
}

fn eligibility_buckets(stats: &Stats, held_for_sync_review: usize) -> Vec<EligibilityBucket> {
    vec![
        EligibilityBucket {
            state: "probe_non_earning",
            count: None,
            payout_impact: "never payable",
            advertiser_impact: "never billable",
        },
        EligibilityBucket {
            state: "eligible",
            count: None,
            payout_impact: "not payable until backend acceptance and the refund window both clear",
            advertiser_impact: "not billable until backend_accepted",
        },
        EligibilityBucket {
            state: "eligible_but_capped",
            count: None,
            payout_impact: "visible to user, no incremental payout beyond cap",
            advertiser_impact: "not over-billed beyond campaign/cap policy",
        },
        EligibilityBucket {
            state: "visible_but_non_billable",
            count: Some(stats.total_sightings),
            payout_impact: "local proof only; not payable from the desktop archive",
            advertiser_impact: "not billed unless official adapter and backend accept it",
        },
        EligibilityBucket {
            state: "held_for_review",
            count: Some(held_for_sync_review as i64),
            payout_impact:
                "held only when backend acceptance, caps, or cluster checks have not cleared",
            advertiser_impact: "protected by delayed payout and refund buffer",
        },
        EligibilityBucket {
            state: "rejected",
            count: None,
            payout_impact: "not paid",
            advertiser_impact: "not billed; if previously billed, credited or refunded",
        },
        EligibilityBucket {
            state: "fraudulent",
            count: None,
            payout_impact: "blocked, withheld, or escalated",
            advertiser_impact: "removed from reach and refund exposure",
        },
    ]
}

fn event_state_buckets(stats: &Stats, held_for_sync_review: usize) -> Vec<EventStateBucket> {
    vec![
        EventStateBucket {
            state: "probe_non_earning",
            bucket: "setup_and_diagnostics",
            owner: "installer / repair / doctor / dashboard / skill",
            local_count: None,
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority: "desktop can create this bucket only; it never upgrades",
        },
        EventStateBucket {
            state: "observed_local",
            bucket: "local_archive_visibility",
            owner: "desktop archive",
            local_count: Some(stats.total_sightings),
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority:
                "desktop can count local observations but cannot promote them to earning candidates",
        },
        EventStateBucket {
            state: "candidate_adapter_attested",
            bucket: "official_adapter_candidate",
            owner: "official earning adapter",
            local_count: None,
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority:
                "desktop may display candidate receipts only when backend or adapter provides them",
        },
        EventStateBucket {
            state: "held_for_review",
            bucket: "trust_or_sync_hold",
            owner: "backend trust service",
            local_count: Some(held_for_sync_review as i64),
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority:
                "desktop may recommend a hold for visible lag, but backend owns release",
        },
        EventStateBucket {
            state: "eligible_but_capped",
            bucket: "valid_attention_no_incremental_money",
            owner: "backend trust service",
            local_count: None,
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority: "desktop can name cap policy; backend owns cap arithmetic",
        },
        EventStateBucket {
            state: "backend_accepted",
            bucket: "billable_not_payable_yet",
            owner: "backend trust service",
            local_count: None,
            can_bill_advertiser: true,
            can_pay_developer: false,
            local_desktop_authority: "desktop may show backend-provided accepted counts only",
        },
        EventStateBucket {
            state: "accepted_billable_after_refund_window",
            bucket: "payable_after_trust_window",
            owner: "billing and payout ledger",
            local_count: None,
            can_bill_advertiser: true,
            can_pay_developer: true,
            local_desktop_authority: "desktop may show backend-provided payout-ready counts only",
        },
        EventStateBucket {
            state: "paid",
            bucket: "payout_released",
            owner: "Stripe Connect payout flow",
            local_count: None,
            can_bill_advertiser: true,
            can_pay_developer: true,
            local_desktop_authority: "desktop may display Stripe/backend payout status only",
        },
        EventStateBucket {
            state: "refunded",
            bucket: "advertiser_credit_or_refund",
            owner: "billing and refund ledger",
            local_count: None,
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority: "desktop may display backend-provided refund status only",
        },
        EventStateBucket {
            state: "rejected",
            bucket: "terminal_non_billable",
            owner: "backend trust service",
            local_count: None,
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority: "desktop may display backend-provided rejection reasons only",
        },
        EventStateBucket {
            state: "fraudulent",
            bucket: "terminal_invalid_traffic",
            owner: "backend trust service",
            local_count: None,
            can_bill_advertiser: false,
            can_pay_developer: false,
            local_desktop_authority: "desktop may display backend-provided fraud outcomes only",
        },
    ]
}

fn surface_attestations(
    integrations: &[integrations::IntegrationStatus],
    sync: &sync_health::SyncHealth,
) -> Vec<SurfaceAttestation> {
    integrations
        .iter()
        .map(|item| {
            let declares_earn = matches!(&item.capability, integrations::IntegrationCapability::Earn);
            let can_observe = matches!(
                &item.capability,
                integrations::IntegrationCapability::Earn
                    | integrations::IntegrationCapability::Observe
            );
            let official_adapter = is_official_earning_adapter(item);
            let can_earn = official_adapter;
            let wait_state_visible = if item.id == "vscode" {
                Some(sync.last_metric_send_ms.is_some())
            } else {
                None
            };
            let threshold_reached = if item.id == "vscode" {
                sync.last_metric_event
                    .as_deref()
                    .map(|event| event.contains("view") || event.contains("threshold"))
            } else {
                None
            };
            SurfaceAttestation {
                surface: item.label.to_string(),
                detected: item.detected,
                enabled: item.enabled,
                app_installed: item.detected,
                adapter_booted: item.enabled,
                wait_state_visible,
                ad_rendered: wait_state_visible,
                threshold_reached,
                under_caps: None,
                official_adapter,
                can_earn,
                can_observe,
                probe_mode_available: true,
                state: if official_adapter {
                    "official adapter candidate detected; backend signature/cap/cluster checks still required"
                        .to_string()
                } else if declares_earn {
                    "local earning wiring detected, but backend adapter attestation is still required"
                        .to_string()
                } else if item.detected {
                    "detected, but earning requires official adapter attestation".to_string()
                } else {
                    "missing or not detected".to_string()
                },
            }
        })
        .collect()
}

fn cluster_signals(
    stats: &Stats,
    sync: &sync_health::SyncHealth,
    active_surface_count: usize,
) -> Vec<ClusterSignal> {
    vec![
        ClusterSignal {
            signal: "many_accounts_same_ip_asn_device",
            severity: "backend_required",
            local_evidence: "not observable from local desktop archive".to_string(),
            backend_signal_needed: "IP, ASN, device fingerprint, account graph",
        },
        ClusterSignal {
            signal: "identical_install_fingerprints",
            severity: "backend_required",
            local_evidence:
                "installer can report version/path, but global duplicate detection is backend-owned"
                    .to_string(),
            backend_signal_needed: "signed adapter install fingerprints",
        },
        ClusterSignal {
            signal: "impossible_cadence",
            severity: if stats.sightings_today > 250 {
                "review"
            } else {
                "watch"
            },
            local_evidence: format!("{} local sightings in the last day", stats.sightings_today),
            backend_signal_needed: "per-user and per-surface event cadence",
        },
        ClusterSignal {
            signal: "parallel_agent_explosion",
            severity: if active_surface_count > 3 {
                "review"
            } else {
                "watch"
            },
            local_evidence: format!("{active_surface_count} locally enabled surfaces detected"),
            backend_signal_needed: "active sessions per user across VS Code, Claude, Codex, Hermes",
        },
        ClusterSignal {
            signal: "click_only_behavior",
            severity: "backend_required",
            local_evidence: "local archive records visibility, not click conversion quality"
                .to_string(),
            backend_signal_needed: "click/view ratio and conversion sanity checks",
        },
        ClusterSignal {
            signal: "no_real_wait_state_diversity",
            severity: if sync.recent_metric_sends == 0 {
                "watch"
            } else {
                "clear"
            },
            local_evidence: format!(
                "{} recent metric sends in scanned log tail",
                sync.recent_metric_sends
            ),
            backend_signal_needed: "wait-state duration distribution by surface",
        },
        ClusterSignal {
            signal: "new_account_high_earnings_velocity",
            severity: "backend_required",
            local_evidence: "desktop does not know account age or actual payout balance"
                .to_string(),
            backend_signal_needed: "account age, Stripe/KYC state, payout velocity",
        },
    ]
}

fn advertiser_protection() -> AdvertiserProtection {
    AdvertiserProtection {
        proof_statement: "Advertisers should see gross observed events split into eligible, capped, held, rejected, fraudulent, refunded, and bot-filtered reach buckets.",
        billing_counts_backend_owned: true,
        local_counts_are_not_invoiceable: true,
        billed_impressions: None,
        rejected_impressions: None,
        refunded_impressions: None,
        suspicious_clusters_removed: None,
        bot_filtered_reach: None,
        campaign_exposure_limits: vec![
            "per-user hourly and daily caps",
            "per-surface caps",
            "new-account caps",
            "parallel-agent caps",
            "campaign-level spend and reach ceilings",
            "refund buffer before payout finality",
        ],
    }
}

fn trusted_user_ladder(active_surface_count: usize) -> Vec<TrustLadderStep> {
    vec![
        TrustLadderStep {
            step: "signed_in",
            state: "required",
            unlocks: "basic earning eligibility",
        },
        TrustLadderStep {
            step: "stripe_kyc_complete",
            state: "backend_required",
            unlocks: "payout release",
        },
        TrustLadderStep {
            step: "account_age",
            state: "backend_required",
            unlocks: "higher caps over time",
        },
        TrustLadderStep {
            step: "stable_device",
            state: "backend_required",
            unlocks: "lower review friction",
        },
        TrustLadderStep {
            step: "surface_diversity",
            state: if active_surface_count > 0 {
                "local_signal"
            } else {
                "missing"
            },
            unlocks: "normal developer-tool usage pattern",
        },
        TrustLadderStep {
            step: "low_reversal_rate",
            state: "backend_required",
            unlocks: "trusted account promotion",
        },
        TrustLadderStep {
            step: "normal_parallelism",
            state: if active_surface_count <= 3 {
                "local_signal"
            } else {
                "review"
            },
            unlocks: "parallel-agent usage without farm-like behavior",
        },
    ]
}

fn recent_event_proofs(events: Vec<LedgerEvent>) -> Vec<EventProof> {
    events
        .into_iter()
        .map(|event| EventProof {
            advertiser: event.advertiser,
            ad_id: event.ad_id,
            observed_ms: event.observed_ms,
            state: "observed_local",
            classification: "visible_but_non_billable",
            billable: false,
            payable: false,
            backend_required: vec![
                "official adapter receipt",
                "backend duplicate/cap/cluster checks",
                "accepted event ledger row",
            ],
            proof: "Local archive sighting proves the creative was observed by this machine; payability requires official adapter threshold and backend acceptance.",
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CliAd;

    fn ad(text: &str, url: &str, ts: i64) -> CliAd {
        CliAd {
            ad_text: text.to_string(),
            click_url: Some(url.to_string()),
            icon_url: None,
            icon_ref: None,
            ts,
        }
    }

    #[test]
    fn trust_engine_names_two_way_ledger_and_probe_mode() {
        let mut archive = Archive::open_in_memory().unwrap();
        archive
            .capture_ad(&ad("Aikido - secure code", "https://aikido.dev/", 100), 200)
            .unwrap();
        let snapshot = current(&archive).unwrap();
        assert!(snapshot.pitch.contains("backend ledgers decide settlement"));
        assert!(snapshot.non_earning_probe_mode.enabled);
        assert!(snapshot
            .trust_boundaries
            .iter()
            .any(|b| b.stage == "backend_acceptance" && b.can_make_payable));
        assert_eq!(
            snapshot.finality_model.payable_state,
            "accepted_billable_after_refund_window"
        );
        assert!(snapshot
            .advertiser_assurance
            .public_claim
            .contains("auditable reason ledger"));
        assert!(snapshot
            .ml_signal_layer
            .authority_boundary
            .contains("data points"));
        assert!(snapshot
            .ml_signal_layer
            .labeled_training_data
            .contains("labeled by Kickbacks"));
        assert!(snapshot
            .safety_policy
            .event_states
            .contains(&"held_for_review"));
        assert_eq!(
            snapshot.recent_event_proofs[0].classification,
            "visible_but_non_billable"
        );
    }

    #[test]
    fn safety_surfaces_do_not_call_metrics_routes() {
        let dashboard = include_str!("app.rs");
        let installer = include_str!("install_system.rs");
        let note = include_str!("developer_note.rs");
        for source in [dashboard, installer, note] {
            assert!(!source.contains("/v1/metrics"));
            assert!(!source.contains("/v1/events"));
            assert!(!source.contains("metrics.kickbacks"));
            assert!(!source.contains("fetch(\"/v1"));
            assert!(!source.contains("fetch('/v1"));
        }
    }

    #[test]
    fn only_backend_acceptance_can_make_events_payable() {
        let archive = Archive::open_in_memory().unwrap();
        let snapshot = current(&archive).unwrap();
        for boundary in &snapshot.trust_boundaries {
            if boundary.can_make_payable {
                assert_eq!(boundary.stage, "backend_acceptance");
            } else {
                assert_ne!(boundary.stage, "backend_acceptance");
            }
        }
        assert!(snapshot
            .settlement_gates
            .iter()
            .any(|gate| gate.gate == "non_earning_probe_mode" && gate.blocks_payout));
        for state in &snapshot.finality_model.billing_state_machine {
            if state.can_pay_developer {
                assert!(
                    state.state == "accepted_billable_after_refund_window" || state.state == "paid"
                );
            }
            if state.state == "probe_non_earning" {
                assert!(!state
                    .next_allowed
                    .iter()
                    .any(|next| next.contains("accepted")));
            }
        }
        assert!(snapshot
            .threat_model
            .iter()
            .any(|threat| threat.threat == "ad_fraud_cost_inflation"));
    }

    #[test]
    fn advertiser_assurance_exposes_filtered_counts_and_evidence() {
        let archive = Archive::open_in_memory().unwrap();
        let snapshot = current(&archive).unwrap();
        let metrics: Vec<&str> = snapshot
            .advertiser_assurance
            .report_metrics
            .iter()
            .map(|m| m.metric)
            .collect();
        for metric in [
            "gross_adapter_events",
            "held_events",
            "rejected_or_fraudulent_events",
            "refunded_events",
            "final_billable_reach",
        ] {
            assert!(
                metrics.contains(&metric),
                "missing advertiser metric {metric}"
            );
        }
        assert!(snapshot
            .advertiser_assurance
            .control_evidence
            .iter()
            .any(|c| c.control == "refund_buffer_before_payout" && c.advertiser_visible));
    }
}
