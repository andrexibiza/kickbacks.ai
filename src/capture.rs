//! The single capture pass shared by `kb watch` and `kb top`.
//!
//! One pass = read the current ad and any new lifecycle events from the
//! extension's local files, then fold them into the archive. It is idempotent:
//! running it on a tight loop never double counts, because de-duplication lives
//! in the archive (rotation timestamp for ads, a byte-offset watermark for
//! events), so each pass parses only what was appended since the last one.

use anyhow::Result;
use chrono::Utc;

use crate::archive::{Archive, CaptureReport};
use crate::sources;

/// `meta` key holding the byte offset of the last fully ingested log line.
const OFFSET_KEY: &str = "debug_log_offset";

/// Perform one capture pass against the open archive.
pub fn capture_pass(archive: &mut Archive) -> Result<CaptureReport> {
    let now_ms = Utc::now().timestamp_millis();
    let mut report = CaptureReport::default();
    archive.record_observation(now_ms)?;

    if let Some(ad) = sources::read_cli_ad()? {
        report.advertiser = Some(ad.advertiser());
        report.new_sighting = archive.capture_ad(&ad, now_ms)?;
    }

    let offset = archive
        .meta_get(OFFSET_KEY)?
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let chunk = sources::read_new_events(offset)?;
    if !chunk.events.is_empty() {
        report.new_events = archive.record_events(&chunk.events)?;
    }
    if chunk.next_offset != offset {
        archive.meta_set(OFFSET_KEY, &chunk.next_offset.to_string())?;
    }

    Ok(report)
}
