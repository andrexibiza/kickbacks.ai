//! kickbacks-kit (`kb`): read-only companion tools for the kickbacks.ai
//! extension. Archive every ad you are shown and watch your stats in a TUI.
//!
//! Design principle: this crate only ever OBSERVES local artifacts the
//! extension already writes. It never posts an impression, click, or any other
//! billing event, and never talks to the kickbacks.ai backend. It records the
//! history the extension throws away — nothing more.

mod app;
mod archive;
mod capture;
mod chart;
mod config;
mod developer_note;
mod doctor;
mod export;
mod install_claude;
mod install_system;
mod integrations;
mod model;
mod paths;
mod render;
mod setup;
mod snapshot;
mod sources;
mod status;
mod statusline;
/// Test-only: renders a buffer to SVG for the README hero image.
#[cfg(test)]
mod svg;
mod sync_health;
mod theme;
mod top;
mod trust_engine;
mod util;
mod watch;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use crossterm::style::Stylize;
use std::path::PathBuf;

use archive::Archive;

#[derive(Parser)]
#[command(
    version,
    about = "Read-only companion tools for the kickbacks.ai extension",
    long_about = "kickbacks-kit observes the ads the kickbacks.ai extension shows you and \
                  keeps the history it discards: a searchable ad archive and a live TUI \
                  dashboard. It is strictly read-only and never reports a billing event."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Live TUI dashboard (captures while open)
    Top {
        /// Dev-only: render sample data for screenshots (no capture, no writes)
        #[arg(long, hide = true)]
        demo: bool,
        /// Color theme: auto (detect), dark, light, or terminal (use terminal colors)
        #[arg(long, value_enum)]
        theme: Option<theme::Theme>,
        /// Activity chart style: heat (calendar strip) or bars
        #[arg(long, value_enum)]
        chart_style: Option<chart::ChartStyle>,
    },
    /// Headless capture daemon: poll local artifacts into the archive
    Watch {
        /// Seconds between polls
        #[arg(long, default_value_t = 3)]
        interval: u64,
        /// Run a single pass and exit
        #[arg(long)]
        once: bool,
    },
    /// Inspect the local ad corpus
    Archive {
        #[command(subcommand)]
        command: ArchiveCommand,
    },
    /// Export the corpus as JSONL or CSV
    Export {
        /// Output format
        #[arg(long, value_enum, default_value_t = export::Format::Jsonl)]
        format: export::Format,
        /// Output file (default: stdout)
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// One-shot dashboard render to stdout (for slash commands and scripts)
    Snapshot {
        /// Output width in columns (default: terminal width, clamped 80..=140)
        #[arg(long)]
        width: Option<u16>,
        /// Disable colors even on a terminal
        #[arg(long)]
        plain: bool,
        /// Color theme: auto (detect), dark, light, or terminal (use terminal colors)
        #[arg(long, value_enum)]
        theme: Option<theme::Theme>,
        /// Activity chart style: heat (calendar strip) or bars
        #[arg(long, value_enum)]
        chart_style: Option<chart::ChartStyle>,
    },
    /// One-line status for a CLI status bar: the current ad plus kb stats
    Statusline {
        /// Maximum visible columns (default: $COLUMNS or 120)
        #[arg(long)]
        width: Option<u16>,
        /// Disable colors and the ad hyperlink
        #[arg(long)]
        plain: bool,
    },
    /// Show whether ads are flowing right now, and why (killswitch, idle, etc.)
    Status,
    /// Dark local desktop console and API
    App {
        /// Host to bind
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Port to bind
        #[arg(long, default_value_t = app::DEFAULT_PORT)]
        port: u16,
        /// Do not open the dashboard in the default browser
        #[arg(long)]
        no_open: bool,
    },
    /// Print one local app API payload as JSON
    Api {
        /// Endpoint path, for example health, archive, install/status
        endpoint: String,
    },
    /// Account auth helper
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    /// Ledger freshness monitor and account-ledger watermark commands
    Sync {
        #[command(subcommand)]
        command: SyncCommand,
    },
    /// Two-way trust ledger for users, advertisers, caps, holds, and bot risk
    Trust {
        /// Emit JSON
        #[arg(long)]
        json: bool,
    },
    /// Plug-and-play installer for supported surfaces
    Install(InstallArgs),
    /// Re-apply marker-owned integrations
    Repair(InstallArgs),
    /// Restore guidance for marker-owned integrations
    Restore,
    /// Launch Claude Code through the Kickbacks wrapper
    Claude {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Launch Codex through the Kickbacks wrapper
    Codex {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Launch Hermes TUI through the Kickbacks wrapper
    Hermes {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Print the founder-friendly contribution note
    DeveloperNote {
        /// Emit JSON
        #[arg(long)]
        json: bool,
    },
    /// First-run setup: create the archive and capture once
    Setup,
    /// Check local data sources and the archive
    Doctor,
    /// Wire kb into Claude Code: /kbtop, /kbstatus, and the statusLine
    InstallClaude {
        /// Answer yes to all prompts
        #[arg(long)]
        yes: bool,
    },
    /// Undo install-claude: remove the commands, restore the old statusLine
    UninstallClaude {
        /// Answer yes to all prompts
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Args, Clone)]
struct InstallArgs {
    /// Install every supported surface
    #[arg(long)]
    all: bool,
    /// Install/update the VS Code extension
    #[arg(long)]
    vscode: bool,
    /// Configure Claude Code CLI
    #[arg(long, alias = "claude-code")]
    claude_cli: bool,
    /// Configure Codex CLI wrapper/skill
    #[arg(long, alias = "codex")]
    codex_cli: bool,
    /// Configure Hermes Agent/TUI
    #[arg(long)]
    hermes: bool,
    /// Install Claude/Codex/Hermes skills
    #[arg(long)]
    skills: bool,
    /// Answer yes to prompts where possible
    #[arg(long)]
    yes: bool,
}

#[derive(Subcommand)]
enum AuthCommand {
    /// Show local auth presence without printing secrets
    Status,
    /// Open Kickbacks sign-in in the browser
    SignIn,
    /// Explain how to sign out safely
    SignOut,
}

#[derive(Subcommand)]
enum SyncCommand {
    /// Show the ledger freshness monitor
    Status {
        /// Emit JSON
        #[arg(long)]
        json: bool,
    },
    /// Set the last known account-ledger sync watermark
    Mark {
        /// Time as epoch millis, RFC3339, or YYYY-MM-DD HH:mm
        #[arg(long)]
        at: String,
    },
    /// Clear the account-ledger sync watermark
    Clear,
}

#[derive(Subcommand)]
enum ArchiveCommand {
    /// List captured ads, most recent first
    List {
        #[arg(long, default_value_t = 40)]
        limit: usize,
    },
    /// Summary statistics
    Stats,
    /// Advertiser leaderboard
    Top {
        #[arg(long, default_value_t = 15)]
        limit: usize,
    },
}

fn main() -> Result<()> {
    // Piped output (slash commands, scripts) should be plain text, not ANSI.
    if !std::io::IsTerminal::is_terminal(&std::io::stdout()) {
        crossterm::style::force_color_output(false);
    }
    let cli = Cli::parse();
    match cli.command {
        Command::Top {
            demo,
            theme,
            chart_style,
        } => {
            if demo {
                top::run_demo(theme, chart_style)
            } else {
                top::run(theme, chart_style)
            }
        }
        Command::Watch { interval, once } => watch::run(interval, once),
        Command::Archive { command } => run_archive(command),
        Command::Export { format, out } => export::run(format, out),
        Command::Snapshot {
            width,
            plain,
            theme,
            chart_style,
        } => snapshot::run(width, plain, theme, chart_style),
        Command::Statusline { width, plain } => statusline::run(width, plain),
        Command::Status => status::run(),
        Command::App {
            host,
            port,
            no_open,
        } => app::run(host, port, !no_open),
        Command::Api { endpoint } => app::print_api(&endpoint),
        Command::Auth { command } => run_auth(command),
        Command::Sync { command } => run_sync(command),
        Command::Trust { json } => run_trust(json),
        Command::Install(args) => install_system::install(to_selection(args)),
        Command::Repair(args) => install_system::repair(to_selection(args)),
        Command::Restore => install_system::restore(),
        Command::Claude { args } => integrations::run_wrapped("claude", &[], &args),
        Command::Codex { args } => integrations::run_wrapped("codex", &[], &args),
        Command::Hermes { args } => integrations::run_wrapped("hermes", &["--tui"], &args),
        Command::DeveloperNote { json } => print_developer_note(json),
        Command::Setup => setup::run(),
        Command::Doctor => doctor::run(),
        Command::InstallClaude { yes } => install_claude::install(yes),
        Command::UninstallClaude { yes } => install_claude::uninstall(yes),
    }
}

fn to_selection(args: InstallArgs) -> install_system::InstallSelection {
    install_system::InstallSelection {
        all: args.all,
        vscode: args.vscode,
        claude_cli: args.claude_cli,
        codex_cli: args.codex_cli,
        hermes: args.hermes,
        skills: args.skills,
        yes: args.yes,
    }
}

fn run_auth(command: AuthCommand) -> Result<()> {
    match command {
        AuthCommand::Status => {
            println!("{}", integrations::auth_status()?);
            Ok(())
        }
        AuthCommand::SignIn => {
            println!("Open https://kickbacks.ai and sign in through the official flow.");
            println!("The desktop app never asks you to paste tokens.");
            Ok(())
        }
        AuthCommand::SignOut => {
            println!("Use the official Kickbacks extension sign-out command or revoke the session at Kickbacks.ai.");
            println!(
                "This tool will not delete credential files unless you explicitly remove them."
            );
            Ok(())
        }
    }
}

fn run_sync(command: SyncCommand) -> Result<()> {
    match command {
        SyncCommand::Status { json } => {
            let archive = Archive::open(&paths::db_path()?)?;
            let health = sync_health::current(&archive)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&health)?);
                return Ok(());
            }
            println!("{}", "kickbacks-kit - ledger freshness monitor".bold());
            println!();
            println!("  {:<24}{}", "status".dim(), health.label.bold());
            println!("  {:<24}{}", "message".dim(), health.message);
            println!(
                "  {:<24}{}",
                "account ledger sync".dim(),
                fmt_optional_time(health.account_ledger_last_synced_ms)
            );
            println!(
                "  {:<24}{}",
                "last metric send".dim(),
                fmt_optional_time(health.last_metric_send_ms)
            );
            println!(
                "  {:<24}{}",
                "events after ledger".dim(),
                health.local_events_after_account_sync
            );
            println!(
                "  {:<24}{}",
                "payment transport".dim(),
                health.payment_transport_status
            );
            println!(
                "  {:<24}{}",
                "auth failure".dim(),
                fmt_optional_time(health.last_auth_failure_ms)
            );
            println!(
                "  {:<24}{}",
                "metric failure".dim(),
                fmt_optional_time(health.last_metric_failure_ms)
            );
            Ok(())
        }
        SyncCommand::Mark { at } => {
            let at_ms = sync_health::parse_account_time(&at)?;
            let mut archive = Archive::open(&paths::db_path()?)?;
            sync_health::mark_account_synced(&mut archive, at_ms)?;
            println!(
                "account ledger watermark set to {}",
                util::fmt_datetime(at_ms)
            );
            Ok(())
        }
        SyncCommand::Clear => {
            let mut archive = Archive::open(&paths::db_path()?)?;
            sync_health::clear_account_synced(&mut archive)?;
            println!("account ledger watermark cleared");
            Ok(())
        }
    }
}

