//! `kb statusline` — one compact line for a CLI status line (Claude Code's
//! statusLine setting). It keeps the extension's ad front and center exactly
//! like the stock kickbacks script (prefix, hyperlink, control-char stripping)
//! and appends kb's own stats after it. The ad is never suppressed or
//! shortened below readability: showing it is what earns.
//!
//! Each invocation also runs one capture pass, so a wired-up status line
//! quietly grows the archive while you code. If the archive is unavailable
//! the line still prints; this must never break the host CLI.

use std::io::{IsTerminal, Read};

use anyhow::Result;

use crate::archive::{Archive, Stats};
use crate::capture::capture_pass;
use crate::model::CliAd;
use crate::sources::{self, AdStatus};
use crate::{paths, util};

/// `cli-ad.json` freshness window, mirroring the extension.
const FRESH_MS: i64 = 600_000;

/// Visible separator between the ad and the kb stats.
const SEP: &str = "  ·  ";

/// The ad keeps at least this many columns even on narrow terminals.
const MIN_AD_COLS: usize = 16;

pub fn run(width: Option<u16>, plain: bool) -> Result<()> {
    // Claude Code pipes a JSON payload to statusline commands; consume it.
    if !std::io::stdin().is_terminal() {
        let mut sink = String::new();
        std::io::stdin().read_to_string(&mut sink).ok();
    }
    let width = width
        .map(usize::from)
        .or_else(|| {
            std::env::var("COLUMNS")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
        })
        .unwrap_or(120);

    let now = util::now_ms();
    let ad = sources::read_cli_ad().ok().flatten();
    let state = sources::read_live_state().unwrap_or_default();
    let fresh = ad.as_ref().map(|a| now - a.ts <= FRESH_MS).unwrap_or(false);
    let status = sources::ad_status(&state, fresh);

    // Best-effort capture and stats. Any failure leaves stats off the line
    // rather than failing the host's status bar.
    let stats = paths::db_path()
        .ok()
        .and_then(|p| Archive::open(&p).ok())
        .and_then(|mut a| {
            capture_pass(&mut a).ok();
            a.stats(now).ok()
        });

    let line = format_line(
        ad.as_ref().filter(|_| fresh),
        stats.as_ref(),
        status,
        width,
        !plain,
    );
    println!("{line}");
    Ok(())
}

/// Build the line. Pure so it is unit tested. `color` adds the status dot
/// color and the OSC 8 hyperlink on the ad (escapes take no columns).
fn format_line(
    ad: Option<&CliAd>,
    stats: Option<&Stats>,
    status: AdStatus,
    width: usize,
    color: bool,
) -> String {
    let (dot, label) = match status {
        AdStatus::Live => ("●", "live"),
        AdStatus::Idle => ("○", "idle"),
        AdStatus::Paused => ("●", "paused"),
        AdStatus::InjectionOff => ("○", "ads off"),
        AdStatus::SignedOut => ("○", "signed out"),
    };
    let kb_plain = match stats {
        Some(s) => format!(
            "kb {} today · {} advs · {dot} {label}",
            s.sightings_today, s.advertisers
        ),
        None => format!("kb {dot} {label}"),
    };
    let kb_out = if color {
        let colored = match status {
            AdStatus::Live => format!("\x1b[32m{dot}\x1b[0m"),
            AdStatus::Paused => format!("\x1b[31m{dot}\x1b[0m"),
            _ => format!("\x1b[33m{dot}\x1b[0m"),
        };
        kb_plain.replacen(dot, &colored, 1)
    } else {
        kb_plain.clone()
    };

    let Some(ad) = ad else {
        return kb_out;
    };

    let kb_cols = kb_plain.chars().count();
    let sep_cols = SEP.chars().count();
    let budget = width.saturating_sub(kb_cols + sep_cols).max(MIN_AD_COLS);
    let text = util::truncate(&format!("ad· {}", strip_controls(&ad.ad_text)), budget);
    let ad_out = match ad.click_url.as_deref().filter(|_| color) {
        // OSC 8 hyperlink, exactly like the stock kickbacks status line.
        Some(url) => format!(
            "\x1b]8;;{}\x1b\\{}\x1b]8;;\x1b\\",
            strip_controls(url),
            text
        ),
        None => text,
    };
    format!("{ad_out}{SEP}{kb_out}")
}

/// Remove C0, DEL, and C1 control characters so ad-supplied text can never
/// emit its own terminal escapes. Mirrors the extension's own sanitizer.
fn strip_controls(s: &str) -> String {
    s.chars()
        .filter(|&c| !c.is_control() && !('\u{80}'..='\u{9f}').contains(&c))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ad(text: &str) -> CliAd {
        CliAd {
            ad_text: text.to_string(),
            click_url: Some("https://example.com/".to_string()),
            icon_url: None,
            icon_ref: None,
            ts: 0,
        }
    }

    fn stats() -> Stats {
        Stats {
            sightings_today: 12,
            advertisers: 17,
            ..Stats::default()
        }
    }

    #[test]
    fn ad_and_stats_share_the_line() {
        let a = ad("Ramp - business cards that close themselves");
        let line = format_line(Some(&a), Some(&stats()), AdStatus::Live, 120, false);
        assert_eq!(
            line,
            "ad· Ramp - business cards that close themselves  ·  kb 12 today · 17 advs · ● live"
        );
    }

    #[test]
    fn without_ad_only_stats_print() {
        let line = format_line(None, Some(&stats()), AdStatus::Idle, 120, false);
        assert_eq!(line, "kb 12 today · 17 advs · ○ idle");
    }

    #[test]
    fn long_ad_is_truncated_to_width_but_never_dropped() {
        let a = ad(&"x".repeat(300));
        let line = format_line(Some(&a), Some(&stats()), AdStatus::Live, 80, false);
        assert!(line.chars().count() <= 80);
        assert!(line.starts_with("ad· "));
        assert!(line.contains("kb 12 today"));
    }

    #[test]
    fn colored_ad_carries_an_osc8_hyperlink() {
        let a = ad("Solo - run your agents");
        let line = format_line(Some(&a), Some(&stats()), AdStatus::Live, 120, true);
        assert!(line.contains("\x1b]8;;https://example.com/"));
        assert!(line.contains("\x1b[32m●\x1b[0m"));
    }

    #[test]
    fn control_chars_in_ad_text_are_stripped() {
        let a = ad("Evil\x1b]0;pwned\x07 - ad");
        let line = format_line(Some(&a), None, AdStatus::Live, 120, false);
        assert!(!line.contains('\x1b'));
        assert!(!line.contains('\x07'));
        assert!(line.contains("Evil]0;pwned - ad"));
    }

    #[test]
    fn paused_status_is_visible_without_stats() {
        let line = format_line(None, None, AdStatus::Paused, 120, false);
        assert_eq!(line, "kb ● paused");
    }
}
