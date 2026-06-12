//! Readers for the kickbacks.ai extension's local artifacts.
//!
//! These readers are intentionally read-only. They never write to files the
//! extension owns and never emit a network request to a billing endpoint. They
//! observe what the extension already records; they never manufacture an
//! impression.

use anyhow::{Context, Result};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::model::CliAd;
use crate::paths;

/// Read the current ad from `cli-ad.json`. Returns `Ok(None)` when the file is
/// absent or empty (extension not running, or signed out), which is a normal
/// state, not an error.
pub fn read_cli_ad() -> Result<Option<CliAd>> {
    let path = paths::cli_ad_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let ad: CliAd =
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(ad))
}

/// A parsed line from the extension lifecycle log (`debug.log`).
///
/// Lines look like:
/// `2026-06-11T19:42:13.745Z [ext] info - session.state {"signedIn":true,...}`
#[derive(Debug, Clone, PartialEq)]
pub struct LogEvent {
    pub ts_iso: String,
    pub ts_ms: i64,
    pub name: String,
    pub signed_in: Option<bool>,
    pub has_ad: Option<bool>,
    pub injection_on: Option<bool>,
    pub killed: Option<bool>,
    pub cc_version: Option<String>,
    pub raw: String,
}

/// Parse a single log line. Returns `None` for blank or malformed lines so the
/// caller can skip them without failing the whole read.
pub fn parse_log_line(line: &str) -> Option<LogEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // `<ts> [src] <level> - <name> <json?>`
    let (ts_iso, rest) = line.split_once(' ')?;
    let after_dash = rest.split_once(" - ")?.1;
    let (name, json_str) = match after_dash.split_once(" {") {
        Some((n, j)) => (n.trim().to_string(), format!("{{{j}")),
        None => (after_dash.trim().to_string(), String::new()),
    };
    if name.is_empty() {
        return None;
    }

    let ts_ms = chrono::DateTime::parse_from_rfc3339(ts_iso)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);

    let mut ev = LogEvent {
        ts_iso: ts_iso.to_string(),
        ts_ms,
        name,
        signed_in: None,
        has_ad: None,
        injection_on: None,
        killed: None,
        cc_version: None,
        raw: line.to_string(),
    };

    if !json_str.is_empty() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
            ev.signed_in = v.get("signedIn").and_then(|x| x.as_bool());
            ev.has_ad = v.get("hasAd").and_then(|x| x.as_bool());
            ev.injection_on = v.get("injectionOn").and_then(|x| x.as_bool());
            ev.killed = v.get("killed").and_then(|x| x.as_bool());
            ev.cc_version = v
                .get("ccVersion")
                .and_then(|x| x.as_str())
                .map(str::to_string);
        }
    }

    Some(ev)
}

/// Lifecycle events newly appended since a byte `offset`, plus the offset to
/// resume from next time.
#[derive(Debug, Default)]
pub struct LogChunk {
    pub events: Vec<LogEvent>,
    pub next_offset: u64,
}

/// Read lifecycle events appended to `debug.log` after byte `offset` (a value
/// previously returned in [`LogChunk::next_offset`]; pass 0 to read all).
/// Reads stop at the last complete line, so a partially written tail line is
/// picked up on the next pass instead of being lost. If the file shrank below
/// `offset` (rotation or truncation), reading restarts from the top; the
/// archive's primary key de-duplicates any re-ingested rows.
pub fn read_new_events(offset: u64) -> Result<LogChunk> {
    read_new_events_at(&paths::debug_log_path()?, offset)
}

fn read_new_events_at(path: &Path, offset: u64) -> Result<LogChunk> {
    if !path.exists() {
        return Ok(LogChunk::default());
    }
    let mut f = fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let len = f.metadata()?.len();
    let start = if offset <= len { offset } else { 0 };
    f.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    let complete = bytes
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let text = String::from_utf8_lossy(&bytes[..complete]);
    let events = text.lines().filter_map(parse_log_line).collect();
    Ok(LogChunk {
        events,
        next_offset: start + complete as u64,
    })
}

/// The most recent lifecycle state, used by the dashboard header.
#[derive(Debug, Clone, Default)]
pub struct LiveState {
    pub signed_in: Option<bool>,
    pub injection_on: Option<bool>,
    pub killed: Option<bool>,
    pub has_ad: Option<bool>,
    pub cc_version: Option<String>,
    pub last_ts_iso: Option<String>,
}

/// Why ads are or are not showing, derived purely from local signals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdStatus {
    /// Not signed in, so nothing accrues.
    SignedOut,
    /// kickbacks.ai killswitch is active (server-side pause).
    Paused,
    /// Ad injection is switched off locally.
    InjectionOff,
    /// An ad is being served right now.
    Live,
    /// Signed in and enabled, but no active session is rendering an ad.
    Idle,
}

impl AdStatus {
    /// Short human label.
    pub fn label(self) -> &'static str {
        match self {
            AdStatus::SignedOut => "SIGNED OUT",
            AdStatus::Paused => "PAUSED (kickbacks killswitch active)",
            AdStatus::InjectionOff => "OFF (ad injection disabled)",
            AdStatus::Live => "LIVE (ad showing now)",
            AdStatus::Idle => "IDLE (no active Claude Code session)",
        }
    }

    /// True when ads are actually flowing.
    pub fn is_live(self) -> bool {
        matches!(self, AdStatus::Live)
    }
}