fn fmt_optional_time(ms: Option<i64>) -> String {
    ms.map(util::fmt_datetime)
        .unwrap_or_else(|| "unknown".to_string())
}

fn run_trust(as_json: bool) -> Result<()> {
    let archive = Archive::open(&paths::db_path()?)?;
    let trust = trust_engine::current(&archive)?;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&trust)?);
        return Ok(());
    }

    println!("{}", trust.title.bold());
    println!();
    println!("{}", trust.pitch);
    println!();
    println!(
        "  {:<24}{} / {}",
        "user risk".dim(),
        trust.user_risk_score,
        trust.user_risk_band
    );
    println!(
        "  {:<24}{} / {}",
        "surface risk".dim(),
        trust.surface_risk_score,
        trust.surface_risk_band
    );
    println!(
        "  {:<24}{} ({})",
        "suspicious queue".dim(),
        trust.suspicious_event_queue.count,
        trust.suspicious_event_queue.severity
    );
    println!(
        "  {:<24}{} ({})",
        "payout hold queue".dim(),
        trust.payout_hold_queue.count,
        trust.payout_hold_queue.severity
    );
    println!(
        "  {:<24}{}",
        "probe mode".dim(),
        if trust.non_earning_probe_mode.enabled {
            "enabled"
        } else {
            "off"
        }
    );
    println!();
    println!("{}", "Event states".bold());
    for bucket in &trust.earning_eligibility_state {
        let count = bucket
            .count
            .map(|n| n.to_string())
            .unwrap_or_else(|| "backend".to_string());
        println!(
            "  {:<24}{:<10}{}",
            bucket.state, count, bucket.payout_impact
        );
    }
    Ok(())
}

