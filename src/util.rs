//! Small formatting helpers shared across commands.

use chrono::{Local, TimeZone, Utc};

/// Current wall-clock time in epoch milliseconds.
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Compact human age from a millisecond delta (`now - then`).
pub fn human_age(ms_ago: i64) -> String {
    if ms_ago < 0 {
        return "just now".to_string();
    }
    let secs = ms_ago / 1000;
    if secs < 60 {
        return format!("{secs}s ago");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m ago");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours / 24;
    format!("{days}d ago")
}

/// Format an epoch-millis instant in the local timezone, e.g. `2026-06-11 22:34`.
pub fn fmt_datetime(ms: i64) -> String {
    match Local.timestamp_millis_opt(ms).single() {
        Some(dt) => dt.format("%Y-%m-%d %H:%M").to_string(),
        None => "—".to_string(),
    }
}

/// Truncate a string to `max` display columns, appending `…` when cut.
/// Counts `char`s (good enough for the Latin + punctuation creatives here).
pub fn truncate(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut out: String = s.chars().take(keep).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn age_buckets() {
        assert_eq!(human_age(5_000), "5s ago");
        assert_eq!(human_age(90_000), "1m ago");
        assert_eq!(human_age(3 * 3_600_000), "3h ago");
        assert_eq!(human_age(2 * 86_400_000), "2d ago");
        assert_eq!(human_age(-1), "just now");
    }

    #[test]
    fn truncate_adds_ellipsis() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5), "hell…");
        assert_eq!(truncate("abc", 0), "");
    }
}
