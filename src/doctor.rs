//! `kb doctor` — verify the local data sources and the archive. Prints a small
//! checklist so a first-time user can see exactly what is and isn't wired up.

use anyhow::Result;
use crossterm::style::Stylize;

use crate::archive::Archive;
use crate::{paths, sources, sync_health, trust_engine, util};

/// How fresh `cli-ad.json` must be to count as a live ad (matches the
/// extension's own 10-minute freshness window).
const FRESH_MS: i64 = 600_000;

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
        if signed {
            "yes"
        } else {
            "no — sign in via VS Code so earnings accrue"
        },
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

    let installed = extension_installed();
    check(
        "kickbacks.ai extension",
        installed,
        if installed {
            "found in ~/.vscode/extensions"
        } else {
            "not found — install from the VS Code Marketplace"
        },
    );

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

/// Best-effort detection of the installed VS Code extension.
fn extension_installed() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let exts = home.join(".vscode").join("extensions");
    let Ok(entries) = std::fs::read_dir(exts) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("kickbacksai.kickbacks-ai")
    })
}
