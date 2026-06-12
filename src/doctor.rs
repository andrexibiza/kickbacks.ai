//! `kb doctor` — verify the local data sources and the archive. Prints a small
//! checklist so a first-time user can see exactly what is and isn't wired up.

use anyhow::Result;
use crossterm::style::Stylize;

use crate::archive::Archive;
use crate::{integrations, paths, sources, sync_health, trust_engine, util};

/// How fresh `cli-ad.json` must be to count as a live ad (matches the
/// extension's own 10-minute freshness window).
const FRESH_MS: i64 = 600_000;
const SIGNED_OUT_DETAIL: &str =
    "no - sign in through an official opt-in adapter before expecting eligible earning candidates";
const PROBE_MODE_DETAIL: &str =
    "doctor/install/repair/skills/generated plugin tools inspect local state only and do not create billing, payout, or payable events";

pub fn run() -> Result<()> {
    println!("{}", "kickbacks-kit · doctor".bold());
    println!();

    let vibe = paths::vibe_dir()?;
    check(
        "extension artifact dir",
        vibe.exists(),
        &vibe.display().to_string(),
    );

    match sources::read_cli_ad()? {
        Some(ad) => {
            let age = util::now_ms() - ad.ts;
            check(
                "current ad (cli-ad.json)",
                age <= FRESH_MS,
                &format!("{} · {}", ad.advertiser(), util::human_age(age)),
            );
        }
        None => check(
            "current ad (cli-ad.json)",
            false,
            "no ad right now (extension idle or signed out)",
        ),
    }

    let dbg = paths::debug_log_path()?;
    check(
        "lifecycle log (debug.log)",
        dbg.exists(),
        &dbg.display().to_string(),
    );

    let state = sources::read_live_state()?;
    let signed = state.signed_in.unwrap_or(false);
    check(
        "signed in to kickbacks",
        signed,
        if signed { "yes" } else { SIGNED_OUT_DETAIL },
    );

    let ad_fresh = sources::read_cli_ad()?
        .map(|a| util::now_ms() - a.ts <= FRESH_MS)
        .unwrap_or(false);
    let ad_status = sources::ad_status(&state, ad_fresh);
    check("ads status", ad_status.is_live(), ad_status.label());

    let db = paths::db_path()?;
    let archive = Archive::open(&db)?;
    let stats = archive.stats(util::now_ms())?;
    check(
        "archive database",
        true,
        &format!(
            "{} ads, {} sightings · {}",
            stats.distinct_ads,
            stats.total_sightings,
            db.display()
        ),
    );

    let sync = sync_health::current(&archive)?;
    check(
        "ledger freshness monitor",
        matches!(
            sync.severity,
            sync_health::SyncSeverity::Ok
                | sync_health::SyncSeverity::Monitoring
                | sync_health::SyncSeverity::Warning
        ),
        &sync.message,
    );

    let trust = trust_engine::current(&archive)?;
    check(
        "trust engine",
        trust.user_risk_score < 75 && trust.surface_risk_score < 75,
        &format!(
            "user {} / {}, surface {} / {}",
            trust.user_risk_score,
            trust.user_risk_band,
            trust.surface_risk_score,
            trust.surface_risk_band
        ),
    );

    let system = integrations::system_status()?;
    for integration in &system.integrations {
        check(
            integration.label,
            integration.enabled,
            &format!(
                "{}; repair with `{}`",
                integration.detail, integration.repair_command
            ),
        );
    }

    for skill in &system.skills {
        check(
            skill.label,
            skill.owned,
            &format!("{}; repair with `{}`", skill.detail, skill.repair_command),
        );
    }

    check(
        "Stripe Connect boundary",
        system.stripe.backend_owned && system.stripe.payouts_ready.is_none(),
        system.stripe.note,
    );

    check("non-earning probe mode", true, PROBE_MODE_DETAIL);

    println!();
    println!(
        "{}",
        "run `kb watch` to capture continuously, or `kb top` for the live dashboard".dim()
    );
    Ok(())
}

fn check(label: &str, ok: bool, detail: &str) {
    let mark = if ok {
        "✓".green().to_string()
    } else {
        "•".yellow().to_string()
    };
    println!("  {mark} {:<26} {}", label, detail.dim());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_copy_keeps_probe_and_trust_boundaries() {
        assert!(SIGNED_OUT_DETAIL.contains("official opt-in adapter"));
        assert!(SIGNED_OUT_DETAIL.contains("eligible earning candidates"));
        assert!(PROBE_MODE_DETAIL.contains("inspect local state only"));
        assert!(PROBE_MODE_DETAIL.contains("do not create billing, payout, or payable events"));
        assert!(!SIGNED_OUT_DETAIL.contains("earnings accrue"));
        assert!(!PROBE_MODE_DETAIL.contains("can create payable"));
    }
}
