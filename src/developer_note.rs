use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DeveloperNote {
    pub title: &'static str,
    pub audience: &'static str,
    pub tone: &'static str,
    pub summary: &'static str,
    pub availability: &'static str,
    pub principles: [&'static str; 6],
    pub implementation_offer: [&'static str; 6],
    pub technical_architecture: [&'static str; 6],
    pub ml_plan: [&'static str; 6],
    pub payout_review_note: &'static str,
    pub trust_pitch: &'static str,
    pub outreach_reply: &'static str,
    pub sync_lag_note: &'static str,
    pub stripe_note: &'static str,
}

pub fn note() -> DeveloperNote {
    DeveloperNote {
        title: "A plug-and-play trust layer for Kickbacks",
        audience: "Kickbacks.ai founder / maintainer",
        tone: "Excited, useful, founder-respecting, and contribution-ready",
        summary: "I have been using Kickbacks since yesterday, and the spark is obvious: developers instantly understand paid wait-state attention. The next product move is a desktop trust console that makes onboarding automatic, keeps earning integrity strict, and gives advertisers visible proof that billable reach is clean.",
        availability: "I am available for new opportunities like this: product-minded engineering across agent integrations, CLI systems, trust architecture, analytics, and developer experience.",
        principles: [
            "Automatic onboarding, explicit consent: install VS Code, Claude Code CLI, Codex CLI, Hermes Agent/TUI, and skills from one reversible flow.",
            "Official adapters are the only earning path; dashboard, skills, doctor, install, and repair stay read-only or probe-only.",
            "Ledger freshness is visible without claiming Stripe failure; payment transport and settlement stay backend-owned.",
            "The Trust Engine separates observed, eligible, capped, held, rejected, refunded, fraudulent, and final billable-reach states.",
            "Advertiser proof is first-class: signed adapter evidence, invalid-traffic reason codes, refund ledger, and payout hold/release ledger.",
            "Stripe Connect stays server-side: the desktop app shows requirements and launches trusted onboarding flows, but never holds Stripe secrets.",
        ],
        implementation_offer: [
            "Dark cyberpunk desktop console for account state, earnings, payout readiness, installed surfaces, diagnostics, ledger, archive, Trust Engine, and founder note.",
            "One installer surface for VS Code, Claude Code CLI, Codex CLI, Hermes Agent/TUI, and Claude/Codex/Hermes skills.",
            "Hermes plugin and skill pack so Hermes can inspect, explain, repair, and open Kickbacks safely from the TUI.",
            "Ledger freshness monitor based on adapter sends, auth failures, sign-ins, portfolio refreshes, and visible account watermarks.",
            "Two-way Trust Engine with eligibility states, non-earning probe mode, payout holds, cap reasons, refund exposure, fraud-cluster signals, finality gates, and advertiser assurance reports.",
            "Stripe Connect-ready API shape using Accounts v2/controller-property language without local direct Stripe secret handling.",
        ],
        technical_architecture: [
            "Every earning surface runs an official adapter; no official adapter signature means no earning candidate.",
            "Adapter events carry surface ID, adapter ID/version, user/session ID, campaign/creative ID, render timestamp, wait-state proof, threshold timestamp, cap context, and backend nonce or signed receipt.",
            "The backend Trust Engine ingests candidates into an append-only event classification ledger.",
            "Only the backend can move events into billable or payable states; local logs and desktop state prove visibility, not money.",
            "Advertiser assurance reads from separate ledgers: gross adapter events, attestation, fraud clusters, refunds, payout holds, and final billable reach.",
            "Stripe Connect is the payout rail downstream of trust gates, refund windows, KYC/1099 status, and payout finality.",
        ],
        ml_plan: [
            "ML is a fraud-detection signal layer inside the rules-plus-ledger system, not a magic payout score or hard settlement gate.",
            "Known accounts/events already labeled as bots are training data, not just anecdotes; use them to bootstrap supervised detection and measure precision/recall.",
            "Deterministic policy still owns explainable state transitions: reject non-official adapters, mark probe mode non-earning, cap over-limit events, reject duplicate nonces, and hold missing KYC.",
            "Online models emit risk data points and reason-code candidates at ingestion; they do not block payouts by themselves.",
            "Graph and cluster models connect accounts, devices, IPs, ASNs, adapters, surfaces, and campaigns to find farms that look normal in isolation.",
            "Anomaly models learn normal developer behavior per surface: wait-state duration, render-to-threshold timing, cadence, click/view ratio, advertiser mix, and parallel-agent usage.",
        ],
        payout_review_note: "This aligns with the live payout promise already on Kickbacks: every payout is manually reviewed for fraud, and click-farm or bot earnings are not paid. The trust system turns that product promise into explicit states, ledgers, model signals, and review evidence.",
        trust_pitch: "The product boundary is bot-proof earning: official adapter attestations, visible wait-state proof, non-earning probe mode, caps, payout holds, refund buffers, and final billable-reach reports advertisers can audit.",
        outreach_reply: "Hey Andrew - I have been using Kickbacks since yesterday and I would love to help. I got VS Code running, verified Hermes TUI, and built a desktop trust-console prototype. The piece I think can make advertisers comfortable is a rules-plus-ledger Trust Engine with ML clustering inside it: official adapter proofs, non-earning probe mode, caps, payout holds, advertiser-safe refunds, and final billable-reach reporting. I am available for opportunities like this.",
        sync_lag_note: "Ledger freshness should be visible without overclaiming: local activity can continue while the account credit display is stale. The product should show the last local adapter send, visible account watermark, auth failures, and whether a real delivery or auth error exists.",
        stripe_note: "For real-world payouts, this should use Stripe Connect Accounts v2 on the Kickbacks backend. The desktop app should never hold Stripe secret keys or create charges; it should show onboarding/requirements/payout readiness and send users to Stripe-hosted or Kickbacks-hosted account flows.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_includes_availability_without_sounding_like_a_bug_report() {
        let note = note();
        assert!(note
            .availability
            .contains("available for new opportunities"));
        assert!(note.trust_pitch.contains("bot-proof earning"));
        assert!(note.outreach_reply.contains("ML clustering"));
        assert!(note
            .ml_plan
            .iter()
            .any(|line| line.contains("labeled as bots")));
        assert!(note
            .ml_plan
            .iter()
            .any(|line| line.contains("do not block payouts")));
        assert!(note.payout_review_note.contains("live payout promise"));
        assert!(note.title.contains("plug-and-play"));
        assert!(note.tone.contains("Excited"));
    }
}
