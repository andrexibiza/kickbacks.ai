//! Ledger freshness monitoring for the desktop app.
//!
//! This module is deliberately observational. It reads the extension log and an
//! optional user/account watermark from kb's own archive metadata. It never
//! posts metrics or retries billing events.

use anyhow::{Context, Result};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::archive::Archive;
use crate::{paths, util};

const TAIL_BYTES: u64 = 2 * 1024 * 1024;
const RECENT_WINDOW_MS: i64 = 15 * 60 * 1000;
const LAG_WARN_MS: i64 = 5 * 60 * 1000;
const ACCOUNT_SYNC_META_KEY: &str = "account_synced_ms";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncSeverity {
    Ok,
    Monitoring,
    Warning,
    Critical,
}

impl SyncSeverity {
    pub fn label(self) -> &'static str {
        match self {
            SyncSeverity::Ok => "OK",
            SyncSeverity::Monitoring => "MONITORING",
            SyncSeverity::Warning => "LEDGER LAG",
            SyncSeverity::Critical => "DELIVERY ISSUE",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncHealth {
    pub severity: SyncSeverity,
    pub label: &'static str,
    pub message: String,
    pub account_ledger_last_synced_ms: Option<i64>,
    pub last_metric_send_ms: Option<i64>,
    pub last_metric_event: Option<String>,
    pub last_metric_surface: Option<String>,
    pub last_metric_failure_ms: Option<i64>,
    pub last_metric_failure_reason: Option<String>,
    pub last_auth_failure_ms: Option<i64>,
    pub last_auth_failure_reason: Option<String>,
    pub last_auth_signin_ms: Option<i64>,
    pub last_portfolio_refresh_ms: Option<i64>,
    pub last_portfolio_refresh_forced: bool,
    pub recent_metric_sends: usize,
    pub local_events_after_account_sync: usize,
    pub stale_ms: Option<i64>,
    pub payment_transport_status: &'static str,
    pub evidence_boundary: &'static str,
}

#[derive(Debug, Default)]
struct LogSignals {
    last_metric_send_ms: Option<i64>,
    last_metric_event: Option<String>,
    last_metric_surface: Option<String>,
    last_metric_failure_ms: Option<i64>,
    last_metric_failure_reason: Option<String>,
    last_auth_failure_ms: Option<i64>,
    last_auth_failure_reason: Option<String>,
    last_auth_signin_ms: Option<i64>,
    last_portfolio_refresh_ms: Option<i64>,
    last_portfolio_refresh_forced: bool,
    metric_send_times: Vec<i64>,
}

pub fn mark_account_synced(archive: &mut Archive, at_ms: i64) -> Result<()> {
    archive.meta_set(ACCOUNT_SYNC_META_KEY, &at_ms.to_string())
}

pub fn clear_account_synced(archive: &mut Archive) -> Result<()> {
    archive.meta_set(ACCOUNT_SYNC_META_KEY, "")
}

pub fn account_synced_ms(archive: &Archive) -> Result<Option<i64>> {
    let Some(raw) = archive.meta_get(ACCOUNT_SYNC_META_KEY)? else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    Ok(raw.trim().parse::<i64>().ok())
}

pub fn current(archive: &Archive) -> Result<SyncHealth> {
    let text = read_log_tail(&paths::debug_log_path()?, TAIL_BYTES)?;
    let account_ms = account_synced_ms(archive)?;
    Ok(analyze_log_text(&text, util::now_ms(), account_ms))
}

pub fn parse_account_time(raw: &str) -> Result<i64> {
    let raw = raw.trim();
    if let Ok(ms) = raw.parse::<i64>() {
        return Ok(ms);
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.timestamp_millis());
    }
    let dt = NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M")
        .with_context(|| format!("expected epoch millis, RFC3339, or YYYY-MM-DD HH:mm: {raw}"))?;
    Local
        .from_local_datetime(&dt)
        .single()
        .map(|d| d.timestamp_millis())
        .context("local time is ambiguous or invalid")
}

pub fn analyze_log_text(text: &str, now_ms: i64, account_ms: Option<i64>) -> SyncHealth {
    let signals = collect_signals(text);
    let recent_since = now_ms - RECENT_WINDOW_MS;
    let recent_metric_sends = signals
        .metric_send_times
        .iter()
        .filter(|&&ts| ts >= recent_since)
        .count();
    let local_events_after_account_sync = account_ms
        .map(|wm| {
            signals
                .metric_send_times
                .iter()
                .filter(|&&ts| ts > wm)
                .count()
        })
        .unwrap_or(0);

    let auth_failure_unrecovered = match (signals.last_auth_failure_ms, signals.last_auth_signin_ms)
    {
        (Some(fail), Some(signin)) => fail > signin,
        (Some(_), None) => true,
        _ => false,
    };

    let stale_ms = account_ms.map(|wm| now_ms.saturating_sub(wm));
    let metric_failure_unrecovered = matches!((signals.last_metric_failure_ms, signals.last_metric_send_ms), (Some(fail), Some(send)) if fail > send)
        || matches!(
            (signals.last_metric_failure_ms, signals.last_metric_send_ms),
            (Some(_), None)
        );

    let (severity, message) = if metric_failure_unrecovered {
        (
            SyncSeverity::Critical,
            format!(
                "Metric delivery failed after the last successful send ({})",
                signals
                    .last_metric_failure_reason
                    .as_deref()
                    .unwrap_or("unknown")
            ),
        )
    } else if auth_failure_unrecovered {
        (
            SyncSeverity::Critical,
            format!(
                "Auth refresh failed after the last sign-in ({})",
                signals
                    .last_auth_failure_reason
                    .as_deref()
                    .unwrap_or("unknown")
            ),
        )
    } else if let Some(wm) = account_ms {
        if local_events_after_account_sync > 0
            && signals.last_metric_send_ms.unwrap_or(0) > wm
            && stale_ms.unwrap_or(0) >= LAG_WARN_MS
        {
            (
                SyncSeverity::Warning,
                format!(
                    "{local_events_after_account_sync} local adapter sends are newer than the last visible account ledger watermark. This is a ledger visibility lag, not evidence that Stripe delivery failed."
                ),
            )
        } else if local_events_after_account_sync > 0 {
            (
                SyncSeverity::Warning,
                "Local adapter sends are newer than the visible account ledger watermark; waiting for account display to catch up. This is not evidence of Stripe delivery failure."
                    .to_string(),
            )
        } else {
            (
                SyncSeverity::Ok,
                "No local metric sends are newer than the account ledger watermark".to_string(),
            )
        }
    } else if recent_metric_sends > 0 {
        (
            SyncSeverity::Monitoring,
            "Local adapter sends are active; account ledger freshness is not yet connected. Stripe/payment transport is backend-owned and not inferred here."
                .to_string(),
        )
    } else {
        (
            SyncSeverity::Ok,
            "No recent local earning events detected in the extension log".to_string(),
        )
    };

    SyncHealth {
        severity,
        label: severity.label(),
        message,
        account_ledger_last_synced_ms: account_ms,
        last_metric_send_ms: signals.last_metric_send_ms,
        last_metric_event: signals.last_metric_event,
        last_metric_surface: signals.last_metric_surface,
        last_metric_failure_ms: signals.last_metric_failure_ms,
        last_metric_failure_reason: signals.last_metric_failure_reason,
        last_auth_failure_ms: signals.last_auth_failure_ms,
        last_auth_failure_reason: signals.last_auth_failure_reason,
        last_auth_signin_ms: signals.last_auth_signin_ms,
        last_portfolio_refresh_ms: signals.last_portfolio_refresh_ms,
        last_portfolio_refresh_forced: signals.last_portfolio_refresh_forced,
        recent_metric_sends,
        local_events_after_account_sync,
        stale_ms,
        payment_transport_status: "backend-owned; not inferred from local ledger watermark",
        evidence_boundary:
            "Local monitor reads adapter logs and account ledger watermarks; Stripe settlement remains backend-owned.",
    }
}

fn read_log_tail(path: &Path, max_bytes: u64) -> Result<String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let mut f = fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    if start > 0 {
        if let Some(i) = bytes.iter().position(|&b| b == b'\n') {
            bytes.drain(..=i);
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn collect_signals(text: &str) -> LogSignals {
    let mut out = LogSignals::default();
    for line in text.lines() {
        let Some(ts) = line_ts_ms(line) else {
            continue;
        };

        if line.contains(" metric.send ") {
            out.metric_send_times.push(ts);
            out.last_metric_send_ms = Some(ts);
            if let Some(v) = json_after(line, " metric.send ") {
                out.last_metric_event = v
                    .get("event")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(out.last_metric_event);
                out.last_metric_surface = v
                    .get("surface")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(out.last_metric_surface);
            }
        } else if line.contains(" metric.send_failed ") || line.contains(" metric.send_error ") {
            out.last_metric_failure_ms = Some(ts);
            let marker = if line.contains(" metric.send_failed ") {
                " metric.send_failed "
            } else {
                " metric.send_error "
            };
            out.last_metric_failure_reason = json_after(line, marker)
                .and_then(|v| {
                    v.get("status")
                        .and_then(Value::as_i64)
                        .map(|s| format!("http-{s}"))
                        .or_else(|| v.get("reason").and_then(Value::as_str).map(str::to_string))
                        .or_else(|| v.get("error").and_then(Value::as_str).map(str::to_string))
                })
                .or_else(|| Some("send failed".to_string()));
        } else if line.contains(" - auth.refresh ") {
            if let Some(v) = json_after(line, " - auth.refresh ") {
                if v.get("ok").and_then(Value::as_bool) == Some(false) {
                    out.last_auth_failure_ms = Some(ts);
                    out.last_auth_failure_reason =
                        v.get("reason").and_then(Value::as_str).map(str::to_string);
                }
            }
        } else if line.contains(" - auth.signin ") {
            if json_after(line, " - auth.signin ")
                .and_then(|v| v.get("ok").and_then(Value::as_bool))
                == Some(true)
            {
                out.last_auth_signin_ms = Some(ts);
            }
        } else if line.contains(" - portfolio.refresh ") {
            out.last_portfolio_refresh_ms = Some(ts);
            out.last_portfolio_refresh_forced = json_after(line, " - portfolio.refresh ")
                .and_then(|v| v.get("forced").and_then(Value::as_bool))
                .unwrap_or(false);
        }
    }
    out
}

fn line_ts_ms(line: &str) -> Option<i64> {
    let (ts, _) = line.split_once(' ')?;
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn json_after(line: &str, marker: &str) -> Option<Value> {
    let (_, rest) = line.split_once(marker)?;
    let start = rest.find('{')?;
    serde_json::from_str(&rest[start..]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(ts: &str) -> i64 {
        DateTime::parse_from_rfc3339(ts).unwrap().timestamp_millis()
    }

    #[test]
    fn account_watermark_lag_is_warning_not_stripe_incident() {
        let text = r#"
2026-06-12T17:02:20.886Z [ext] info 23.x metric.send {"event":"impression_rendered","surface":"codex_overlay"}
2026-06-12T17:02:30.114Z [ext] info 23.x metric.send {"event":"view_threshold_met","surface":"codex_overlay"}
"#;
        let health = analyze_log_text(
            text,
            ms("2026-06-12T17:20:00.000Z"),
            Some(ms("2026-06-12T17:02:00.000Z")),
        );
        assert_eq!(health.severity, SyncSeverity::Warning);
        assert_eq!(health.label, "LEDGER LAG");
        assert!(health
            .message
            .contains("not evidence that Stripe delivery failed"));
        assert_eq!(health.local_events_after_account_sync, 2);
        assert!(health.payment_transport_status.contains("backend-owned"));
        assert_eq!(
            health.last_metric_event.as_deref(),
            Some("view_threshold_met")
        );
    }

    #[test]
    fn auth_failure_after_signin_is_critical() {
        let text = r#"
2026-06-12T17:47:40.018Z [ext] info - auth.signin {"ok":true}
2026-06-12T17:48:27.089Z [ext] info - auth.refresh {"ok":false,"reason":"http-401"}
"#;
        let health = analyze_log_text(text, ms("2026-06-12T17:49:00.000Z"), None);
        assert_eq!(health.severity, SyncSeverity::Critical);
        assert_eq!(health.last_auth_failure_reason.as_deref(), Some("http-401"));
    }

    #[test]
    fn metric_failure_after_success_is_critical() {
        let text = r#"
2026-06-12T17:02:20.886Z [ext] info 23.x metric.send {"event":"impression_rendered","surface":"codex_overlay"}
2026-06-12T17:03:20.886Z [ext] info - metric.send_failed {"status":500,"event":"view_tick"}
"#;
        let health = analyze_log_text(text, ms("2026-06-12T17:04:00.000Z"), None);
        assert_eq!(health.severity, SyncSeverity::Critical);
        assert_eq!(
            health.last_metric_failure_reason.as_deref(),
            Some("http-500")
        );
    }

    #[test]
    fn signin_after_auth_failure_recovers_auth_incident() {
        let text = r#"
2026-06-12T17:42:27.089Z [ext] info - auth.refresh {"ok":false,"reason":"http-401"}
2026-06-12T17:47:40.018Z [ext] info - auth.signin {"ok":true}
"#;
        let health = analyze_log_text(text, ms("2026-06-12T17:49:00.000Z"), None);
        assert_ne!(health.severity, SyncSeverity::Critical);
    }

    #[test]
    fn parses_account_time_formats() {
        assert!(parse_account_time("2026-06-12T17:02:00Z").unwrap() > 0);
        assert!(parse_account_time("2026-06-12 12:02").unwrap() > 0);
        assert_eq!(parse_account_time("12345").unwrap(), 12345);
    }
}
