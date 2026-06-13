//! `kb watch` — a headless capture daemon. Run it in a spare terminal (or at
//! login) and it quietly grows your ad archive while you code. Read-only.

use anyhow::Result;
use chrono::Local;
use std::time::Duration;

use crate::archive::Archive;
use crate::capture::capture_pass;
use crate::paths;

/// Run the capture loop. With `once`, perform a single pass and return.
pub fn run(interval_secs: u64, once: bool) -> Result<()> {
    let mut archive = Archive::open(&paths::db_path()?)?;
    let interval = interval_secs.max(1);

    if !once {
        println!(
            "kb watch · observing {} every {interval}s · Ctrl-C to stop",
            paths::vibe_dir()?.display()
        );
    }

    loop {
        let report = capture_pass(&mut archive)?;
        if report.new_sighting {
            let who = report.advertiser.as_deref().unwrap_or("unknown");
            println!("{}  +ad  {who}", Local::now().format("%H:%M:%S"));
        }
        if once {
            break;
        }
        std::thread::sleep(Duration::from_secs(interval));
    }

    Ok(())
}
