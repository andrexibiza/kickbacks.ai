//! The shared dashboard renderer. `kb top`, `kb snapshot`, and the README
//! asset generator all draw through the single `ui` function here, so the
//! three surfaces can never disagree about what the dashboard looks like.
//!
//! Colors come from a [`Palette`](crate::theme::Palette) carried on [`App`],
//! not from hardcoded constants, so the same renderer produces the dark, light,
//! and terminal-native looks. When the palette paints a background, `ui` fills
//! the whole canvas first so the dashboard reads the same on any terminal.
//!
//! Demo data is produced by seeding a real in-memory archive and running the
//! same refresh path as live data, so the demo cannot drift from reality.

use anyhow::Result;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Cell, Clear, Padding, Paragraph, Row, Table};
use ratatui::Frame;

use crate::archive::{AdvertiserStat, Archive, Stats};
use crate::chart::ChartStyle;
use crate::model::{host_of, AdRow, CliAd};
use crate::sources::{self, LiveState};
use crate::theme::{Palette, Theme};
use crate::util;

/// `cli-ad.json` freshness window, mirroring the extension.
const FRESH_MS: i64 = 600_000;

const HOUR_MS: i64 = 60 * 60 * 1000;

/// Where real earnings live. kb stays read-only and offline, so it points here
/// rather than reading balances (that needs the Kickback.ai cloud backend,
/// which the honesty invariant keeps out of scope).
pub const PORTFOLIO_URL: &str = "https://kickbacks.ai/me";

// ---- app state ------------------------------------------------------------

/// State of the in-TUI theme picker overlay. Present only while the picker is
/// open. The dashboard behind it renders with the previewed theme so the user
/// sees the change live before committing.
#[derive(Debug, Clone)]
pub struct ThemePicker {
    pub options: Vec<Theme>,
    pub cursor: usize,
    /// The theme that was active when the picker opened, restored on cancel.
    pub original: Theme,
}

impl ThemePicker {
    /// Open the picker with the cursor on the currently active theme.
    pub fn open(current: Theme) -> Self {
        let options = Theme::all().to_vec();
        let cursor = options.iter().position(|&t| t == current).unwrap_or(0);
        ThemePicker {
            options,
            cursor,
            original: current,
        }
    }

    /// The theme currently under the cursor (the live preview).
    pub fn selected(&self) -> Theme {
        self.options[self.cursor]
    }

    pub fn up(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn down(&mut self) {
        if self.cursor + 1 < self.options.len() {
            self.cursor += 1;
        }
    }
}

#[derive(Default)]
pub struct App {
    pub now_ms: i64,
    pub stats: Stats,
    /// Hourly activity, oldest first. `None` = kb was not watching that hour.
    pub sparkline: Vec<Option<u64>>,
    pub leaderboard: Vec<AdvertiserStat>,
    pub recent: Vec<AdRow>,
    pub live: LiveState,
    pub current: Option<CliAd>,
    pub demo: bool,
    /// The active theme selection (shown in the keybind line, saved to config).
    pub theme: Theme,
    /// Concrete colors to draw with, derived from `theme`.
    pub palette: Palette,
    /// The activity chart style for the sightings panel.
    pub chart_style: ChartStyle,
    /// Some while the theme picker overlay is open.
    pub picker: Option<ThemePicker>,
}

impl App {
    /// Refresh everything: archive queries plus the live extension artifacts.
    pub fn refresh(&mut self, archive: &Archive) -> Result<()> {
        self.refresh_from_archive(archive, util::now_ms())?;
        self.live = sources::read_live_state().unwrap_or_default();
        self.current = sources::read_cli_ad().ok().flatten();
        Ok(())
    }

    /// Apply a theme: store it and resolve its concrete palette.
    pub fn set_theme(&mut self, theme: Theme) {
        self.theme = theme;
        self.palette = theme.palette();
    }