fn print_developer_note(as_json: bool) -> Result<()> {
    let note = developer_note::note();
    if as_json {
        println!("{}", serde_json::to_string_pretty(&note)?);
        return Ok(());
    }
    println!("{}", note.title.bold());
    println!();
    println!("{}", note.summary);
    println!();
    println!("{}", note.availability.bold());
    println!();
    println!("Principles:");
    for principle in note.principles {
        println!("  - {principle}");
    }
    Ok(())
}

fn run_archive(command: ArchiveCommand) -> Result<()> {
    let archive = Archive::open(&paths::db_path()?)?;
    match command {
        ArchiveCommand::List { limit } => print_list(&archive, limit),
        ArchiveCommand::Stats => print_stats(&archive),
        ArchiveCommand::Top { limit } => print_leaderboard(&archive, limit),
    }
}

fn print_list(archive: &Archive, limit: usize) -> Result<()> {
    let ads = archive.list_ads(limit)?;
    if ads.is_empty() {
        println!("{}", "no ads captured yet — run `kb setup`".dim());
        return Ok(());
    }
    println!(
        "{:<18}  {:>5}  {:<16}  {}",
        "last seen".bold(),
        "seen".bold(),
        "advertiser".bold(),
        "ad".bold()
    );
    for ad in &ads {
        println!(
            "{:<18}  {:>5}  {:<16}  {}",
            util::fmt_datetime(ad.last_seen_ms),
            ad.times_seen,
            util::truncate(&ad.advertiser, 16),
            util::truncate(&ad.ad_text, 52),
        );
    }
    Ok(())
}

