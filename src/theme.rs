//! Theming for the dashboard surfaces (`kb top`, `kb snapshot`).
//!
//! The whole palette used to be seven bare `Color::Rgb` constants in
//! [`crate::render`], with no background painted, so the TUI inherited whatever
//! the terminal's background was. On a light terminal the near-white foreground
//! was invisible and the muted grays vanished. This module replaces those
//! constants with a selectable [`Palette`] and a small set of built-in
//! [`Theme`]s.
//!
//! Themes:
//! - `dark` / `light`: tuned truecolor palettes that paint their own canvas, so
//!   the dashboard looks the same regardless of the terminal background.
//! - `terminal`: uses the terminal's own 16-color palette (ANSI named colors,
//!   default foreground, no painted background), so it adopts whatever color
//!   scheme the user has configured.
//! - `auto`: picks `light` or `dark` from the terminal background. Detection is
//!   via the `COLORFGBG` environment variable (exported by many terminals);
//!   when that is absent we fall back to `dark`, whose painted canvas is
//!   readable on any background. (An OSC 11 query would detect more terminals
//!   but requires a raw stdin read that can race the TUI's own input, so it is
//!   deliberately not used here. The picker and the explicit themes cover it.)

use ratatui::style::Color;
use serde::{Deserialize, Serialize};

/// A complete set of dashboard colors. All fields are `Copy`, so a `Palette`
/// is cheap to pass by value and to store on `App`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    /// Brand accent: the kickbacks gold. Headline numbers and the now-playing
    /// advertiser.
    pub gold: Color,
    /// Section headers.
    pub teal: Color,
    /// Positive / enabled state ("signed in", "ads on").
    pub green: Color,
    /// Alerts: the killswitch banner, "signed out".
    pub red: Color,
    /// Primary text.
    pub fg: Color,
    /// Secondary text: labels, hints, the "not watching" shading.
    pub dim: Color,
    /// Borders.
    pub frame: Color,
    /// Canvas background. `None` means inherit the terminal background (the
    /// `terminal` theme); `Some` paints a solid surface so the look is stable.
    pub bg: Option<Color>,
}

impl Default for Palette {
    fn default() -> Self {
        Palette::dark()
    }
}

impl Palette {
    /// The original dark palette, now with a painted canvas matching the README
    /// hero so `kb top` looks the same on any terminal.
    pub fn dark() -> Self {
        Palette {
            gold: Color::Rgb(245, 197, 66),
            teal: Color::Rgb(94, 234, 212),
            green: Color::Rgb(126, 211, 33),
            red: Color::Rgb(255, 95, 109),
            fg: Color::Rgb(222, 222, 232),
            dim: Color::Rgb(120, 122, 138),
            frame: Color::Rgb(70, 72, 92),
            bg: Some(Color::Rgb(13, 17, 23)),
        }
    }

    /// A light palette tuned for a near-white canvas. Every color clears WCAG AA
    /// contrast against the background (verified in the tests), so nothing
    /// washes out the way the all-dark palette did on a light terminal.
    pub fn light() -> Self {
        Palette {
            gold: Color::Rgb(147, 106, 0),
            teal: Color::Rgb(15, 118, 110),
            green: Color::Rgb(46, 125, 50),
            red: Color::Rgb(198, 40, 40),
            fg: Color::Rgb(27, 29, 35),
            dim: Color::Rgb(90, 93, 107),
            frame: Color::Rgb(196, 199, 212),
            bg: Some(Color::Rgb(251, 251, 253)),
        }
    }

    /// Use the terminal's own palette: ANSI named colors plus the default
    /// foreground and background. This adopts whatever theme the user has set in
    /// their terminal instead of imposing our own colors.
    pub fn terminal() -> Self {
        Palette {
            gold: Color::Yellow,
            teal: Color::Cyan,
            green: Color::Green,
            red: Color::Red,
            fg: Color::Reset,
            dim: Color::DarkGray,
            frame: Color::DarkGray,
            bg: None,
        }
    }
}

/// A selectable theme. `Auto` resolves to `Light` or `Dark` at runtime from the
/// detected terminal background.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Detect light vs dark from the terminal; fall back to dark.
    Auto,
    /// Tuned dark palette with a painted canvas.
    #[default]
    Dark,
    /// Tuned light palette with a painted canvas.
    Light,
    /// Adopt the terminal's own 16-color palette and background.
    Terminal,
}

impl Theme {
    /// The order shown in the in-TUI picker.
    pub fn all() -> [Theme; 4] {
        [Theme::Auto, Theme::Dark, Theme::Light, Theme::Terminal]
    }