    /// Refresh only the archive-backed panels, relative to `now_ms`. The demo
    /// path uses this with a fixed clock so the output is stable.
    fn refresh_from_archive(&mut self, archive: &Archive, now_ms: i64) -> Result<()> {
        self.now_ms = now_ms;
        self.stats = archive.stats(now_ms)?;
        self.sparkline = archive.hourly_activity(now_ms, 24)?;
        self.leaderboard = archive.advertiser_leaderboard(8)?;
        self.recent = archive.list_ads(8)?;
        Ok(())
    }
}

// ---- demo data ------------------------------------------------------------

/// Fixed demo clock so generated assets are reproducible.
const DEMO_NOW_MS: i64 = 1_781_210_000_000;

/// Hourly sighting counts for the demo, oldest first.
const DEMO_HOURS: [u64; 24] = [
    1, 2, 1, 3, 4, 6, 5, 7, 6, 8, 6, 9, 7, 5, 4, 6, 8, 7, 5, 3, 4, 6, 5, 2,
];

const DEMO_CREATIVES: [(&str, &str); 16] = [
    (
        "Tailscale · the VPN that disappears",
        "https://tailscale.com/",
    ),
    (
        "Tailscale · zero-config mesh networking",
        "https://tailscale.com/",
    ),
    ("Linear · issues you actually close", "https://linear.app/"),
    ("Linear · built for speed", "https://linear.app/"),
    ("Vercel · ship in seconds", "https://vercel.com/"),
    ("Vercel · previews for every push", "https://vercel.com/"),
    ("Neon · Postgres that scales to zero", "https://neon.tech/"),
    ("Neon · branch your database", "https://neon.tech/"),
    (
        "Sentry · catch errors before users do",
        "https://sentry.io/",
    ),
    ("Sentry · trace every release", "https://sentry.io/"),
    (
        "Supabase · the open source Firebase",
        "https://supabase.com/",
    ),
    ("Supabase · auth in five minutes", "https://supabase.com/"),
    ("Fly.io · run your app close to users", "https://fly.io/"),
    ("Fly.io · machines that boot in millis", "https://fly.io/"),
    (
        "Cloudflare · the network is the computer",
        "https://cloudflare.com/",
    ),
    ("Cloudflare · cache everything", "https://cloudflare.com/"),
];

/// Seed an in-memory archive with representative data. Goes through the exact
/// same capture path as real ads.
fn demo_archive(now_ms: i64) -> Result<Archive> {
    let mut archive = Archive::open_in_memory()?;
    let end_hour = now_ms / HOUR_MS * HOUR_MS;
    let mut k = 0usize;
    for (i, &count) in DEMO_HOURS.iter().enumerate() {
        let hour_start = end_hour - (23 - i as i64) * HOUR_MS;
        archive.record_observation(hour_start)?;
        for j in 0..count {
            let (text, url) = DEMO_CREATIVES[k % DEMO_CREATIVES.len()];
            k += 1;
            let observed = hour_start + (j as i64) * 60_000 + 5_000;
            let ad = CliAd {
                ad_text: text.to_string(),
                click_url: Some(url.to_string()),
                icon_url: None,
                icon_ref: None,
                ts: observed,
            };
            archive.capture_ad(&ad, observed)?;
        }
    }
    Ok(archive)
}

/// Build the demo dashboard through the real refresh path. Clearly labelled
/// "demo data" in the header so it is never mistaken for real stats.
pub fn demo_app() -> App {
    let mut app = App {
        demo: true,
        ..App::default()
    };
    if let Ok(archive) = demo_archive(DEMO_NOW_MS) {
        app.refresh_from_archive(&archive, DEMO_NOW_MS).ok();
    }
    app.live = LiveState {
        signed_in: Some(true),
        injection_on: Some(true),
        ..Default::default()
    };
    app.current = Some(CliAd {
        ad_text: "Tailscale · the VPN that disappears".to_string(),
        click_url: Some("https://tailscale.com/".to_string()),
        icon_url: None,
        icon_ref: None,
        ts: DEMO_NOW_MS - 12_000,
    });
    app
}

// ---- rendering ------------------------------------------------------------

/// Foreground-only style. Background is handled once, by the canvas fill in
/// [`ui`], so individual spans never need to carry it.
fn fg(color: Color) -> Style {
    Style::default().fg(color)
}

/// A solid-background style for surfaces (the canvas, the picker overlay).
fn bg_style(pal: &Palette) -> Style {
    match pal.bg {
        Some(bg) => Style::default().bg(bg),
        None => Style::default(),
    }
}

pub fn ui(frame: &mut Frame, app: &App) {
    let pal = &app.palette;
    let area = frame.area();

    // Paint the whole canvas once. Every widget below sets only a foreground,
    // so these background cells survive and the dashboard reads the same on a
    // light or dark terminal. The `terminal` palette leaves `bg` as `None` and
    // inherits the terminal's own background.
    if pal.bg.is_some() {
        frame.render_widget(Block::default().style(bg_style(pal)), area);
    }

    let outer = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(fg(pal.frame))
        .padding(Padding::new(1, 1, 0, 0))
        .title_top(brand_title(pal, app.demo))
        .title_top(status_chips(pal, &app.live).right_aligned())
        .title_bottom(keybinds_line(pal, app.theme, app.chart_style))
        .title_bottom(ethic_line(pal).right_aligned());

    let inner = outer.inner(area);
    frame.render_widget(outer, area);

    let columns = Layout::horizontal([Constraint::Percentage(48), Constraint::Percentage(52)])
        .spacing(1)
        .split(inner);

    render_left(frame, columns[0], app);
    render_right(frame, columns[1], app);

    if app.picker.is_some() {
        render_theme_picker(frame, area, app);
    }
}

fn brand_title(pal: &Palette, demo: bool) -> Line<'static> {
    let mut spans = vec![
        Span::styled(" kickbacks", fg(pal.gold).add_modifier(Modifier::BOLD)),
        Span::styled("-kit ", fg(pal.fg).add_modifier(Modifier::BOLD)),
        Span::styled("· attention console ", fg(pal.dim)),
    ];
    if demo {
        spans.push(Span::styled(
            "· demo data ",
            fg(pal.dim).add_modifier(Modifier::ITALIC),
        ));
    }
    Line::from(spans)
}

fn status_chips(pal: &Palette, live: &LiveState) -> Line<'static> {
    let mut spans = Vec::new();
    let signed = live.signed_in.unwrap_or(false);
    spans.push(chip(pal, signed, "signed in", "signed out"));
    spans.push(Span::raw("  "));
    let ads_on = live.injection_on.unwrap_or(false);
    spans.push(chip(pal, ads_on, "ads on", "ads off"));
    if live.killed.unwrap_or(false) {
        spans.push(Span::raw("  "));
        spans.push(Span::styled("● killed", fg(pal.red)));
    }
    spans.push(Span::raw(" "));
    Line::from(spans)
}

fn chip(pal: &Palette, on: bool, yes: &str, no: &str) -> Span<'static> {
    if on {
        Span::styled(format!("● {yes}"), fg(pal.green))
    } else {
        Span::styled(format!("○ {no}"), fg(pal.dim))
    }
}