/// Decide the ad status from the latest lifecycle state and whether the current
/// ad file is fresh. Pure, so it is unit tested. `killed` takes priority over
/// everything except being signed out, because that is the surprising case.
pub fn ad_status(state: &LiveState, ad_fresh: bool) -> AdStatus {
    if !state.signed_in.unwrap_or(false) {
        return AdStatus::SignedOut;
    }
    if state.killed.unwrap_or(false) {
        return AdStatus::Paused;
    }
    if !state.injection_on.unwrap_or(false) {
        return AdStatus::InjectionOff;
    }
    if ad_fresh {
        AdStatus::Live
    } else {
        AdStatus::Idle
    }
}

/// Best-effort installed extension version, read from the VS Code extensions
/// directory name (`kickbacksai.kickbacks-ai-<version>`). Returns the highest
/// version found, or `None` if the extension is not installed there.
pub fn installed_extension_version() -> Option<String> {
    let home = dirs::home_dir()?;
    let dir = home.join(".vscode").join("extensions");
    let entries = std::fs::read_dir(dir).ok()?;
    let mut versions: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.strip_prefix("kickbacksai.kickbacks-ai-")
                .map(str::to_string)
        })
        .collect();
    versions.sort();
    versions.pop()
}

/// How far back to look in `debug.log` for the latest `session.state`. The
/// state lines repeat every few minutes, so a 64 KiB tail always contains one
/// on a live install; the dashboard polls this once a second and must not
/// re-parse a log that grows without bound.
const LIVE_TAIL_BYTES: u64 = 64 * 1024;

/// Fold the log into the latest known `session.state`. Reads only the tail of
/// the file; falls back to a full read in the rare case the tail window holds
/// no state line.
pub fn read_live_state() -> Result<LiveState> {
    live_state_at(&paths::debug_log_path()?, LIVE_TAIL_BYTES)
}