fn print_stats(archive: &Archive) -> Result<()> {
    let s = archive.stats(util::now_ms())?;
    let row = |label: &str, value: String| {
        println!("  {:<14}{}", label.dim(), value.to_string().bold());
    };
    println!("{}", "kickbacks-kit · archive stats".bold());
    println!();
    row("ads seen", s.distinct_ads.to_string());
    row("advertisers", s.advertisers.to_string());
    row("sightings", s.total_sightings.to_string());
    row("today", s.sightings_today.to_string());
    row("this week", s.sightings_week.to_string());
    if let (Some(first), Some(last)) = (s.first_seen_ms, s.last_seen_ms) {
        row("first seen", util::fmt_datetime(first));
        row("last seen", util::fmt_datetime(last));
    }
    Ok(())
}

fn print_leaderboard(archive: &Archive, limit: usize) -> Result<()> {
    let board = archive.advertiser_leaderboard(limit)?;
    if board.is_empty() {
        println!("{}", "no ads captured yet — run `kb setup`".dim());
        return Ok(());
    }
    println!(
        "{:>3}  {:<22}  {:>4}  {:>5}",
        "#".bold(),
        "advertiser".bold(),
        "ads".bold(),
        "seen".bold()
    );
    for (i, a) in board.iter().enumerate() {
        println!(
            "{:>3}  {:<22}  {:>4}  {:>5}",
            i + 1,
            util::truncate(&a.advertiser, 22),
            a.distinct_ads,
            a.sightings,
        );
    }
    Ok(())
}