fn keybinds_line(pal: &Palette, theme: Theme, chart: ChartStyle) -> Line<'static> {
    Line::from(vec![
        Span::styled(" q ", fg(pal.gold)),
        Span::styled("quit  ", fg(pal.dim)),
        Span::styled("r ", fg(pal.gold)),
        Span::styled("refresh  ", fg(pal.dim)),
        Span::styled("t ", fg(pal.gold)),
        Span::styled(format!("theme: {}  ", theme.label()), fg(pal.dim)),
        Span::styled("c ", fg(pal.gold)),
        Span::styled(format!("chart: {} ", chart.label()), fg(pal.dim)),
    ])
}

fn ethic_line(pal: &Palette) -> Line<'static> {
    Line::from(Span::styled(
        " local archive · cloud earnings stay on Kickback.ai ",
        fg(pal.dim).add_modifier(Modifier::ITALIC),
    ))
}

fn render_left(frame: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([Constraint::Length(8), Constraint::Min(0)]).split(area);
    render_now_playing(frame, rows[0], app);
    render_totals(frame, rows[1], app);
}

fn render_right(frame: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::vertical([
        Constraint::Length(8),
        Constraint::Length(12),
        Constraint::Min(0),
    ])
    .split(area);
    render_sparkline(frame, rows[0], app);
    render_leaderboard(frame, rows[1], app);
    render_recent(frame, rows[2], app);
}

/// Build a section: a label line, then the body rect beneath it.
fn section(frame: &mut Frame, area: Rect, pal: &Palette, label: &str) -> Rect {
    let parts = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).split(area);
    let head = Paragraph::new(Line::from(Span::styled(
        label,
        fg(pal.teal).add_modifier(Modifier::BOLD),
    )));
    frame.render_widget(head, parts[0]);
    parts[1]
}

fn render_now_playing(frame: &mut Frame, area: Rect, app: &App) {
    let pal = &app.palette;
    let body = section(frame, area, pal, "LIVE CREATIVE");
    let fresh = app
        .current
        .as_ref()
        .map(|a| app.now_ms - a.ts <= FRESH_MS)
        .unwrap_or(false);

    // Killswitch is the surprising state: make it impossible to miss.
    if app.live.killed.unwrap_or(false) {
        let lines = vec![
            Line::from(Span::styled(
                "● ADS PAUSED",
                fg(pal.red).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled("Kickback.ai killswitch active", fg(pal.red))),
            Line::from(Span::styled("server-side, not you", fg(pal.dim))),
        ];
        frame.render_widget(Paragraph::new(lines), body);
        return;
    }

    let lines = match (&app.current, fresh) {
        (Some(ad), true) => {
            let advertiser = ad.advertiser();
            let tagline = ad.tagline();
            let host = ad
                .click_url
                .as_deref()
                .and_then(host_of)
                .unwrap_or_default();
            let age = util::human_age(app.now_ms - ad.ts);
            vec![
                Line::from(vec![
                    Span::styled("in rotation  ", fg(pal.dim)),
                    Span::styled(advertiser, fg(pal.gold).add_modifier(Modifier::BOLD)),
                ]),
                Line::from(Span::styled(
                    util::truncate(&tagline, area.width.saturating_sub(2) as usize),
                    fg(pal.fg),
                )),
                Line::from(vec![
                    Span::styled("landing  ", fg(pal.dim)),
                    Span::styled(host, fg(pal.teal)),
                ]),
                Line::from(Span::styled(format!("fresh {age} ago"), fg(pal.dim))),
            ]
        }
        _ => vec![
            Line::from(Span::styled(
                "no ad right now",
                fg(pal.dim).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "code with the extension running to see ads",
                fg(pal.dim),
            )),
        ],
    };

    frame.render_widget(Paragraph::new(lines), body);
}

fn render_totals(frame: &mut Frame, area: Rect, app: &App) {
    let pal = &app.palette;
    let body = section(frame, area, pal, "ATTENTION OPS");
    let s = &app.stats;
    let observed = observed_hours(&app.sparkline);
    let expected = app.sparkline.len().max(24);
    let streak = active_streak_hours(&app.sparkline);
    let mut lines = vec![
        metric_pair(
            pal,
            body.width,
            "ads seen",
            s.distinct_ads.to_string(),
            "advertisers",
            s.advertisers.to_string(),
        ),
        metric_pair(
            pal,
            body.width,
            "sightings",
            s.total_sightings.to_string(),
            "repeat rate",
            repeat_rate(s),
        ),
        metric_pair(
            pal,
            body.width,
            "today",
            s.sightings_today.to_string(),
            "this week",
            s.sightings_week.to_string(),
        ),
        metric_pair(
            pal,
            body.width,
            "coverage",
            format!("{observed}/{expected}h"),
            "live streak",
            format!("{streak}h"),
        ),
    ];
    if let Some(first) = s.first_seen_ms {
        lines.push(Line::from(Span::styled(
            format!("since {}", util::fmt_datetime(first)),
            fg(pal.dim).add_modifier(Modifier::ITALIC),
        )));
    }
    if let Some(last) = s.last_seen_ms {
        lines.push(Line::from(Span::styled(
            format!("last capture {} ago", util::human_age(app.now_ms - last)),
            fg(pal.dim).add_modifier(Modifier::ITALIC),
        )));
    }
    // Earnings deliberately live off-screen: kb never reads balances (that
    // needs the cloud backend). Point the user to the real number instead of
    // inventing one.
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("earnings cockpit  ", fg(pal.dim)),
        Span::styled(
            "open Kickback.ai",
            fg(pal.gold).add_modifier(Modifier::BOLD),
        ),
    ]));
    lines.push(Line::from(Span::styled(PORTFOLIO_URL, fg(pal.gold))));
    lines.push(Line::from(Span::styled(
        "read-only · kb does not read balances",
        fg(pal.dim).add_modifier(Modifier::ITALIC),
    )));
    frame.render_widget(Paragraph::new(lines), body);
}

