//! `kb export` — dump the ad corpus as JSONL or CSV, to stdout or a file.
//! This is your data: the ads you were shown. Take it anywhere.

use anyhow::{Context, Result};
use clap::ValueEnum;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;

use crate::archive::Archive;
use crate::paths;

#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum Format {
    /// One JSON object per line. Ready for `datasets.load_dataset("json", ...)`.
    Jsonl,
    /// Comma-separated values with a header row.
    Csv,
}

/// Export every captured ad.
pub fn run(format: Format, out: Option<PathBuf>) -> Result<()> {
    let archive = Archive::open(&paths::db_path()?)?;
    let ads = archive.all_ads()?;

    let mut writer: Box<dyn Write> = match &out {
        Some(p) => Box::new(BufWriter::new(
            File::create(p).with_context(|| format!("creating {}", p.display()))?,
        )),
        None => Box::new(BufWriter::new(io::stdout().lock())),
    };

    match format {
        Format::Jsonl => {
            for ad in &ads {
                writeln!(writer, "{}", serde_json::to_string(ad)?)?;
            }
        }
        Format::Csv => {
            writeln!(
                writer,
                "id,advertiser,ad_text,click_url,first_seen_ms,last_seen_ms,times_seen"
            )?;
            for ad in &ads {
                writeln!(
                    writer,
                    "{},{},{},{},{},{},{}",
                    csv_field(&ad.id),
                    csv_field(&ad.advertiser),
                    csv_field(&ad.ad_text),
                    csv_field(ad.click_url.as_deref().unwrap_or("")),
                    ad.first_seen_ms,
                    ad.last_seen_ms,
                    ad.times_seen,
                )?;
            }
        }
    }

    writer.flush()?;
    if let Some(p) = out {
        eprintln!("exported {} ads -> {}", ads.len(), p.display());
    }
    Ok(())
}

/// Minimal RFC-4180 CSV quoting.
fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}
