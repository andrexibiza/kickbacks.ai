//! Data shapes. The `CliAd` mirrors exactly what the kickbacks.ai extension
//! writes to `~/.vibe-ads/cli-ad.json`. We only ever READ it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Raw shape of `~/.vibe-ads/cli-ad.json` (the current ad served to the CLI
/// status line). Field names match the extension's JSON.
#[derive(Debug, Clone, Deserialize)]
pub struct CliAd {
    #[serde(rename = "adText")]
    pub ad_text: String,
    #[serde(rename = "clickUrl", default)]
    pub click_url: Option<String>,
    #[serde(rename = "iconUrl", default)]
    pub icon_url: Option<String>,
    /// Kept for schema fidelity with the extension's JSON; not used yet.
    #[serde(rename = "iconRef", default)]
    #[allow(dead_code)]
    pub icon_ref: Option<String>,
    /// Rotation timestamp in epoch milliseconds (set by the extension).
    pub ts: i64,
}

impl CliAd {
    /// Stable id for an ad creative: first 16 hex chars of
    /// sha256(click_url \n ad_text). Two rotations of the same creative
    /// collapse to one row in the archive.
    pub fn id(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.click_url.as_deref().unwrap_or("").as_bytes());
        h.update(b"\n");
        h.update(self.ad_text.as_bytes());
        let digest = h.finalize();
        let mut s = String::with_capacity(16);
        for b in digest.iter().take(8) {
            s.push_str(&format!("{:02x}", b));
        }
        s
    }

    /// Split the creative into (advertiser head, tagline tail). Creatives
    /// follow the pattern "Advertiser <sep> tagline", where the separator is a
    /// middot, an em or en dash, or a spaced hyphen. The head only counts when
    /// it looks like a name (a few words at most). Single source of truth for
    /// both `advertiser()` and `tagline()` so they can never disagree.
    fn split_creative(&self) -> Option<(&str, &str)> {
        const SEPARATORS: [&str; 4] = [" · ", " — ", " – ", " - "];
        for sep in SEPARATORS {
            if let Some((head, tail)) = self.ad_text.split_once(sep) {
                let head = head.trim();
                if !head.is_empty() && head.split_whitespace().count() <= 4 {
                    return Some((head, tail.trim()));
                }
            }
        }
        None
    }

    /// Best-effort advertiser name: the creative's head when it looks like a
    /// name, otherwise the click_url host.
    pub fn advertiser(&self) -> String {
        if let Some((head, _)) = self.split_creative() {
            return head.to_string();
        }
        if let Some(url) = &self.click_url {
            if let Some(host) = host_of(url) {
                return host;
            }
        }
        "unknown".to_string()
    }

    /// The tagline after the advertiser separator, or the full creative text
    /// when no separator matches.
    pub fn tagline(&self) -> String {
        match self.split_creative() {
            Some((_, tail)) if !tail.is_empty() => tail.to_string(),
            _ => self.ad_text.clone(),
        }
    }
}

/// One row of the `ads` table: a distinct creative we have observed.
#[derive(Debug, Clone, Serialize)]
pub struct AdRow {
    pub id: String,
    pub advertiser: String,
    pub ad_text: String,
    pub click_url: Option<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub times_seen: i64,
}

/// Extract the host portion of a URL without pulling in a URL crate.
pub fn host_of(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split('@').next_back().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    let host = host.strip_prefix("www.").unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ad(text: &str, url: Option<&str>) -> CliAd {
        CliAd {
            ad_text: text.to_string(),
            click_url: url.map(str::to_string),
            icon_url: None,
            icon_ref: None,
            ts: 0,
        }
    }

    #[test]
    fn advertiser_from_middot() {
        assert_eq!(
            ad(
                "Tailscale · the VPN that disappears",
                Some("https://tailscale.com/")
            )
            .advertiser(),
            "Tailscale"
        );
    }

    #[test]
    fn advertiser_from_hyphen() {
        assert_eq!(
            ad(
                "Solo - a better place to run your agents",
                Some("https://soloterm.com/")
            )
            .advertiser(),
            "Solo"
        );
    }

    #[test]
    fn advertiser_falls_back_to_host_for_long_head() {
        // No short brand head -> use the host instead of a sentence fragment.
        assert_eq!(
            ad(
                "this is a long sentence - with a dash",
                Some("https://example.com/x")
            )
            .advertiser(),
            "example.com"
        );
    }

    #[test]
    fn advertiser_unknown_without_url() {
        assert_eq!(ad("just some text", None).advertiser(), "unknown");
    }

    #[test]
    fn tagline_from_each_separator() {
        assert_eq!(
            ad("Tailscale · the VPN that disappears", None).tagline(),
            "the VPN that disappears"
        );
        assert_eq!(
            ad("Solo - a better place to run your agents", None).tagline(),
            "a better place to run your agents"
        );
        assert_eq!(
            ad("Ramp — business cards that close themselves", None).tagline(),
            "business cards that close themselves"
        );
    }

    #[test]
    fn tagline_falls_back_to_full_text() {
        // No name-like head: the whole creative is the tagline.
        assert_eq!(ad("just some text", None).tagline(), "just some text");
        assert_eq!(
            ad("this is a long sentence - with a dash", None).tagline(),
            "this is a long sentence - with a dash"
        );
    }

    #[test]
    fn id_is_stable_and_text_sensitive() {
        let a = ad("Solo - run agents", Some("https://soloterm.com/"));
        let b = ad("Solo - run agents", Some("https://soloterm.com/"));
        let c = ad("Solo - different copy", Some("https://soloterm.com/"));
        assert_eq!(a.id(), b.id());
        assert_ne!(a.id(), c.id());
        assert_eq!(a.id().len(), 16);
    }

    #[test]
    fn host_parsing() {
        assert_eq!(
            host_of("https://www.tailscale.com/path?x=1"),
            Some("tailscale.com".into())
        );
        assert_eq!(host_of("http://linear.app"), Some("linear.app".into()));
        assert_eq!(host_of("not a url"), Some("not a url".into()));
    }
}