fn metric_pair(
    pal: &Palette,
    width: u16,
    left_label: &'static str,
    left_value: String,
    right_label: &'static str,
    right_value: String,
) -> Line<'static> {
    let col_w = ((width as usize).saturating_sub(2) / 2).max(16);
    let label_w = col_w.saturating_sub(7).max(8);
    Line::from(vec![
        Span::styled(format!("{left_label:<label_w$}"), fg(pal.dim)),
        Span::styled(
            format!("{left_value:<6}"),
            fg(pal.teal).add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(format!("{right_label:<label_w$}"), fg(pal.dim)),
        Span::styled(right_value, fg(pal.gold).add_modifier(Modifier::BOLD)),
    ])
}

fn observed_hours(data: &[Option<u64>]) -> usize {
    data.iter().filter(|hour| hour.is_some()).count()
}

fn active_streak_hours(data: &[Option<u64>]) -> usize {
    data.iter().rev().take_while(|hour| hour.is_some()).count()
}

fn repeat_rate(s: &Stats) -> String {
    if s.distinct_ads <= 0 {
        return "0.0x".to_string();
    }
    format!("{:.1}x", s.total_sightings as f64 / s.distinct_ads as f64)
}

fn percent(part: i64, total: i64) -> String {
    if total <= 0 {
        return "0%".to_string();
    }
    format!(
        "{:.0}%",
        (part as f64 / total as f64 * 100.0).clamp(0.0, 999.0)
    )
}

fn mini_bar(value: i64, max: i64, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let filled = if max <= 0 {
        0
    } else {
        ((value.max(0) as f64 / max as f64) * width as f64).ceil() as usize
    }
    .clamp(0, width);
    format!("{}{}", "█".repeat(filled), "░".repeat(width - filled))
}

fn activity_summary(data: &[Option<u64>], pal: &Palette) -> Line<'static> {
    let observed = observed_hours(data);
    let total: u64 = data.iter().filter_map(|v| *v).sum();
    let peak = data.iter().filter_map(|v| *v).max().unwrap_or(0);
    Line::from(vec![
        Span::styled("total ", fg(pal.dim)),
        Span::styled(total.to_string(), fg(pal.gold).add_modifier(Modifier::BOLD)),
        Span::styled("  peak ", fg(pal.dim)),
        Span::styled(peak.to_string(), fg(pal.teal).add_modifier(Modifier::BOLD)),
        Span::styled("  observed ", fg(pal.dim)),
        Span::styled(format!("{observed}/{}h", data.len().max(24)), fg(pal.dim)),
    ])
}

fn render_sparkline(frame: &mut Frame, area: Rect, app: &App) {
    let pal = &app.palette;
    let body = section(frame, area, pal, "ATTENTION STREAM · LAST 24H");
    if app.sparkline.iter().all(Option::is_none) {
        let hint = Paragraph::new(Line::from(Span::styled(
            "not watching — run kb watch or keep kb top open",
            fg(pal.dim),
        )));
        frame.render_widget(hint, body);
        return;
    }
    match app.chart_style {
        ChartStyle::Heat => {
            let mut lines = heat_strip(&app.sparkline, body, pal);
            if (body.height as usize) > lines.len() {
                lines.push(activity_summary(&app.sparkline, pal));
            }
            frame.render_widget(Paragraph::new(lines), body);
        }
        ChartStyle::Bars => render_bars(frame, body, &app.sparkline, pal),
    }
}

/// The block-bar chart: bars on a continuous baseline floor, with a one-line
/// legend split off below when there are gaps to explain.
fn render_bars(frame: &mut Frame, body: Rect, data: &[Option<u64>], pal: &Palette) {
    let has_gaps = data.iter().any(Option::is_none);
    let (spark_area, legend_area) = if has_gaps && body.height > 1 {
        let parts = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).split(body);
        (parts[0], Some(parts[1]))
    } else {
        (body, None)
    };
    frame.render_widget(Paragraph::new(bars(data, spark_area, pal)), spark_area);
    if let Some(legend) = legend_area {
        let note = Paragraph::new(Line::from(Span::styled(
            "╌ gap · ─ watched, quiet",
            fg(pal.dim).add_modifier(Modifier::ITALIC),
        )));
        frame.render_widget(note, legend);
    }
}

/// Eighth-height block glyphs for a bar column, 1/8 (`▁`) to 8/8 (`█`).
const BAR_BLOCKS: [&str; 8] = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/// Total eighths to fill for `value` against `max` in a column `rows` cells
/// high. Any nonzero value fills at least one eighth, so a real sighting never
/// renders as an empty column.
fn column_eighths(value: u64, max: u64, rows: u16) -> u16 {
    if value == 0 || max == 0 || rows == 0 {
        return 0;
    }
    let total = rows as u64 * 8;
    (value * total).div_ceil(max).clamp(1, total) as u16
}

/// The glyph for one cell, given the column's total eighths and how many rows
/// up from the baseline the cell sits. `None` means an empty cell.
fn bar_cell(col_eighths: u16, row_from_bottom: u16) -> Option<&'static str> {
    let base = row_from_bottom * 8;
    if col_eighths <= base {
        return None;
    }
    let local = (col_eighths - base).min(8);
    Some(BAR_BLOCKS[local as usize - 1])
}