fn live_state_at(path: &Path, tail_bytes: u64) -> Result<LiveState> {
    if !path.exists() {
        return Ok(LiveState::default());
    }
    let mut f = fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(tail_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    // When we seeked into the middle of the file the first line is partial.
    let lines = text.lines().skip(usize::from(start > 0));
    let st = fold_session_state(lines);
    if st.last_ts_iso.is_none() && start > 0 {
        let raw =
            fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        return Ok(fold_session_state(raw.lines()));
    }
    Ok(st)
}

fn fold_session_state<'a>(lines: impl Iterator<Item = &'a str>) -> LiveState {
    let mut st = LiveState::default();
    for ev in lines.filter_map(parse_log_line) {
        if ev.name == "session.state" {
            if ev.signed_in.is_some() {
                st.signed_in = ev.signed_in;
            }
            if ev.injection_on.is_some() {
                st.injection_on = ev.injection_on;
            }
            if ev.killed.is_some() {
                st.killed = ev.killed;
            }
            if ev.has_ad.is_some() {
                st.has_ad = ev.has_ad;
            }
            if ev.cc_version.is_some() {
                st.cc_version = ev.cc_version;
            }
            st.last_ts_iso = Some(ev.ts_iso);
        }
    }
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_state_line() {
        let line = r#"2026-06-11T19:42:23.748Z [ext] info - session.state {"signedIn":true,"authHealthy":"ok","injectionOn":true,"killed":false,"hasAd":true,"ccVersion":"2.1.173"}"#;
        let ev = parse_log_line(line).expect("should parse");
        assert_eq!(ev.name, "session.state");
        assert_eq!(ev.signed_in, Some(true));
        assert_eq!(ev.injection_on, Some(true));
        assert_eq!(ev.killed, Some(false));
        assert_eq!(ev.has_ad, Some(true));
        assert_eq!(ev.cc_version.as_deref(), Some("2.1.173"));
        assert!(ev.ts_ms > 0);
    }

    #[test]
    fn parses_event_without_json() {
        let line = "2026-06-11T19:42:13.838Z [ext] info - boot.cycle.start {}";
        let ev = parse_log_line(line).expect("should parse");
        assert_eq!(ev.name, "boot.cycle.start");
        assert_eq!(ev.signed_in, None);
    }

    #[test]
    fn skips_blank_and_malformed() {
        assert!(parse_log_line("").is_none());
        assert!(parse_log_line("   ").is_none());
        assert!(parse_log_line("not a real line").is_none());
    }

    #[test]
    fn since_filter_is_strict() {
        let line = "2026-06-11T19:42:13.838Z [ext] info - x {}";
        let ev = parse_log_line(line).unwrap();
        assert!(ev.ts_iso.as_str() > "2026-06-11T19:00:00.000Z");
        assert!(ev.ts_iso.as_str() <= "2026-06-11T20:00:00.000Z");
    }

    /// A temp log file that cleans up after itself.
    struct TempLog(std::path::PathBuf);

    impl TempLog {
        fn new(name: &str, content: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!("kb-sources-test-{}-{name}.log", std::process::id()));
            fs::write(&p, content).unwrap();
            Self(p)
        }

        fn append(&self, content: &str) {
            use std::io::Write;
            let mut f = fs::OpenOptions::new().append(true).open(&self.0).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }
    }

    impl Drop for TempLog {
        fn drop(&mut self) {
            fs::remove_file(&self.0).ok();
        }
    }

    const LINE_A: &str = "2026-06-11T19:42:13.838Z [ext] info - a {}\n";
    const LINE_B: &str = "2026-06-11T19:42:14.838Z [ext] info - b {}\n";
    const STATE_LINE: &str = "2026-06-11T19:42:23.748Z [ext] info - session.state {\"signedIn\":true,\"injectionOn\":true,\"killed\":false,\"hasAd\":true,\"ccVersion\":\"2.1.173\"}\n";

    #[test]
    fn offset_read_is_incremental() {
        let log = TempLog::new("incremental", LINE_A);
        let c1 = read_new_events_at(&log.0, 0).unwrap();
        assert_eq!(c1.events.len(), 1);
        assert_eq!(c1.events[0].name, "a");
        assert_eq!(c1.next_offset, LINE_A.len() as u64);

        log.append(LINE_B);
        let c2 = read_new_events_at(&log.0, c1.next_offset).unwrap();
        assert_eq!(c2.events.len(), 1);
        assert_eq!(c2.events[0].name, "b");
        assert_eq!(c2.next_offset, (LINE_A.len() + LINE_B.len()) as u64);
    }

    #[test]
    fn offset_holds_back_partial_tail_line() {
        let partial = "2026-06-11T19:42:15.838Z [ext] info - c {";
        let log = TempLog::new("partial", &format!("{LINE_A}{partial}"));
        let c1 = read_new_events_at(&log.0, 0).unwrap();
        // The unterminated line is not consumed; it stays for the next pass.
        assert_eq!(c1.events.len(), 1);
        assert_eq!(c1.next_offset, LINE_A.len() as u64);

        log.append("}\n");
        let c2 = read_new_events_at(&log.0, c1.next_offset).unwrap();
        assert_eq!(c2.events.len(), 1);
        assert_eq!(c2.events[0].name, "c");
    }

    #[test]
    fn offset_resets_when_file_shrinks() {
        let log = TempLog::new("shrink", LINE_A);
        let c = read_new_events_at(&log.0, 10_000).unwrap();
        assert_eq!(c.events.len(), 1);
        assert_eq!(c.next_offset, LINE_A.len() as u64);
    }

    #[test]
    fn live_state_reads_tail_window() {
        let noise: String = (0..50)
            .map(|i| {
                format!(
                    "2026-06-11T19:00:{:02}.000Z [ext] info - noise {{}}\n",
                    i % 60
                )
            })
            .collect();
        let log = TempLog::new("tail", &format!("{noise}{STATE_LINE}"));
        // Window much smaller than the file, but covering the state line.
        let st = live_state_at(&log.0, 256).unwrap();
        assert_eq!(st.signed_in, Some(true));
        assert_eq!(st.killed, Some(false));
        assert_eq!(st.cc_version.as_deref(), Some("2.1.173"));
    }

    #[test]
    fn live_state_falls_back_to_full_read() {
        let noise: String = (0..50)
            .map(|i| {
                format!(
                    "2026-06-11T20:00:{:02}.000Z [ext] info - noise {{}}\n",
                    i % 60
                )
            })
            .collect();
        // State line only at the very start, outside any small tail window.
        let log = TempLog::new("fallback", &format!("{STATE_LINE}{noise}"));
        let st = live_state_at(&log.0, 64).unwrap();
        assert_eq!(st.signed_in, Some(true));
        assert_eq!(st.has_ad, Some(true));
    }

    #[test]
    fn live_state_missing_file_is_default() {
        let p = std::env::temp_dir().join("kb-sources-test-does-not-exist.log");
        let st = live_state_at(&p, 64).unwrap();
        assert_eq!(st.signed_in, None);
        assert!(st.last_ts_iso.is_none());
    }

    fn state(signed: bool, injection: bool, killed: bool) -> LiveState {
        LiveState {
            signed_in: Some(signed),
            injection_on: Some(injection),
            killed: Some(killed),
            ..Default::default()
        }
    }

    #[test]
    fn ad_status_killswitch_takes_priority() {
        // Signed in, injection on, fresh ad, but killed -> Paused.
        assert_eq!(ad_status(&state(true, true, true), true), AdStatus::Paused);
    }

    #[test]
    fn ad_status_live_and_idle() {
        assert_eq!(ad_status(&state(true, true, false), true), AdStatus::Live);
        assert_eq!(ad_status(&state(true, true, false), false), AdStatus::Idle);
    }

    #[test]
    fn ad_status_signed_out_and_injection_off() {
        assert_eq!(
            ad_status(&state(false, true, false), true),
            AdStatus::SignedOut
        );
        assert_eq!(
            ad_status(&state(true, false, false), true),
            AdStatus::InjectionOff
        );
    }
}
