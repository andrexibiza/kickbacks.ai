//! `kb snapshot` — a one-shot, non-interactive render of the dashboard to
//! stdout. This exists because an interactive ratatui TUI cannot run inside
//! another tool's output pane (a Claude Code slash command, a CI log, a
//! script); a snapshot can be printed anywhere. Same renderer as `kb top`.

use std::io::IsTerminal;

use anyhow::Result;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;

use crate::archive::Archive;
use crate::capture::capture_pass;
use crate::chart::ChartStyle;
use crate::config;
use crate::paths;
use crate::render::{ui, App};
use crate::theme::Theme;

const DEFAULT_WIDTH: u16 = 100;
const MIN_WIDTH: u16 = 80;
const MAX_WIDTH: u16 = 140;
const HEIGHT: u16 = 30;

/// Capture once, then print the dashboard. Color is used when stdout is a
/// terminal; `plain` forces it off (useful when piping into another tool).
/// `theme_arg`/`chart_arg` are the flags; when absent the saved config decides.
pub fn run(
    width: Option<u16>,
    plain: bool,
    theme_arg: Option<Theme>,
    chart_arg: Option<ChartStyle>,
) -> Result<()> {
    let mut archive = Archive::open(&paths::db_path()?)?;
    capture_pass(&mut archive)?;
    let cfg = config::load();
    let mut app = App::default();
    app.set_theme(theme_arg.unwrap_or(cfg.theme));
    app.chart_style = chart_arg.unwrap_or(cfg.chart_style);
    app.refresh(&archive)?;

    let width = width
        .or_else(|| crossterm::terminal::size().ok().map(|(w, _)| w))
        .unwrap_or(DEFAULT_WIDTH)
        .clamp(MIN_WIDTH, MAX_WIDTH);
    let color = !plain && std::io::stdout().is_terminal();
    print!("{}", render_to_string(&app, width, HEIGHT, color)?);
    Ok(())
}

/// Render the app into a fixed-size buffer and serialize it to text, with or
/// without ANSI colors.
pub fn render_to_string(app: &App, width: u16, height: u16, color: bool) -> Result<String> {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|f| ui(f, app))?;
    let buf = terminal.backend().buffer();
    Ok(if color {
        buffer_to_ansi(buf)
    } else {
        buffer_to_plain(buf)
    })
}

fn buffer_to_plain(buf: &Buffer) -> String {
    let area = buf.area;
    let mut out = String::new();
    for y in 0..area.height {
        let mut line = String::new();
        for x in 0..area.width {
            line.push_str(buf.content[(y as usize) * area.width as usize + x as usize].symbol());
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn buffer_to_ansi(buf: &Buffer) -> String {
    let area = buf.area;
    let mut out = String::new();
    for y in 0..area.height {
        let mut current = String::new();
        for x in 0..area.width {
            let cell = &buf.content[(y as usize) * area.width as usize + x as usize];
            let style = sgr(
                cell.fg,
                cell.bg,
                cell.modifier.contains(Modifier::BOLD),
                cell.modifier.contains(Modifier::ITALIC),
            );
            if style != current {
                out.push_str(&style);
                current = style;
            }
            out.push_str(cell.symbol());
        }
        out.push_str("\x1b[0m\n");
    }
    out
}

/// The SGR escape selecting this cell's style, always starting from a reset so
/// runs are self-contained. Emits the background only when the palette paints
/// one (a truecolor cell background); the terminal-native theme leaves it
/// unset so the terminal's own background shows through.
fn sgr(fg: Color, bg: Color, bold: bool, italic: bool) -> String {
    let mut s = String::from("\x1b[0m");
    if let Color::Rgb(r, g, b) = fg {
        s.push_str(&format!("\x1b[38;2;{r};{g};{b}m"));
    }
    if let Color::Rgb(r, g, b) = bg {
        s.push_str(&format!("\x1b[48;2;{r};{g};{b}m"));
    }
    if bold {
        s.push_str("\x1b[1m");
    }
    if italic {
        s.push_str("\x1b[3m");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::demo_app;

    #[test]
    fn plain_snapshot_has_content_and_no_escapes() {
        let out = render_to_string(&demo_app(), 100, 30, false).unwrap();
        assert!(out.contains("LIVE CREATIVE"));
        assert!(out.contains("ATTENTION OPS"));
        assert!(out.contains("demo data"));
        assert!(!out.contains('\x1b'));
    }

    #[test]
    fn colored_snapshot_uses_truecolor_escapes() {
        let out = render_to_string(&demo_app(), 100, 30, true).unwrap();
        assert!(out.contains("\x1b[38;2;"));
        assert!(out.contains("LIVE CREATIVE"));
    }

    #[test]
    fn snapshot_respects_width() {
        let out = render_to_string(&demo_app(), 80, 30, false).unwrap();
        assert!(out.lines().all(|l| l.chars().count() <= 80));
    }

    #[test]
    fn colored_snapshot_paints_dark_background() {
        // The dark theme paints its canvas, so a colored snapshot carries the
        // truecolor background escape. This is what makes the snapshot look the
        // same on a light terminal.
        let out = render_to_string(&demo_app(), 100, 30, true).unwrap();
        assert!(out.contains("\x1b[48;2;13;17;23m"));
    }

    #[test]
    fn terminal_theme_snapshot_has_no_background_fill() {
        let mut app = demo_app();
        app.set_theme(crate::theme::Theme::Terminal);
        let out = render_to_string(&app, 100, 30, true).unwrap();
        assert!(!out.contains("\x1b[48;2;"));
        assert!(out.contains("LIVE CREATIVE"));
    }
}