/// Build the bar chart. Observed hours rise as gold bars scaled to the busiest
/// hour, standing on a continuous baseline floor so even a single bar reads as
/// a data point on an axis, never a stick floating in a void. The floor breaks
/// (`╌`) where kb was not watching and stays solid (`─`) for watched-but-quiet
/// hours, so the three states are distinct without any shaded slab.
fn bars(data: &[Option<u64>], area: Rect, pal: &Palette) -> Vec<Line<'static>> {
    let w = (area.width as usize).min(data.len());
    let h = area.height.max(1);
    if w == 0 {
        return Vec::new();
    }
    let visible = &data[data.len() - w..];
    let max = visible.iter().filter_map(|v| *v).max().unwrap_or(0);

    let mut lines = Vec::with_capacity(h as usize);
    for row in (0..h).rev() {
        let mut spans = Vec::with_capacity(w);
        for &hour in visible {
            match hour {
                // A bar's own bottom block is its floor, so no extra rule under it.
                Some(v) if v > 0 => match bar_cell(column_eighths(v, max, h), row) {
                    Some(block) => spans.push(Span::styled(block, fg(pal.gold))),
                    None => spans.push(Span::raw(" ")),
                },
                None if row == 0 => spans.push(Span::styled("╌", fg(pal.dim))),
                Some(0) if row == 0 => spans.push(Span::styled("─", fg(pal.dim))),
                _ => spans.push(Span::raw(" ")),
            }
        }
        lines.push(Line::from(spans));
    }
    lines
}

/// Shade glyphs for the heat ramp on a named-color (terminal) theme, where
/// there is no truecolor to lerp through.
const HEAT_SHADES: [&str; 4] = ["░", "▒", "▓", "█"];

fn is_rgb(c: Color) -> bool {
    matches!(c, Color::Rgb(..))
}

/// Color for an observed hour on a truecolor theme: a lerp from `dim` toward
/// `gold` by the hour's share of the busiest hour. The faintest live hour still
/// sits about 30% toward gold, so it always reads heavier than a quiet sliver.
fn ramp_color(pal: &Palette, value: u64, max: u64) -> Color {
    match (pal.dim, pal.gold) {
        (Color::Rgb(dr, dg, db), Color::Rgb(gr, gg, gb)) => {
            let frac = if max <= 1 {
                1.0
            } else {
                value as f64 / max as f64
            };
            let t = 0.30 + 0.70 * frac.clamp(0.0, 1.0);
            let lerp = |a: u8, b: u8| (a as f64 + (b as f64 - a as f64) * t).round() as u8;
            Color::Rgb(lerp(dr, gr), lerp(dg, gg), lerp(db, gb))
        }
        _ => pal.gold,
    }
}

/// Heat glyph for an observed hour on a named-color theme, by quartile of the
/// busiest hour.
fn heat_glyph(value: u64, max: u64) -> &'static str {
    if max == 0 {
        return HEAT_SHADES[0];
    }
    let q = (value * 4).div_ceil(max).clamp(1, 4) as usize;
    HEAT_SHADES[q - 1]
}

/// The calendar heat strip: one cell per hour, color carrying intensity. Reads
/// the same whether one hour or all twenty-four have data, which is the whole
/// point. Renders the strip, then hour ticks and a legend if the rows are free,
/// trimming from the bottom up when the area is short.
fn heat_strip(data: &[Option<u64>], area: Rect, pal: &Palette) -> Vec<Line<'static>> {
    let w = (area.width as usize).min(data.len());
    if w == 0 {
        return Vec::new();
    }
    let visible = &data[data.len() - w..];
    let max = visible.iter().filter_map(|v| *v).max().unwrap_or(0);
    let truecolor = is_rgb(pal.gold) && is_rgb(pal.dim);

    let cells: Vec<Span> = visible
        .iter()
        .map(|hour| match *hour {
            None => Span::styled("·", fg(pal.dim)),
            Some(0) => Span::styled("▕", fg(pal.dim)),
            Some(v) if truecolor => {
                let mut style = fg(ramp_color(pal, v, max));
                if v == max {
                    style = style.add_modifier(Modifier::BOLD);
                }
                Span::styled("█", style)
            }
            Some(v) => {
                let color = if v * 4 <= max { pal.dim } else { pal.gold };
                Span::styled(heat_glyph(v, max), fg(color))
            }
        })
        .collect();

    let mut lines = vec![Line::from(cells)];
    // Hour ticks only when every hour gets its own column, so they line up.
    if (area.height as usize) > lines.len() && w == data.len() {
        lines.push(tick_line(w, pal));
    }
    if (area.height as usize) > lines.len() {
        lines.push(heat_legend(area.width, pal));
    }
    lines
}

/// A row of relative hour offsets (0, 6, 12, 18 from the oldest hour shown).
fn tick_line(w: usize, pal: &Palette) -> Line<'static> {
    let mut cells = vec![' '; w];
    for (col, label) in [(0usize, "0"), (6, "6"), (12, "12"), (18, "18")] {
        for (i, ch) in label.chars().enumerate() {
            if col + i < w {
                cells[col + i] = ch;
            }
        }
    }
    Line::from(Span::styled(
        cells.into_iter().collect::<String>(),
        fg(pal.dim),
    ))
}

