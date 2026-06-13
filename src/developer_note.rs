use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DeveloperNote {
    pub title: &'static str,
    pub audience: &'static str,
    pub tone: &'static str,
    pub summary: &'static str,
    pub availability: &'static str,
    pub principles: [&'static str; 9],
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
        title: "Phase 0 desktop trust console for Kickback.ai",
        audience: "Kickback.ai founder / maintainer",
        tone: "Direct, founder-respecting, product-minded, and contribution-ready",
        summary: "Phase 0 should make the product feel trustworthy before it tries to feel big: install the surfaces cleanly, show what this machine actually observed, treat developer-eyeball moments as inventory only through official opt-in earning adapters, and keep fraud, refund, and payout decisions in backend ledgers.",
        availability: "I am Axl Ibiza, with a Finance MBA from Johnson & Wales University, and I am available for product-minded engineering work like this: agent integrations, CLI systems, trust architecture, analytics, compliance boundaries, security hardening, and developer experience.",
        principles: [
            "Automatic onboarding with explicit consent: install VS Code, Claude Code CLI, Codex CLI, Hermes Agent/TUI, and skills from one reversible flow.",
            "Official opt-in adapters are allowed earning paths across CLI/TUI, desktop, Telegram, Discord, and agent workflow surfaces only when they produce visibility proof, backend attestation, reconciliation, caps, refund windows, user controls, and settlement gates.",
            "Every agent interaction with developer attention is an advertising opportunity only if it is an official opt-in adapter; plain status, waiting, review, support, diagnostics, generated notes, and chat output remain non-earning.",
            "Dashboard, skills, doctor, install, repair, tests, and probes must never create hidden, fabricated, unauthenticated, non-consensual, or locally self-settled billing events.",
            "Show local observations and ledger freshness plainly; never turn a local sighting, probe, repair, or test signal into a balance, payout, or billable impression.",
            "Payment transport, backend acceptance, fraud review, refunds, and settlement stay backend-owned.",
            "The Trust Engine separates observed, candidate, eligible, capped, held, rejected, refunded, fraudulent, and final billable-reach states.",
            "Advertiser proof is first-class: signed adapter evidence, invalid-traffic reason codes, refund ledger, and payout hold/release ledger.",
            "Stripe Connect stays server-side: the desktop app shows requirements and launches trusted onboarding flows, but never holds Stripe secrets.",
        ],
        implementation_offer: [
            "Dark-only desktop console for local account state, installed surfaces, diagnostics, ledger freshness, archive, Trust Engine, Stripe readiness boundaries, and founder note.",
            "One installer surface for VS Code, Claude Code CLI, Codex CLI, Hermes Agent/TUI, and Claude/Codex/Hermes skills.",
            "Hermes plugin and skill pack so Hermes can inspect, explain, repair, and open Kickback.ai safely from the TUI.",
            "Ledger freshness monitor based on adapter sends, auth failures, sign-ins, portfolio refreshes, and visible account watermarks.",
            "Two-way Trust Engine with eligibility states, non-earning probe mode, payout holds, cap reasons, refund exposure, fraud-cluster signals, finality gates, and advertiser assurance reports.",
            "Stripe Connect-ready status surface using Accounts v2/controller-property language without local direct Stripe secret handling.",
        ],
        technical_architecture: [
            "Every earning surface, including CLI/TUI, desktop, Telegram, Discord, and agent workflow surfaces, runs as a registered official opt-in adapter; no official adapter signature means no earning candidate.",
            "Adapter events carry surface ID, adapter ID/version, user/session ID, campaign/creative ID, render timestamp, wait-state proof, threshold timestamp, cap context, and backend nonce or signed receipt.",
            "The backend Trust Engine ingests candidates into an append-only event classification ledger.",
            "Only backend ledgers can move events into backend_accepted, accepted_billable_after_refund_window, paid, refunded, rejected, or fraudulent states; local logs and desktop state prove visibility, not money.",
            "Advertiser assurance reads from separate ledgers: gross adapter events, attestation, fraud clusters, refunds, payout holds, and final billable reach.",
            "Stripe Connect is the payout rail downstream of trust gates, refund windows, KYC/1099 status, and payout finality.",
        ],
        ml_plan: [
            "ML is a fraud-risk signal layer inside the rules-plus-ledger system, not a payout score or hard settlement gate.",
            "Known bot/farm accounts and events are training data, not anecdotes; use them to bootstrap supervised detection and measure precision/recall.",
            "Deterministic policy still owns explainable state transitions: reject non-official adapters, mark probe mode non-earning, cap over-limit events, reject duplicate nonces, and hold missing KYC.",
            "Online models emit risk data points and reason-code candidates at ingestion; they do not settle, block, or release payouts by themselves.",
            "Graph and cluster models connect accounts, devices, IPs, ASNs, adapters, surfaces, and campaigns to find farms that look normal in isolation.",
            "Anomaly models learn normal developer behavior per surface: wait-state duration, render-to-threshold timing, cadence, click/view ratio, advertiser mix, and parallel-agent usage.",
        ],
        payout_review_note: "Payout review should be framed as a backend control, not a local app claim: click-farm or bot earnings stay held or rejected until review clears them. The trust system makes that promise inspectable through states, ledgers, reason codes, and review evidence.",
        trust_pitch: "Bot-resistant opt-in earning across workflow surfaces needs official adapter attestations, visible wait-state proof, nonce replay defense, saturation-attack filtering, non-earning probe mode, caps, payout holds, refund buffers, and final billable-reach reports advertisers can audit.",
        outreach_reply: "Hey Kickback.ai team - I am Axl Ibiza, a Finance MBA from Johnson & Wales University, and I have been using the product closely. The practical win is simple: a dark desktop console, official opt-in earning-adapter contracts across CLI/TUI, desktop, Telegram, Discord, and agent workflow surfaces, loopback-token and saturation-attack hard stops, backend-owned settlement, and a rules-plus-ledger Trust Engine with ML clustering inside it. That gives developers clarity without inventing balances, and gives advertisers a final billable-reach report they can audit.",
        sync_lag_note: "Ledger freshness should be visible without overclaiming: local activity can continue while the account credit display is stale. The product should show the last adapter send, visible account watermark, auth failures, and whether a real delivery or auth error exists.",
        stripe_note: "For real-world payouts, this should use Stripe Connect Accounts v2 on the Kickback.ai backend. The desktop app should not hold Stripe secret keys or directly create charges; country support, capabilities, account-link refresh/return handling, verification, tax/reporting, and official earning events flow through adapter and backend ledgers before payout readiness is shown.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_includes_founder_ready_boundaries_without_overclaiming() {
        let note = note();
        assert!(note
            .availability
            .contains("product-minded engineering work"));
        assert!(note.availability.contains("Axl Ibiza"));
        assert!(note.availability.contains("Johnson & Wales University"));
        assert!(note.trust_pitch.contains("workflow surfaces"));
        assert!(note.trust_pitch.contains("saturation-attack filtering"));
        assert!(note.outreach_reply.contains("backend-owned settlement"));
        assert!(note.summary.contains("official opt-in earning adapters"));
        assert!(note
            .principles
            .iter()
            .any(|line| line.contains("CLI/TUI, desktop, Telegram, Discord")));
        assert!(note.principles.iter().any(|line| line.contains("hidden")));
        assert!(note
            .ml_plan
            .iter()
            .any(|line| line.contains("Known bot/farm accounts")));
        assert!(note
            .ml_plan
            .iter()
            .any(|line| line.contains("do not settle")));
        assert!(note.payout_review_note.contains("backend control"));
        assert!(note
            .principles
            .iter()
            .any(|line| line.contains("never turn a local sighting")));
        assert!(note.title.contains("Phase 0"));
        assert!(note.tone.contains("Direct"));
    }
}
