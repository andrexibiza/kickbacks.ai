//! `kb status` — an honest, local read of whether kickbacks ads are flowing
//! right now, and why. No network: every signal comes from the files the
//! extension already writes. kickbacks.ai has no status page, so this is as
//! close to one as you get; the maintainer posts incidents on X (@andrewmccalip).

use anyhow::Result;
use crossterm::style::{Color, Stylize};

use crate::archive::Archive;
use crate::sources::{self, AdStatus};
use crate::{paths, sync_health, trust_engine, util};

/// `cli-ad.json` freshness window, mirroring the extension.
const FRESH_MS: i64 = 600_000;

pub fn run() -> Result<()> {
    let state = sources::read_live_state()?;
    let ad = sources::read_cli_ad()?;
    let now = util::now_ms();
    let fresh = ad.as_ref().map(|a| now - a.ts <= FRESH_MS).unwrap_or(false);
    let status = sources::ad_status(&state, fresh);

    println!("{}", "kickbacks-kit · status".bold());
    println!();

    let color = match status {
        AdStatus::Live => Color::Green,
        AdStatus::Idle | AdStatus::InjectionOff => Color::Yellow,
        AdStatus::Paused | AdStatus::SignedOut => Color::Red,
    };
    println!(
        "  ads  {} {}",
        "●".with(color),
        status.label().with(color).bold()
    );
    println!();

    row("signed in", yes_no(state.signed_in));
    row("ad injection", yes_no(state.injection_on));
    row(
        "killswitch",
        if state.killed.unwrap_or(false) {
            "ACTIVE".to_string()
        } else {
            "clear".to_string()
        },
    );
    if let Some(ts) = &state.last_ts_iso {
        row("state as of", ts.clone());
    }
    match &ad {
        Some(a) if fresh => row(
            "current ad",
            format!("{} · {}", a.advertiser(), util::human_age(now - a.ts)),
        ),
        _ => row("current ad", "none right now".to_string()),
    }
    if let Some(v) = &state.cc_version {
        row("claude code", v.clone());
    }
    if let Some(v) = sources::installed_extension_version() {
        row("extension", v);
    }

    let archive = Archive::open(&paths::db_path()?)?;
    let s = archive.stats(now)?;
    row(
        "archive",
        format!("{} ads · {} sightings", s.distinct_ads, s.total_sightings),
    );

    row(
        "earnings",
        format!("{} (kb stays read-only)", crate::render::PORTFOLIO_URL),
    );

    let sync = sync_health::current(&archive)?;
    row("sync", format!("{} - {}", sync.label, sync.message));

    let trust = trust_engine::current(&archive)?;
    row(
        "trust",
        format!(
            "user {} / {}, surface {} / {}",
            trust.user_risk_score,
            trust.user_risk_band,
            trust.surface_risk_score,
            trust.surface_risk_band
        ),
    );

    println!();
    if status == AdStatus::Paused {
        println!(
            "  {}",
            "ads are paused on kickbacks.ai's side. you did not cause this and cannot override it."
                .yellow()
        );
    }
    println!(
        "  {}",
        "no official status page exists. the maintainer posts status on X:".dim()
    );
    println!("  {}", "https://x.com/andrewmccalip".dim());
    Ok(())
}

fn row(label: &str, value: String) {
    println!("  {:<14}{}", label.dim(), value);
}

fn yes_no(b: Option<bool>) -> String {
    match b {
        Some(true) => "yes".to_string(),
        Some(false) => "no".to_string(),
        None => "unknown".to_string(),
    }
}
