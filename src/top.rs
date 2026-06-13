//! `kb top` — the live, interactive dashboard. The actual drawing lives in
//! [`crate::render`]; this module owns only the terminal lifecycle and the
//! event loop. It refreshes once a second and captures on every tick, so
//! simply leaving it open grows your archive.
//!
//! Theme handling lives here too: `t` opens a picker overlay, the arrow keys
//! preview each theme live, Enter saves the choice to the config, and Esc
//! reverts. The initial theme comes from the `--theme` flag, else the saved
//! config (which defaults to auto-detect).

use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::DefaultTerminal;

use crate::archive::Archive;
use crate::capture::capture_pass;
use crate::chart::ChartStyle;
use crate::config::{self, Config};
use crate::paths;
use crate::render::{demo_app, ui, App, ThemePicker};
use crate::theme::Theme;

/// Entry point: set up the terminal, run the loop, and always restore on exit.
/// `theme_arg`/`chart_arg` are the flags; when absent the saved config decides.
pub fn run(theme_arg: Option<Theme>, chart_arg: Option<ChartStyle>) -> Result<()> {
    let mut archive = Archive::open(&paths::db_path()?)?;
    let cfg = config::load();
    let theme = theme_arg.unwrap_or(cfg.theme);
    let chart = chart_arg.unwrap_or(cfg.chart_style);
    let mut terminal = ratatui::init();
    let result = run_loop(&mut terminal, &mut archive, theme, chart);
    ratatui::restore();
    result
}

/// Render the dashboard with built-in sample data, so the layout can be seen
/// without waiting for real ads. Touches no archive and writes nothing, so the
/// theme picker here previews but never persists.
pub fn run_demo(theme_arg: Option<Theme>, chart_arg: Option<ChartStyle>) -> Result<()> {
    let mut app = demo_app();
    app.set_theme(theme_arg.unwrap_or(Theme::Dark));
    if let Some(chart) = chart_arg {
        app.chart_style = chart;
    }
    let mut terminal = ratatui::init();
    let result = (|| -> Result<()> {
        loop {
            terminal.draw(|frame| ui(frame, &app))?;
            if event::poll(Duration::from_millis(200))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind == KeyEventKind::Press && handle_key(&mut app, key, false) {
                        break;
                    }
                }
            }
        }
        Ok(())
    })();
    ratatui::restore();
    result
}

fn run_loop(
    terminal: &mut DefaultTerminal,
    archive: &mut Archive,
    theme: Theme,
    chart: ChartStyle,
) -> Result<()> {
    let mut app = App::default();
    app.set_theme(theme);
    app.chart_style = chart;
    capture_pass(archive)?;
    app.refresh(archive)?;
    let mut last_tick = Instant::now();

    loop {
        terminal.draw(|frame| ui(frame, &app))?;

        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    if handle_key(&mut app, key, true) {
                        break;
                    }
                    // `r` outside the picker forces an immediate refresh.
                    if app.picker.is_none() && key.code == KeyCode::Char('r') {
                        capture_pass(archive)?;
                        app.refresh(archive)?;
                    }
                }
            }
        }

        if last_tick.elapsed() >= Duration::from_secs(1) {
            capture_pass(archive)?;
            app.refresh(archive)?;
            last_tick = Instant::now();
        }
    }
    Ok(())
}

/// Handle one key press. Returns `true` when the app should quit. `persist`
/// controls whether confirming a theme writes it to the config (off for the
/// no-write demo). Refresh (`r`) is handled by the caller, which owns the
/// archive.
fn handle_key(app: &mut App, key: event::KeyEvent, persist: bool) -> bool {
    let ctrl_c = key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
    if ctrl_c {
        return true;
    }

    if app.picker.is_some() {
        handle_picker(app, key.code, persist);
        return false;
    }

    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => return true,
        KeyCode::Char('t') => app.picker = Some(ThemePicker::open(app.theme)),
        KeyCode::Char('c') => {
            app.chart_style = app.chart_style.next();
            if persist {
                let _ = config::save(&Config {
                    theme: app.theme,
                    chart_style: app.chart_style,
                });
            }
        }
        _ => {}
    }
    false
}

