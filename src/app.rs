use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::archive::Archive;
use crate::{developer_note, integrations, paths, sync_health, trust_engine, util};

pub const DEFAULT_PORT: u16 = 38241;

#[derive(Debug, Serialize)]
struct ArchivePayload {
    stats: crate::archive::Stats,
    leaderboard: Vec<crate::archive::AdvertiserStat>,
    recent: Vec<crate::archive::LedgerEvent>,
    activity: Vec<Option<u64>>,
}

pub fn run(host: String, port: u16, open: bool) -> Result<()> {
    let listener = TcpListener::bind((host.as_str(), port))
        .with_context(|| format!("binding http://{host}:{port}"))?;
    let url = format!("http://{host}:{port}");
    println!("kickbacks desktop console listening on {url}");
    println!("ledger freshness monitor: {url}/api/health");
    if open {
        open_url(&url);
    }
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(|| {
                    if let Err(err) = handle(stream) {
                        eprintln!("request failed: {err:#}");
                    }
                });
            }
            Err(err) => eprintln!("connection failed: {err}"),
        }
    }
    Ok(())
}

pub fn print_api(path: &str) -> Result<()> {
    let value = api_payload(path)?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn handle(mut stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf)?;
    if n == 0 {
        return Ok(());
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let line = req.lines().next().unwrap_or_default();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "POST" {
        return write_response(&mut stream, 405, "text/plain", b"method not allowed");
    }
    let path = target.split('?').next().unwrap_or("/");
    match path {
        "/" | "/index.html" => write_response(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            INDEX_HTML.as_bytes(),
        ),
        "/styles.css" => write_response(
            &mut stream,
            200,
            "text/css; charset=utf-8",
            STYLES.as_bytes(),
        ),
        "/app.js" => write_response(
            &mut stream,
            200,
            "application/javascript; charset=utf-8",
            SCRIPT.as_bytes(),
        ),
        path if path.starts_with("/api/") => {
            let value = api_payload(path.trim_start_matches("/api/"))?;
            let body = serde_json::to_vec_pretty(&value)?;
            write_response(&mut stream, 200, "application/json; charset=utf-8", &body)
        }
        _ => write_response(&mut stream, 404, "text/plain", b"not found"),
    }
}

fn api_payload(path: &str) -> Result<serde_json::Value> {
    let path = path.trim_matches('/');
    match path {
        "health" => {
            let archive = Archive::open(&paths::db_path()?)?;
            Ok(json!({
                "ok": true,
                "now_ms": util::now_ms(),
                "sync": sync_health::current(&archive)?,
                "system": integrations::system_status()?,
                "developer_note": developer_note::note(),
            }))
        }
        "account" => {
            let archive = Archive::open(&paths::db_path()?)?;
            Ok(json!({
                "auth": integrations::auth_status()?,
                "sync": sync_health::current(&archive)?,
                "paths": integrations::app_data_paths()?,
            }))
        }
        "earnings" => {
            let archive = Archive::open(&paths::db_path()?)?;
            let stats = archive.stats(util::now_ms())?;
            Ok(json!({
                "source": "local_archive_plus_account_sync_monitor",
                "note": "Actual account earnings are backend-owned. This local app does not invent balances.",
                "portfolio_url": crate::render::PORTFOLIO_URL,
                "stats": stats,
                "sync": sync_health::current(&archive)?,
            }))
        }
        "archive" => {
            let archive = Archive::open(&paths::db_path()?)?;
            let payload = ArchivePayload {
                stats: archive.stats(util::now_ms())?,
                leaderboard: archive.advertiser_leaderboard(10)?,
                recent: archive.recent_ledger(20)?,
                activity: archive.hourly_activity(util::now_ms(), 24)?,
            };
            Ok(serde_json::to_value(payload)?)
        }
        "trust" => {
            let archive = Archive::open(&paths::db_path()?)?;
            Ok(serde_json::to_value(trust_engine::current(&archive)?)?)
        }
        "apps" | "cli" => Ok(json!({ "integrations": integrations::integrations()? })),
        "skills" => Ok(json!({ "skills": integrations::skills()? })),
        "hermes" => {
            let system = integrations::system_status()?;
            Ok(json!({
                "integration": system.integrations.into_iter().find(|i| i.id == "hermes"),
                "skills": system.skills.into_iter().filter(|s| s.id == "hermes").collect::<Vec<_>>(),
            }))
        }
        "install/status" => Ok(serde_json::to_value(integrations::system_status()?)?),
        "install/enable" | "install/repair" => Ok(json!({
            "ok": true,
            "safe_action": "Run the CLI installer from a trusted terminal.",
            "commands": [
                "kickbacks install --all --yes",
                "kickbacks repair --all --yes"
            ]
        })),
        "stripe" => Ok(serde_json::to_value(integrations::stripe_status())?),
        "developer-note" | "note-to-developer" => Ok(serde_json::to_value(developer_note::note())?),
        _ => Ok(json!({ "error": "unknown endpoint", "path": path })),
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<()> {
    let status_text = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    Ok(())
}

fn open_url(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

const INDEX_HTML: &str = r###"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kickbacks.ai Revenue Console</title>
  <link rel="stylesheet" href="/styles.css">
  <script>
    if (location.hash.includes('figmacapture=')) {
      const figmaCapture = document.createElement('script');
      figmaCapture.src = 'https://mcp.figma.com/mcp/html-to-design/capture.js';
      figmaCapture.async = true;
      document.head.appendChild(figmaCapture);
    }
  </script>
</head>
<body>
  <aside class="rail">
    <div class="brand"><span class="mark">K$</span><strong>Kickbacks.ai</strong></div>
    <nav>
      <a class="active" href="#dashboard">Dashboard</a>
      <a href="#sync">Sync Monitor</a>
      <a href="#trust">Trust Engine</a>
      <a href="#surfaces">Surfaces</a>
      <a href="#stripe">Stripe</a>
      <a href="#developer-note">Founder Note</a>
    </nav>
    <section class="system-mini">
      <div class="mini-row"><span>Local API</span><strong>Healthy</strong></div>
      <div class="mini-row"><span>Theme</span><strong>Dark only</strong></div>
      <div class="mini-row"><span>Integrity</span><strong>Read-only</strong></div>
    </section>
  </aside>
  <main>
    <header class="topbar">
      <div>
        <span class="overline">Kickbacks.ai command center</span>
        <h1>Earning trust console</h1>
      </div>
      <div class="top-status">
        <span id="sync-pill" class="pill">Loading sync</span>
        <span class="pill">No light mode</span>
      </div>
    </header>

    <section id="sync" class="incident panel">
      <div>
        <span class="overline">Ledger freshness monitor</span>
        <h2 id="sync-title">Checking account ledger freshness</h2>
        <p id="sync-message">Reading local adapter sends, auth health, and visible account watermark.</p>
      </div>
      <div class="incident-grid">
        <div><span>Last local metric</span><strong id="last-metric">--</strong></div>
        <div><span>Account ledger sync</span><strong id="account-sync">--</strong></div>
        <div><span>Events after ledger</span><strong id="events-after">--</strong></div>
        <div><span>Auth failure</span><strong id="auth-failure">--</strong></div>
        <div><span>Payment transport</span><strong id="transport-status">Backend-owned</strong></div>
      </div>
    </section>

    <section id="dashboard" class="kpis">
      <article class="panel kpi"><span>Local sightings</span><strong id="sightings">--</strong><small>Observed locally</small></article>
      <article class="panel kpi"><span>Advertisers</span><strong id="advertisers">--</strong><small>Unique brands</small></article>
      <article class="panel kpi"><span>Ads seen</span><strong id="ads-seen">--</strong><small>Distinct creatives</small></article>
      <article class="panel kpi"><span>Stripe readiness</span><strong id="stripe-ready">Backend-owned</strong><small>Connect v2 contract</small></article>
    </section>

    <section id="trust" class="trust panel">
      <div class="section-head"><div><span class="overline">Trust Engine</span><h2>Settlement state machine</h2></div><button data-command="kickbacks trust">Open report</button></div>
      <p id="trust-pitch">Loading two-way trust ledger.</p>
      <div class="trust-grid">
        <div><span>User risk</span><strong id="user-risk">--</strong><small id="user-risk-band">--</small></div>
        <div><span>Surface risk</span><strong id="surface-risk">--</strong><small id="surface-risk-band">--</small></div>
        <div><span>Suspicious queue</span><strong id="suspicious-queue">--</strong><small id="suspicious-reason">--</small></div>
        <div><span>Payout holds</span><strong id="payout-holds">--</strong><small id="payout-reason">--</small></div>
      </div>
      <div class="trust-columns">
        <div>
          <span class="overline">Eligibility states</span>
          <div id="eligibility" class="table trust-table"></div>
        </div>
        <div>
          <span class="overline">Advertiser proof</span>
          <div id="advertiser-proof" class="proof"></div>
        </div>
      </div>
      <details class="disclosure">
        <summary>Review finality gates, assurance, and model signals</summary>
        <div class="trust-columns trust-bottom">
          <div>
            <span class="overline">Finality gates</span>
            <div id="finality-gates" class="table trust-table"></div>
          </div>
          <div>
            <span class="overline">Advertiser assurance</span>
            <div id="assurance-proof" class="proof"></div>
          </div>
        </div>
        <div class="trust-columns trust-bottom">
          <div>
            <span class="overline">ML signal layer</span>
            <div id="ml-layer" class="proof"></div>
          </div>
          <div>
            <span class="overline">Reason-code candidates</span>
            <div id="ml-reason-codes" class="proof code-list"></div>
          </div>
        </div>
      </details>
    </section>

    <section class="grid">
      <article class="panel wide">
        <div class="section-head"><div><span class="overline">Local activity</span><h2>Last 24 hours</h2></div><button data-command="kickbacks sync status">Sync status</button></div>
        <div id="bars" class="bars"></div>
      </article>
      <article id="surfaces" class="panel">
        <div class="section-head"><div><span class="overline">Surfaces</span><h2>Installs</h2></div><button data-command="kickbacks install --all --yes">Install all</button></div>
        <div id="integrations" class="list"></div>
      </article>
    </section>

    <section class="grid">
      <article class="panel">
        <div class="section-head"><div><span class="overline">Market pulse</span><h2>Advertiser mix</h2></div></div>
        <div id="leaderboard" class="table"></div>
      </article>
      <article class="panel">
        <div class="section-head"><div><span class="overline">Local ledger</span><h2>Recent events</h2></div></div>
        <div id="ledger" class="table"></div>
      </article>
    </section>

    <section id="stripe" class="panel">
      <div class="section-head"><div><span class="overline">Stripe Connect</span><h2>Real-world payout contract</h2></div></div>
      <p id="stripe-note"></p>
      <div class="stripe-grid">
        <div><span>API version</span><strong id="stripe-api">--</strong></div>
        <div><span>Account API</span><strong id="stripe-account">--</strong></div>
        <div><span>Dashboard</span><strong id="stripe-dashboard">--</strong></div>
      </div>
    </section>

    <section id="developer-note" class="panel note">
      <span class="overline">Founder note</span>
      <div class="note-layout">
        <div>
          <h2 id="note-title">A contribution-shaped product expansion</h2>
          <p id="note-summary" class="note-lede"></p>
          <p id="note-trust" class="trust-pitch"></p>
          <p id="note-availability" class="availability"></p>
        </div>
        <div class="note-message">
          <span class="overline">Message draft</span>
          <p id="note-outreach" class="outreach"></p>
        </div>
      </div>
      <p id="note-payout-review" class="payout-note"></p>
      <details class="disclosure note-disclosure">
        <summary>Implementation guardrails and technical appendix</summary>
        <div class="note-guardrails">
          <span class="overline">Implementation guardrails</span>
          <ul id="note-principles"></ul>
        </div>
        <div class="note-columns">
          <div>
            <span class="overline">Technical appendix</span>
            <ul id="note-architecture"></ul>
          </div>
          <div>
            <span class="overline">ML plan</span>
            <ul id="note-ml"></ul>
          </div>
        </div>
      </details>
    </section>
  </main>
  <div id="command-toast" class="toast" hidden></div>
  <script src="/app.js"></script>
</body>
</html>
"###;

const STYLES: &str = r###"
:root {
  color-scheme: dark;
  --bg: #06090a;
  --rail: #050708;
  --panel: #0b1113;
  --panel-2: #0e171a;
  --line: #1b282c;
  --soft-line: rgba(137, 164, 172, .12);
  --text: #edf7f5;
  --muted: #8fa2a3;
  --quiet: #5f7475;
  --mint: #7ee6b8;
  --cyan: #8ac7d8;
  --amber: #d6a451;
  --red: #e66a7a;
  --magenta: #c489d9;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px),
    linear-gradient(180deg, rgba(126,230,184,.045), transparent 28rem),
    var(--bg);
  background-size: 96px 96px, auto, auto;
  color: var(--text);
  font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
}
.rail {
  position: fixed; inset: 0 auto 0 0; width: 238px;
  border-right: 1px solid var(--soft-line);
  background: rgba(5, 7, 8, .96);
  padding: 24px 18px;
}
.brand { display: flex; align-items: center; gap: 12px; color: var(--text); font-size: 15px; }
.mark { border: 1px solid rgba(126,230,184,.5); border-radius: 6px; padding: 4px 6px; color: var(--mint); background: rgba(126,230,184,.08); }
nav { display: grid; gap: 2px; margin-top: 36px; }
nav a { color: var(--quiet); text-decoration: none; padding: 10px 0 10px 12px; border-left: 1px solid transparent; }
nav a.active, nav a:hover { color: var(--text); border-left-color: var(--mint); background: transparent; }
.system-mini { position: absolute; left: 18px; right: 18px; bottom: 22px; border-top: 1px solid var(--soft-line); padding-top: 12px; color: var(--quiet); }
.mini-row, .row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid rgba(136,164,180,.12); }
.mini-row:last-child, .row:last-child { border-bottom: 0; }
.mini-row strong { color: var(--text); font-weight: 600; }
main { margin-left: 238px; padding: 26px 30px 52px; max-width: 1220px; }
.topbar { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
h1, h2 { margin: 0; letter-spacing: 0; line-height: 1.1; }
h1 { font-size: 30px; font-weight: 650; }
h2 { font-size: 18px; font-weight: 650; }
.overline { color: var(--quiet); text-transform: uppercase; letter-spacing: .12em; font: 700 10px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; }
.top-status { display: flex; gap: 10px; align-items: center; }
.pill { border: 1px solid var(--soft-line); border-radius: 999px; padding: 7px 10px; color: var(--muted); background: rgba(14,23,26,.62); font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.pill.ok { color: var(--mint); border-color: rgba(126,230,184,.32); }
.pill.warning { color: var(--amber); border-color: rgba(214,164,81,.36); }
.pill.critical { color: var(--red); border-color: rgba(230,106,122,.42); }
.panel {
  border: 1px solid var(--soft-line);
  border-radius: 8px;
  background: rgba(11, 17, 19, .82);
  box-shadow: none;
  padding: 20px;
}
.incident { display: grid; grid-template-columns: 1.1fr 1fr; gap: 20px; margin-bottom: 16px; border-color: rgba(214,164,81,.28); background: rgba(14, 15, 13, .72); }
.incident.critical { border-color: rgba(230,106,122,.46); }
.incident p, .note p, #stripe-note { color: var(--muted); max-width: 920px; }
.incident-grid, .stripe-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.incident-grid div, .stripe-grid div { border-top: 1px solid var(--soft-line); padding: 10px 0 0; background: transparent; }
.incident-grid span, .stripe-grid span, .kpi span { display: block; color: var(--muted); font-size: 12px; }
.incident-grid strong, .stripe-grid strong { display: block; margin-top: 6px; font: 700 13px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); overflow-wrap: anywhere; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.kpi { min-height: 116px; }
.kpi strong { display: block; color: var(--mint); font: 650 30px/1.1 Inter, ui-sans-serif, system-ui, sans-serif; margin: 12px 0 6px; }
.kpi small { color: var(--muted); }
.grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px; margin-bottom: 16px; }
.grid .wide { min-height: 320px; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 18px; margin-bottom: 16px; min-width: 0; }
.trust { margin-bottom: 16px; border-color: rgba(138,199,216,.22); background: rgba(8, 14, 16, .82); }
.trust-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 14px 0 18px; }
.trust-grid div { border-top: 1px solid var(--soft-line); padding: 12px 0 0; background: transparent; }
.trust-grid span { display: block; color: var(--muted); font-size: 12px; }
.trust-grid strong { display: block; color: var(--cyan); font: 650 26px/1.1 Inter, ui-sans-serif, system-ui, sans-serif; margin: 8px 0 4px; }
.trust-grid small { color: var(--muted); display: block; overflow-wrap: anywhere; }
.trust-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.trust-bottom { margin-top: 16px; }
.disclosure { margin-top: 18px; border-top: 1px solid var(--soft-line); padding-top: 14px; }
.disclosure summary { cursor: pointer; color: var(--text); list-style: none; font-weight: 650; }
.disclosure summary::-webkit-details-marker { display: none; }
.disclosure summary::after { content: "Open"; float: right; color: var(--quiet); font: 700 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: uppercase; letter-spacing: .08em; }
.disclosure[open] summary::after { content: "Close"; }
.disclosure[open] summary { margin-bottom: 8px; }
.trust-table .row { grid-template-columns: .9fr .5fr 1.6fr; }
.table .row > * { min-width: 0; overflow-wrap: anywhere; }
.proof { border-top: 1px solid var(--soft-line); padding: 12px 0 0; color: var(--muted); min-height: 112px; }
.proof strong { color: var(--mint); }
button {
  border: 1px solid rgba(138,199,216,.34);
  border-radius: 7px;
  padding: 9px 12px;
  background: rgba(138,199,216,.055);
  color: var(--cyan);
  font: 700 12px ui-monospace, SFMono-Regular, Consolas, monospace;
  cursor: pointer;
  max-width: 100%;
}
button:hover { border-color: rgba(126,230,184,.46); color: var(--mint); }
.bars { display: grid; grid-template-columns: repeat(24, 1fr); align-items: end; gap: 5px; height: 230px; padding: 16px 4px 0; border-bottom: 1px solid rgba(136,164,180,.2); }
.bar { min-height: 3px; border-radius: 999px 999px 0 0; background: linear-gradient(180deg, var(--mint), rgba(126,230,184,.16)); box-shadow: none; }
.bar.gap { height: 3px !important; background: rgba(136,164,180,.18); box-shadow: none; }
.list { display: grid; gap: 10px; }
.integration { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; border-top: 1px solid var(--soft-line); padding: 12px 0; }
.integration strong { display: block; }
.integration small { color: var(--muted); }
.state { font: 700 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--mint); }
.state.warn { color: var(--amber); }
.table { display: grid; gap: 2px; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.table .row { display: grid; grid-template-columns: 1.1fr .7fr .6fr; align-items: center; color: var(--muted); }
.table .row strong { color: var(--text); font-weight: 700; }
.note { border-color: rgba(196,137,217,.22); }
.note-layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr); gap: 24px; align-items: start; }
.note-lede { font-size: 15px; color: var(--text) !important; }
.note-message { border-left: 1px solid rgba(196,137,217,.24); padding-left: 18px; }
.note-guardrails { margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(136,164,180,.14); }
.note-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(136,164,180,.14); }
.note-disclosure { margin-top: 14px; }
.availability { color: var(--text) !important; border-left: 2px solid var(--magenta); padding-left: 12px; }
.trust-pitch { color: var(--mint) !important; }
.outreach { color: var(--text) !important; font: 13px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
.payout-note { border: 1px solid rgba(214,164,81,.24); border-radius: 8px; padding: 12px; background: rgba(214,164,81,.035); }
.code-list { font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); }
ul { margin: 14px 0 0; padding-left: 18px; color: var(--muted); }
li { margin: 8px 0; }
.toast { position: fixed; right: 24px; bottom: 24px; max-width: 520px; border: 1px solid rgba(138,199,216,.42); border-radius: 8px; padding: 14px 16px; background: #081012; color: var(--text); box-shadow: 0 18px 50px rgba(0,0,0,.25); }
@media (max-width: 980px) {
  .rail { position: static; width: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .system-mini { position: static; margin-top: 20px; }
  main { margin-left: 0; padding: 18px; }
  .topbar, .incident { grid-template-columns: 1fr; display: grid; }
  .kpis, .grid, .trust-grid, .trust-columns, .note-layout, .note-columns { grid-template-columns: 1fr; }
  .section-head { flex-wrap: wrap; align-items: flex-start; }
  .table .row, .trust-table .row { grid-template-columns: 1fr; gap: 2px; align-items: start; }
  button { white-space: normal; text-align: left; }
  .note-message { border-left: 0; padding-left: 0; border-top: 1px solid rgba(241,50,255,.25); padding-top: 16px; }
}
"###;

const SCRIPT: &str = r###"
const fmt = (ms) => ms ? new Date(ms).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '--';
const short = (s, n = 42) => !s ? '--' : (s.length > n ? s.slice(0, n - 1) + '...' : s);

async function get(path) {
  const r = await fetch(path, {cache: 'no-store'});
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

function severityClass(sev) {
  if (sev === 'critical') return 'critical';
  if (sev === 'warning' || sev === 'monitoring') return 'warning';
  return 'ok';
}

function renderSync(sync) {
  const cls = severityClass(sync.severity);
  document.getElementById('sync-pill').className = 'pill ' + cls;
  document.getElementById('sync-pill').textContent = sync.label;
  const panel = document.querySelector('.incident');
  panel.classList.toggle('critical', sync.severity === 'critical');
  document.getElementById('sync-title').textContent = sync.label + ': ledger freshness monitor';
  document.getElementById('sync-message').textContent = sync.message;
  document.getElementById('last-metric').textContent = fmt(sync.last_metric_send_ms);
  document.getElementById('account-sync').textContent = fmt(sync.account_ledger_last_synced_ms);
  document.getElementById('events-after').textContent = String(sync.local_events_after_account_sync ?? 0);
  document.getElementById('auth-failure').textContent = sync.last_auth_failure_ms ? fmt(sync.last_auth_failure_ms) + ' / ' + (sync.last_auth_failure_reason || 'unknown') : 'none in tail';
  document.getElementById('transport-status').textContent = sync.payment_transport_status || 'backend-owned';
}

function renderArchive(data) {
  document.getElementById('sightings').textContent = data.stats.total_sightings.toLocaleString();
  document.getElementById('advertisers').textContent = data.stats.advertisers.toLocaleString();
  document.getElementById('ads-seen').textContent = data.stats.distinct_ads.toLocaleString();
  const max = Math.max(1, ...data.activity.map(v => v || 0));
  document.getElementById('bars').innerHTML = data.activity.map(v => {
    const h = v == null ? 3 : Math.max(5, Math.round((v / max) * 220));
    return `<div class="bar ${v == null ? 'gap' : ''}" style="height:${h}px" title="${v == null ? 'not observed' : v + ' sightings'}"></div>`;
  }).join('');
  document.getElementById('leaderboard').innerHTML = data.leaderboard.map((r, i) =>
    `<div class="row"><strong>${i + 1}. ${short(r.advertiser, 24)}</strong><span>${r.sightings} sightings</span><span>${r.distinct_ads} ads</span></div>`
  ).join('') || '<div class="row">No advertisers captured yet</div>';
  document.getElementById('ledger').innerHTML = data.recent.slice(0, 8).map((r) =>
    `<div class="row"><strong>${short(r.advertiser, 18)}</strong><span>${fmt(r.observed_ms)}</span><span>${short(r.ad_id, 12)}</span></div>`
  ).join('') || '<div class="row">No local ledger rows yet</div>';
}

function renderIntegrations(items) {
  document.getElementById('integrations').innerHTML = items.map(item => `
    <div class="integration">
      <div><strong>${item.label}</strong><small>${short(item.detail, 68)}</small></div>
      <div class="state ${item.enabled ? '' : 'warn'}">${item.enabled ? 'Active' : (item.detected ? 'Needs setup' : 'Missing')}</div>
    </div>
  `).join('');
}

function renderStripe(s) {
  document.getElementById('stripe-ready').textContent = s.backend_owned ? 'Connect v2' : 'Unknown';
  document.getElementById('stripe-note').textContent = s.note;
  document.getElementById('stripe-api').textContent = s.api_version;
  document.getElementById('stripe-account').textContent = s.account_api;
  document.getElementById('stripe-dashboard').textContent = s.dashboard_access;
}

function renderTrust(t) {
  document.getElementById('trust-pitch').textContent = t.pitch;
  document.getElementById('user-risk').textContent = t.user_risk_score;
  document.getElementById('user-risk-band').textContent = t.user_risk_band;
  document.getElementById('surface-risk').textContent = t.surface_risk_score;
  document.getElementById('surface-risk-band').textContent = t.surface_risk_band;
  document.getElementById('suspicious-queue').textContent = t.suspicious_event_queue.count;
  document.getElementById('suspicious-reason').textContent = t.suspicious_event_queue.reason;
  document.getElementById('payout-holds').textContent = t.payout_hold_queue.count;
  document.getElementById('payout-reason').textContent = t.payout_hold_queue.reason;
  document.getElementById('eligibility').innerHTML = t.earning_eligibility_state.map((b) =>
    `<div class="row"><strong>${b.state}</strong><span>${b.count == null ? 'backend' : b.count}</span><span>${short(b.payout_impact, 72)}</span></div>`
  ).join('');
  document.getElementById('advertiser-proof').innerHTML =
    `<strong>${short(t.advertiser_protection.proof_statement, 96)}</strong><br><br>` +
    `Probe mode: ${t.non_earning_probe_mode.enabled ? 'enabled' : 'off'}<br>` +
    `Visible non-billable: ${t.advertiser_refund_exposure.local_visible_non_billable}<br>` +
    `Held for sync review: ${t.advertiser_refund_exposure.held_for_sync_review}`;
  document.getElementById('finality-gates').innerHTML = t.settlement_gates.map((g) =>
    `<div class="row"><strong>${g.gate}</strong><span>${g.blocks_payout ? 'blocks' : 'clear'}</span><span>${short(g.required_evidence, 72)}</span></div>`
  ).join('');
  document.getElementById('assurance-proof').innerHTML =
    `<strong>${short(t.advertiser_assurance.public_claim, 120)}</strong><br><br>` +
    t.advertiser_assurance.report_metrics.slice(0, 5).map((m) =>
      `${m.metric}: ${short(m.definition, 78)}`
    ).join('<br>');
  document.getElementById('ml-layer').innerHTML =
    `<strong>${t.ml_signal_layer.title}</strong><br><br>` +
    `${t.ml_signal_layer.authority_boundary}<br><br>` +
    `<span>${t.ml_signal_layer.labeled_training_data}</span>`;
  document.getElementById('ml-reason-codes').innerHTML =
    t.ml_signal_layer.reason_codes.map((code) => `<div>${code}</div>`).join('');
}

function renderNote(n) {
  document.getElementById('note-title').textContent = n.title;
  document.getElementById('note-summary').textContent = n.summary;
  document.getElementById('note-trust').textContent = n.trust_pitch;
  document.getElementById('note-availability').textContent = n.availability;
  document.getElementById('note-outreach').textContent = n.outreach_reply;
  document.getElementById('note-principles').innerHTML = n.principles.map(p => `<li>${p}</li>`).join('');
  document.getElementById('note-architecture').innerHTML = n.technical_architecture.map(p => `<li>${p}</li>`).join('');
  document.getElementById('note-ml').innerHTML = n.ml_plan.map(p => `<li>${p}</li>`).join('');
  document.getElementById('note-payout-review').textContent = n.payout_review_note;
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-command]');
  if (!btn) return;
  const toast = document.getElementById('command-toast');
  toast.hidden = false;
  toast.textContent = 'Run in a trusted terminal: ' + btn.dataset.command;
  setTimeout(() => toast.hidden = true, 6500);
});

async function refresh() {
  const [health, archive, install, stripe, trust, note] = await Promise.all([
    get('/api/health'),
    get('/api/archive'),
    get('/api/install/status'),
    get('/api/stripe'),
    get('/api/trust'),
    get('/api/developer-note'),
  ]);
  renderSync(health.sync);
  renderArchive(archive);
  renderIntegrations(install.integrations);
  renderStripe(stripe);
  renderTrust(trust);
  renderNote(note);
}

refresh().catch(err => {
  const toast = document.getElementById('command-toast');
  toast.hidden = false;
  toast.textContent = 'Dashboard failed to load: ' + err.message;
});
setInterval(refresh, 15000);
"###;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_has_required_product_surfaces() {
        assert!(INDEX_HTML.contains("Ledger freshness monitor"));
        assert!(INDEX_HTML.contains("Trust Engine"));
        assert!(INDEX_HTML.contains("ML signal layer"));
        assert!(INDEX_HTML.contains("Settlement state machine"));
        assert!(INDEX_HTML.contains("Stripe Connect"));
        assert!(INDEX_HTML.contains("Founder note"));
        assert!(INDEX_HTML.contains("No light mode"));
    }

    #[test]
    fn css_is_dark_only() {
        assert!(STYLES.contains("color-scheme: dark"));
        assert!(STYLES.contains("--mint"));
    }
}