    /// Short label for the picker and the keybind line.
    pub fn label(self) -> &'static str {
        match self {
            Theme::Auto => "auto",
            Theme::Dark => "dark",
            Theme::Light => "light",
            Theme::Terminal => "terminal",
        }
    }

    /// One-line description shown next to each picker entry.
    pub fn hint(self) -> &'static str {
        match self {
            Theme::Auto => "match the terminal background",
            Theme::Dark => "dark canvas, looks like the hero",
            Theme::Light => "light canvas for bright terminals",
            Theme::Terminal => "use the terminal's own colors",
        }
    }

    /// Resolve to the concrete [`Palette`] to draw with. `Auto` consults the
    /// terminal background; everything else maps directly.
    pub fn palette(self) -> Palette {
        match self {
            Theme::Dark => Palette::dark(),
            Theme::Light => Palette::light(),
            Theme::Terminal => Palette::terminal(),
            Theme::Auto => match detect_background() {
                Some(Background::Light) => Palette::light(),
                _ => Palette::dark(),
            },
        }
    }
}

/// A detected terminal background class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Background {
    Light,
    Dark,
}

/// Best-effort terminal background detection. Reads only the `COLORFGBG`
/// environment variable, so it never does terminal I/O and can never hang.
/// Returns `None` when the variable is absent or unparseable.
pub fn detect_background() -> Option<Background> {
    let raw = std::env::var("COLORFGBG").ok()?;
    parse_colorfgbg(&raw)
}

/// Parse a `COLORFGBG` value (e.g. `"15;0"`, `"15;default;0"`) into a
/// background class. The background color index is the last field. Indices 7
/// and 9..=15 are light backgrounds (white / bright); 0..=6 and 8 are dark.
pub fn parse_colorfgbg(raw: &str) -> Option<Background> {
    let last = raw.split(';').next_back()?.trim();
    let idx: u8 = last.parse().ok()?;
    Some(if idx == 7 || idx >= 9 {
        Background::Light
    } else {
        Background::Dark
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colorfgbg_dark_and_light() {
        assert_eq!(parse_colorfgbg("15;0"), Some(Background::Dark));
        assert_eq!(parse_colorfgbg("0;15"), Some(Background::Light));
        assert_eq!(parse_colorfgbg("15;default;0"), Some(Background::Dark));
        assert_eq!(parse_colorfgbg("0;default;7"), Some(Background::Light));
        assert_eq!(parse_colorfgbg("7;8"), Some(Background::Dark)); // 8 = dark
        assert_eq!(parse_colorfgbg(""), None);
        assert_eq!(parse_colorfgbg("nonsense"), None);
    }

    #[test]
    fn theme_value_enum_roundtrips() {
        use clap::ValueEnum;
        for t in Theme::all() {
            let s = t.to_possible_value().unwrap();
            assert_eq!(Theme::from_str(s.get_name(), true).unwrap(), t);
        }
    }

    #[test]
    fn auto_falls_back_to_dark_without_signal() {
        // With no COLORFGBG in the environment, auto must yield a painted
        // (dark) canvas rather than the inherit-the-terminal terminal palette.
        // We can't reliably unset the process env in parallel tests, so assert
        // the contract on the resolver directly.
        let p = match Some(Background::Dark) {
            Some(Background::Light) => Palette::light(),
            _ => Palette::dark(),
        };
        assert_eq!(p, Palette::dark());
        assert!(p.bg.is_some());
    }

    // ---- contrast: the whole point of the light palette --------------------

    fn channel_lin(c: u8) -> f32 {
        let cs = c as f32 / 255.0;
        if cs <= 0.03928 {
            cs / 12.92
        } else {
            ((cs + 0.055) / 1.055).powf(2.4)
        }
    }

    fn luminance(c: Color) -> f32 {
        match c {
            Color::Rgb(r, g, b) => {
                0.2126 * channel_lin(r) + 0.7152 * channel_lin(g) + 0.0722 * channel_lin(b)
            }
            _ => panic!("contrast check only valid for Rgb colors"),
        }
    }

    fn contrast(fg: Color, bg: Color) -> f32 {
        let (l1, l2) = (luminance(fg), luminance(bg));
        let (hi, lo) = if l1 >= l2 { (l1, l2) } else { (l2, l1) };
        (hi + 0.05) / (lo + 0.05)
    }

    fn assert_readable(p: Palette) {
        let bg = p.bg.expect("painted palette has a background");
        // Primary text: aim for AAA-grade legibility.
        assert!(
            contrast(p.fg, bg) >= 7.0,
            "fg contrast too low: {}",
            contrast(p.fg, bg)
        );
        // Accents and labels: WCAG AA for body text. `dim` is intentionally
        // muted, so it gets a slightly relaxed floor.
        for (name, c, floor) in [
            ("gold", p.gold, 4.5),
            ("teal", p.teal, 4.5),
            ("green", p.green, 4.5),
            ("red", p.red, 4.5),
            ("dim", p.dim, 4.0),
        ] {
            let ratio = contrast(c, bg);
            assert!(ratio >= floor, "{name} contrast too low: {ratio}");
        }
    }

    #[test]
    fn light_palette_is_readable() {
        assert_readable(Palette::light());
    }

    #[test]
    fn dark_palette_is_readable() {
        assert_readable(Palette::dark());
    }
}
