//! The activity chart style for the "SIGHTINGS · LAST 24H" panel. Mirrors the
//! [`crate::theme`] machinery: a small enum, a clap value, a serde field, and a
//! key to cycle it live in `kb top`.
//!
//! Two styles, both palette-driven and dependency-free:
//! - `heat`: a calendar strip, one cell per hour, intensity by count. Stays
//!   clean whether one hour has data or all twenty-four do, which is why it is
//!   the default (the old chart fell apart on sparse data).
//! - `bars`: block bars on a continuous baseline floor, when you want to read
//!   magnitude as height.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum, Default)]
#[serde(rename_all = "lowercase")]
pub enum ChartStyle {
    /// Calendar heat strip: one cell per hour, color by intensity.
    #[default]
    Heat,
    /// Block bars on a baseline floor: height shows how busy each hour was.
    Bars,
}

impl ChartStyle {
    /// Short label for the keybind line and the flag.
    pub fn label(self) -> &'static str {
        match self {
            ChartStyle::Heat => "heat",
            ChartStyle::Bars => "bars",
        }
    }

    /// The next style when the user presses `c`.
    pub fn next(self) -> ChartStyle {
        match self {
            ChartStyle::Heat => ChartStyle::Bars,
            ChartStyle::Bars => ChartStyle::Heat,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_heat() {
        assert_eq!(ChartStyle::default(), ChartStyle::Heat);
    }

    #[test]
    fn next_cycles() {
        assert_eq!(ChartStyle::Heat.next(), ChartStyle::Bars);
        assert_eq!(ChartStyle::Bars.next(), ChartStyle::Heat);
    }

    #[test]
    fn value_enum_roundtrips() {
        use clap::ValueEnum;
        for s in [ChartStyle::Heat, ChartStyle::Bars] {
            let v = s.to_possible_value().unwrap();
            assert_eq!(ChartStyle::from_str(v.get_name(), true).unwrap(), s);
        }
    }
}