/// The heat legend: how the three hour states read.
fn heat_legend(width: u16, pal: &Palette) -> Line<'static> {
    let dim_italic = fg(pal.dim).add_modifier(Modifier::ITALIC);
    let mut spans = vec![
        Span::styled("· none  ", dim_italic),
        Span::styled("▕ quiet  ", dim_italic),
    ];
    if width >= 28 {
        spans.push(Span::styled("░▒▓█", fg(pal.gold)));
        spans.push(Span::styled(" busier", dim_italic));
    }
    Line::from(spans)
}

fn render_leaderboard(frame: &mut Frame, area: Rect, app: &App) {
    let pal = &app.palette;
    let body = section(frame, area, pal, "MARKET PULSE");
    if app.leaderboard.is_empty() {
        frame.render_widget(empty_hint(pal), body);
        return;
    }
    let max_seen = app
        .leaderboard
        .iter()
        .map(|a| a.sightings)
        .max()
        .unwrap_or(1);
    let name_w = body.width.saturating_sub(27) as usize;
    let rows = app.leaderboard.iter().enumerate().map(|(i, a)| {
        let share = percent(a.sightings, app.stats.total_sightings);
        Row::new(vec![
            Cell::from(Span::styled(format!("{:>2}", i + 1), fg(pal.dim))),
            Cell::from(Span::styled(
                util::truncate(&a.advertiser, name_w),
                fg(pal.fg),
            )),
            Cell::from(Span::styled(
                mini_bar(a.sightings, max_seen, 8),
                fg(pal.gold),
            )),
            Cell::from(Span::styled(share, fg(pal.teal))),
            Cell::from(Span::styled(a.distinct_ads.to_string(), fg(pal.dim))),
            Cell::from(Span::styled(
                a.sightings.to_string(),
                fg(pal.gold).add_modifier(Modifier::BOLD),
            )),
        ])
    });
    let header = Row::new(vec![
        Cell::from(""),
        Cell::from(Span::styled("advertiser", fg(pal.dim))),
        Cell::from(Span::styled("heat", fg(pal.dim))),
        Cell::from(Span::styled("share", fg(pal.dim))),
        Cell::from(Span::styled("ads", fg(pal.dim))),
        Cell::from(Span::styled("seen", fg(pal.dim))),
    ]);
    let widths = [
        Constraint::Length(3),
        Constraint::Min(8),
        Constraint::Length(8),
        Constraint::Length(6),
        Constraint::Length(4),
        Constraint::Length(5),
    ];
    let table = Table::new(rows, widths).header(header).column_spacing(1);
    frame.render_widget(table, body);
}

