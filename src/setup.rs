//! `kb setup` — first-run helper. Creates the archive database, runs one
//! capture so there is something to look at immediately, and prints next steps.

use anyhow::Result;
use crossterm::style::Stylize;

use crate::archive::Archive;
use crate::capture::capture_pass;
use crate::{paths, util};

pub fn run() -> Result<()> {
    println!("{}", "kickbacks-kit · setup".bold());
    println!();

    let db = paths::db_path()?;
    let mut archive = Archive::open(&db)?;
    let report = capture_pass(&mut archive)?;
    let stats = archive.stats(util::now_ms())?;

    println!(
        "  {} archive ready  {}",
        "✓".green(),
        db.display().to_string().dim()
    );
    if report.new_sighting {
        if let Some(advertiser) = report.advertiser {
            println!(
                "  {} captured current ad  {}",
                "✓".green(),
                advertiser.dim()
            );
        }
    }
    println!(
        "  {} {} ads / {} sightings on record",
        "•".cyan(),
        stats.distinct_ads,
        stats.total_sightings
    );

    println!();
    println!("next:");
    println!("  {}    live dashboard", "kb top".bold());
    println!(
        "  {}   background capture (run in a spare terminal)",
        "kb watch".bold()
    );
    println!("  {}  verify everything is wired up", "kb doctor".bold());
    Ok(())
}