/// Drive the open theme picker. Arrow keys (or j/k) move the cursor and preview
/// the theme live; Enter commits (and saves when `persist`); Esc or q reverts.
fn handle_picker(app: &mut App, code: KeyCode, persist: bool) {
    match code {
        KeyCode::Up | KeyCode::Char('k') => {
            if let Some(p) = app.picker.as_mut() {
                p.up();
            }
            preview_selected(app);
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if let Some(p) = app.picker.as_mut() {
                p.down();
            }
            preview_selected(app);
        }
        KeyCode::Enter => {
            if let Some(theme) = app.picker.as_ref().map(ThemePicker::selected) {
                app.set_theme(theme);
                if persist {
                    let _ = config::save(&Config {
                        theme,
                        chart_style: app.chart_style,
                    });
                }
            }
            app.picker = None;
        }
        KeyCode::Esc | KeyCode::Char('q') => {
            if let Some(theme) = app.picker.as_ref().map(|p| p.original) {
                app.set_theme(theme);
            }
            app.picker = None;
        }
        _ => {}
    }
}

/// Apply the theme currently under the picker cursor, so the dashboard behind
/// the overlay updates as the user navigates.
fn preview_selected(app: &mut App) {
    if let Some(theme) = app.picker.as_ref().map(ThemePicker::selected) {
        app.set_theme(theme);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::App;

    fn press(code: KeyCode) -> event::KeyEvent {
        event::KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn t_opens_and_esc_reverts_theme() {
        let mut app = App::default();
        app.set_theme(Theme::Dark);
        assert!(!handle_key(&mut app, press(KeyCode::Char('t')), false));
        assert!(app.picker.is_some());

        // Preview light, then cancel: theme returns to dark.
        handle_picker(&mut app, KeyCode::Down, false); // dark -> light (auto,dark,light,..)
        assert_eq!(app.theme, Theme::Light);
        handle_picker(&mut app, KeyCode::Esc, false);
        assert!(app.picker.is_none());
        assert_eq!(app.theme, Theme::Dark);
    }

    #[test]
    fn enter_commits_previewed_theme() {
        let mut app = App::default();
        app.set_theme(Theme::Auto); // cursor 0
        app.picker = Some(ThemePicker::open(app.theme));
        handle_picker(&mut app, KeyCode::Down, false); // -> dark
        handle_picker(&mut app, KeyCode::Enter, false); // no persist in test
        assert!(app.picker.is_none());
        assert_eq!(app.theme, Theme::Dark);
    }

    #[test]
    fn ctrl_c_quits_even_in_picker() {
        let mut app = App {
            picker: Some(ThemePicker::open(Theme::Dark)),
            ..Default::default()
        };
        let ctrl_c = event::KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert!(handle_key(&mut app, ctrl_c, false));
    }

    #[test]
    fn c_cycles_chart_style() {
        let mut app = App::default();
        assert_eq!(app.chart_style, ChartStyle::Heat);
        assert!(!handle_key(&mut app, press(KeyCode::Char('c')), false));
        assert_eq!(app.chart_style, ChartStyle::Bars);
        handle_key(&mut app, press(KeyCode::Char('c')), false);
        assert_eq!(app.chart_style, ChartStyle::Heat);
    }

    #[test]
    fn q_quits_outside_picker_but_closes_inside() {
        let mut app = App::default();
        app.set_theme(Theme::Dark);
        // Inside the picker, q cancels rather than quitting.
        app.picker = Some(ThemePicker::open(Theme::Dark));
        assert!(!handle_key(&mut app, press(KeyCode::Char('q')), false));
        assert!(app.picker.is_none());
        // Outside the picker, q quits.
        assert!(handle_key(&mut app, press(KeyCode::Char('q')), false));
    }
}