fn render_recent(frame: &mut Frame, area: Rect, app: &App) {
    let pal = &app.palette;
    let body = section(frame, area, pal, "RECENT ADS");
    if app.recent.is_empty() {
        frame.render_widget(empty_hint(pal), body);
        return;
    }
    let width = body.width.saturating_sub(2) as usize;
    let lines: Vec<Line> = app
        .recent
        .iter()
        .map(|ad| {
            let host = ad
                .click_url
                .as_deref()
                .and_then(host_of)
                .unwrap_or_else(|| "direct".to_string());
            let age = util::human_age(app.now_ms - ad.last_seen_ms);
            let meta = format!("{}x · {} · {}", ad.times_seen, host, age);
            let tagline_w = width.saturating_sub(meta.len()).saturating_sub(4);
            Line::from(vec![
                Span::styled("· ", fg(pal.gold)),
                Span::styled(
                    util::truncate(&ad.advertiser, 14),
                    fg(pal.gold).add_modifier(Modifier::BOLD),
                ),
                Span::styled("  ", fg(pal.dim)),
                Span::styled(util::truncate(&ad_row_tagline(ad), tagline_w), fg(pal.fg)),
                Span::styled("  ", fg(pal.dim)),
                Span::styled(meta, fg(pal.dim)),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), body);
}

fn ad_row_tagline(ad: &AdRow) -> String {
    for sep in [" · ", " — ", " - ", ": "] {
        if let Some((_, rest)) = ad.ad_text.split_once(sep) {
            let rest = rest.trim();
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    ad.ad_text.clone()
}

fn empty_hint(pal: &Palette) -> Paragraph<'static> {
    Paragraph::new(Line::from(Span::styled(
        "nothing captured yet",
        fg(pal.dim),
    )))
}

/// A centered rect of the given size, clamped to `area`.
fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect {
        x: area.x + (area.width - w) / 2,
        y: area.y + (area.height - h) / 2,
        width: w,
        height: h,
    }
}

/// Draw the theme picker overlay on top of the (already previewed) dashboard.
fn render_theme_picker(frame: &mut Frame, area: Rect, app: &App) {
    let pal = &app.palette;
    let Some(picker) = &app.picker else { return };

    let width = 46;
    let height = picker.options.len() as u16 + 4;
    let rect = centered(area, width, height);

    // Clear the region, then paint our own surface so the overlay is opaque.
    frame.render_widget(Clear, rect);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(fg(pal.gold))
        .style(bg_style(pal))
        .padding(Padding::new(1, 1, 0, 0))
        .title_top(Line::from(Span::styled(
            " choose a theme ",
            fg(pal.gold).add_modifier(Modifier::BOLD),
        )));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    let parts = Layout::vertical([
        Constraint::Length(picker.options.len() as u16),
        Constraint::Length(1),
    ])
    .split(inner);

    let lines: Vec<Line> = picker
        .options
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let selected = i == picker.cursor;
            let marker = if selected { "›" } else { " " };
            let name_style = if selected {
                fg(pal.gold).add_modifier(Modifier::BOLD)
            } else {
                fg(pal.fg)
            };
            Line::from(vec![
                Span::styled(format!("{marker} "), fg(pal.gold)),
                Span::styled(format!("{:<9}", t.label()), name_style),
                Span::styled(t.hint().to_string(), fg(pal.dim)),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), parts[0]);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "↑↓ preview · enter save · esc cancel",
            fg(pal.dim).add_modifier(Modifier::ITALIC),
        ))),
        parts[1],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Stats;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::Terminal;

    fn buffer_of(app: &App) -> Buffer {
        let backend = TestBackend::new(90, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| ui(f, app)).unwrap();
        terminal.backend().buffer().clone()
    }

    fn text_of(buf: &Buffer) -> String {
        buf.content.iter().map(|c| c.symbol()).collect()
    }

    fn rendered(app: &App) -> String {
        text_of(&buffer_of(app))
    }

    #[test]
    fn renders_empty_state_without_panicking() {
        let app = App::default();
        let out = rendered(&app);
        assert!(out.contains("kickbacks"));
        assert!(out.contains("LIVE CREATIVE"));
        assert!(out.contains("no ad right now"));
    }

    #[test]
    fn renders_populated_state() {
        let app = App {
            now_ms: 1_781_210_400_000,
            stats: Stats {
                distinct_ads: 3,
                advertisers: 3,
                total_sightings: 5,
                sightings_today: 5,
                sightings_week: 5,
                first_seen_ms: Some(1_781_210_098_155),
                last_seen_ms: Some(1_781_210_380_000),
            },
            sparkline: vec![None, Some(1), Some(2), Some(3), Some(2), Some(1), Some(4)],
            leaderboard: vec![AdvertiserStat {
                advertiser: "Tailscale".to_string(),
                distinct_ads: 1,
                sightings: 2,
            }],
            recent: vec![AdRow {
                id: "abc".to_string(),
                advertiser: "Tailscale".to_string(),
                ad_text: "Tailscale · the VPN that disappears".to_string(),
                click_url: Some("https://tailscale.com/".to_string()),
                first_seen_ms: 1_781_210_098_155,
                last_seen_ms: 1_781_210_380_000,
                times_seen: 2,
            }],
            live: LiveState {
                signed_in: Some(true),
                injection_on: Some(true),
                ..Default::default()
            },
            current: Some(CliAd {
                ad_text: "Tailscale · the VPN that disappears".to_string(),
                click_url: Some("https://tailscale.com/".to_string()),
                icon_url: None,
                icon_ref: None,
                ts: 1_781_210_399_000,
            }),
            ..App::default()
        };
        let out = rendered(&app);
        assert!(out.contains("Tailscale"));
        assert!(out.contains("ATTENTION OPS"));
        assert!(out.contains("signed in"));
    }

    #[test]
    fn bars_style_marks_gaps_on_the_baseline() {
        let app = App {
            now_ms: 1_781_210_400_000,
            sparkline: vec![None, Some(2), Some(0), Some(4)],
            chart_style: ChartStyle::Bars,
            ..App::default()
        };
        let out = rendered(&app);
        assert!(out.contains("╌"), "gaps mark the floor");
        assert!(out.contains("gap"), "legend explains the floor");
        assert!(!out.contains('░'), "no shaded slab anywhere");
    }

    #[test]
    fn sparkline_all_unobserved_says_not_watching() {
        let app = App {
            sparkline: vec![None; 24],
            ..App::default()
        };
        let out = rendered(&app);
        assert!(out.contains("not watching — run kb watch"));
    }

    #[test]
    fn bar_height_scales_and_never_vanishes() {
        assert_eq!(column_eighths(4, 4, 5), 40); // full value fills the column
        assert_eq!(column_eighths(1, 1000, 5), 1); // tiny value still shows 1/8
        assert_eq!(column_eighths(0, 4, 5), 0);
        assert_eq!(column_eighths(4, 0, 5), 0);
    }

    #[test]
    fn bar_cells_fill_bottom_up() {
        // Column of 10/40 eighths: bottom cell full, next cell 2/8, rest empty.
        assert_eq!(bar_cell(10, 0), Some("█"));
        assert_eq!(bar_cell(10, 1), Some("▂"));
        assert_eq!(bar_cell(10, 2), None);
    }

    #[test]
    fn bars_gaps_only_mark_the_baseline_not_full_height() {
        // Mostly unobserved with one tall bar. Gap columns must show a single
        // baseline mark, never a full-height shaded slab (the old ugliness):
        // the floor-char count stays near one row, not rows times columns.
        let app = App {
            now_ms: 1,
            sparkline: {
                let mut d = vec![None; 24];
                d[23] = Some(10);
                d
            },
            chart_style: ChartStyle::Bars,
            ..App::default()
        };
        let text = rendered(&app);
        assert!(text.contains("█"), "the data bar should render");
        assert!(!text.contains('░'), "no shaded slab");
        let floor = text.matches('╌').count();
        assert!(floor <= 24, "floor should be one row: {floor}");
    }

    #[test]
    fn demo_app_renders() {
        let out = rendered(&demo_app());
        assert!(out.contains("Tailscale"));
        assert!(out.contains("demo data"));
        assert!(out.contains("ATTENTION OPS"));
    }

    #[test]
    fn earnings_pointer_is_honest_not_a_number() {
        // The dashboard must point to where earnings live, never show a
        // fabricated balance. This guards the honesty invariant.
        let out = rendered(&demo_app());
        assert!(out.contains("earnings"));
        assert!(out.contains("kickbacks.ai/me"));
        assert!(out.contains("does not read balances"));
    }

    #[test]
    fn demo_app_is_internally_consistent() {
        // The demo flows through the real archive, so its numbers must agree
        // with each other: sightings = sum of the hourly sparkline.
        let app = demo_app();
        let spark_total: u64 = app.sparkline.iter().map(|v| v.unwrap_or(0)).sum();
        assert_eq!(app.stats.total_sightings as u64, spark_total);
        assert_eq!(app.stats.advertisers, 8);
        assert!(app.sparkline.iter().all(Option::is_some));
        assert!(!app.leaderboard.is_empty());
        assert!(!app.recent.is_empty());
    }

    // ---- chart styles ------------------------------------------------------

    /// Flatten a single rendered line back to text (test helper).
    fn line_text(line: &Line) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    #[test]
    fn heat_strip_marks_three_states_distinctly() {
        // On a truecolor theme: a gap, a quiet hour, and a sighting each render
        // with their own glyph, and the strip itself carries no shaded slab.
        // Height 1 so only the strip row is built (no ticks, no legend swatch).
        let area = Rect {
            x: 0,
            y: 0,
            width: 12,
            height: 1,
        };
        let lines = heat_strip(&[None, Some(0), Some(5)], area, &Palette::dark());
        let strip = line_text(&lines[0]);
        assert!(strip.contains('·'), "gap mark");
        assert!(strip.contains('▕'), "quiet mark");
        assert!(strip.contains('█'), "sighting cell");
        assert!(!strip.contains('░'), "no slab in the strip");
    }

    #[test]
    fn heat_renders_one_cell_per_observed_hour() {
        // Honesty: exactly one filled cell per Some(n>0) hour, nothing invented.
        let area = Rect {
            x: 0,
            y: 0,
            width: 12,
            height: 1,
        };
        let data = [Some(2), None, Some(0), Some(5), None, Some(1)];
        let lines = heat_strip(&data, area, &Palette::dark());
        let blocks = line_text(&lines[0]).matches('█').count();
        assert_eq!(blocks, 3, "one cell per observed hour");
    }

    // ---- theming -----------------------------------------------------------

    #[test]
    fn every_theme_and_chart_style_renders_without_panicking() {
        for theme in Theme::all() {
            for style in [ChartStyle::Heat, ChartStyle::Bars] {
                let mut app = demo_app();
                app.set_theme(theme);
                app.chart_style = style;
                let out = rendered(&app);
                assert!(
                    out.contains("kickbacks"),
                    "theme {:?} / chart {:?} lost content",
                    theme,
                    style
                );
                assert!(out.contains("ATTENTION OPS"));
            }
        }
    }

    #[test]
    fn painted_theme_fills_the_canvas() {
        // Dark/light paint a background, so the top-left cell carries the
        // palette's bg color rather than the terminal default. This is the fix
        // for the washed-out-on-a-light-terminal bug.
        for theme in [Theme::Dark, Theme::Light] {
            let mut app = demo_app();
            app.set_theme(theme);
            let buf = buffer_of(&app);
            let bg = app.palette.bg.unwrap();
            assert_eq!(buf.content[0].bg, bg, "theme {:?} did not paint", theme);
        }
    }

    #[test]
    fn terminal_theme_inherits_the_background() {
        let mut app = demo_app();
        app.set_theme(Theme::Terminal);
        let buf = buffer_of(&app);
        // No painted canvas: the cell keeps the default (reset) background.
        assert_eq!(buf.content[0].bg, Color::Reset);
    }

    #[test]
    fn theme_label_is_shown_in_the_keybind_line() {
        let mut app = demo_app();
        app.set_theme(Theme::Light);
        assert!(rendered(&app).contains("theme: light"));
    }

    #[test]
    fn picker_overlay_lists_themes() {
        let mut app = demo_app();
        app.picker = Some(ThemePicker::open(app.theme));
        let out = rendered(&app);
        assert!(out.contains("choose a theme"));
        assert!(out.contains("auto"));
        assert!(out.contains("light"));
        assert!(out.contains("terminal"));
        assert!(out.contains("enter save"));
    }

    #[test]
    fn picker_cursor_starts_on_current_theme() {
        let picker = ThemePicker::open(Theme::Light);
        assert_eq!(picker.selected(), Theme::Light);
        let picker = ThemePicker::open(Theme::Terminal);
        assert_eq!(picker.selected(), Theme::Terminal);
    }

    #[test]
    fn picker_navigation_is_clamped() {
        let mut picker = ThemePicker::open(Theme::Auto); // cursor 0
        picker.up();
        assert_eq!(picker.cursor, 0);
        for _ in 0..10 {
            picker.down();
        }
        assert_eq!(picker.cursor, picker.options.len() - 1);
    }

    /// Not a test: a generator for the README hero image. Run explicitly with
    /// `cargo test --release -- --ignored generate_readme_svg`. Writes
    /// `media/kbtop.svg` from the demo dashboard. Always uses the dark theme so
    /// the hero stays consistent.
    #[test]
    #[ignore = "asset generator, run manually"]
    fn generate_readme_svg() {
        let mut app = demo_app();
        app.set_theme(Theme::Dark);
        let backend = TestBackend::new(86, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| ui(f, &app)).unwrap();
        let svg = crate::svg::buffer_to_svg(terminal.backend().buffer());
        std::fs::create_dir_all("media").unwrap();
        std::fs::write("media/kbtop.svg", svg).unwrap();
    }
}
