<div align="center">

# kickbacks-kit

**A read-only companion for the [kickbacks.ai](https://kickbacks.ai) extension.**
Archive every ad you are shown, and watch your stats in a live terminal dashboard.

Track the sponsored ads kickbacks.ai shows in your Claude Code and Codex spinner:
a local ad archive plus a Rust TUI dashboard for ad sightings, advertisers, and 24 hour activity.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built with Rust](https://img.shields.io/badge/built%20with-Rust-orange.svg)](https://www.rust-lang.org/)
[![Tests](https://img.shields.io/badge/tests-97%20passing-brightgreen.svg)](#testing)
[![Read only](https://img.shields.io/badge/read--only-never%20bills-success.svg)](#what-this-is-and-is-not)

<img src="media/kbtop.svg" alt="kickbacks-kit kbtop terminal dashboard for kickbacks.ai showing the current ad, total ads seen, a 24 hour sightings sparkline, the advertiser leaderboard, and recent ads in Claude Code" width="820">

</div>

---

The kickbacks.ai extension shows sponsored messages in the Claude Code and Codex
spinners and splits the revenue with you. It keeps almost no history: the current
ad lives in one file, and earnings sit in memory until the next API poll.

`kickbacks-kit` keeps the history the extension discards. It watches the local
files the extension already writes, records every ad into a small SQLite archive,
and renders the whole picture in a terminal UI. Nothing leaves your machine.

This branch also prototypes the next product layer: a dark desktop trust console
for ledger freshness, installs, payout readiness, and bot-resistant earning
integrity.
The core pitch is simple: Kickbacks needs to pay real users without letting bots
drain advertisers.

> The dashboard above shows sample data, for the screenshot. Your real numbers
> fill in as you code with the extension running.

## What this is, and is not

This tool **observes**. It reads the files the extension writes for its own status
line and logging, and it stores what it finds. That is the entire scope.

It does **not**, ever:

* post an impression, a view, a click, or any other billing event,
* talk to the kickbacks.ai backend,
* keep a session visible to inflate view time,
* do anything to earn credit you did not earn by genuinely using the extension.

The advertisers pay for real attention, and the split to you rests on that. This
project records your history. It does not manufacture it. If you want more (and
better) ads, the honest lever is to do real work with the extension running.

The desktop app and Trust Engine keep that same line. They can read local
activity, account-ledger freshness, install state, Stripe readiness, and
backend-provided trust summaries. They must not post metrics, retry earning
events, hold Stripe secrets, create charges, or turn repair tests into payable
activity.

`kickbacks-kit` is an independent community tool. It is not affiliated with
kickbacks.ai or ShiftKeys, Inc.

## Install

From source (requires a [Rust toolchain](https://rustup.rs/)):

```bash
cargo install --git https://github.com/OthmanAdi/kickbacks-kit
```

Or clone and build:

```bash
git clone https://github.com/OthmanAdi/kickbacks-kit
cd kickbacks-kit
cargo build --release
# binaries at target/release/kb and target/release/kickbacks
```

## Quickstart

```bash
kb setup      # create the archive and capture once
kb status     # are ads flowing right now, and if not, why
kb doctor     # confirm the extension files and archive are wired up
kb app        # dark local desktop console and API
kb sync status
kb trust      # two-way trust ledger for users and advertisers
kb top        # live dashboard (also captures while open)
kb snapshot   # one-shot dashboard render to stdout
kb watch      # headless capture in a spare terminal
```

Leave `kb top` or `kb watch` running while you code. Each new ad rotation is
recorded once. Polling fast never double counts.

### Inside Claude Code

```bash
kb install-claude   # add /kbtop and /kbstatus, and wire the status line
```

This installs two global slash commands and points Claude Code's status line at
`kb statusline`, a single line that keeps the kickbacks ad and appends your own
stats next to it:

```
ad· Ramp - business cards that close themselves  ·  kb 12 today · 17 advs · ● live
```

An interactive TUI cannot run inside Claude Code's own pane, so `/kbtop` prints a
one-shot snapshot (`kb snapshot`); run `kb top` in a separate terminal for the
live version. If the kickbacks extension already owns the status line, the
installer wraps it rather than replacing it, and keeps a backup. Undo everything
with `kb uninstall-claude`.

## Desktop trust console

`kb app` starts a local dark-mode-only product console at `http://127.0.0.1:38241`.
It is designed as the real Kickbacks desktop surface, not a landing page:

* ledger freshness monitor for local metric sends versus the last known account
  ledger, without implying Stripe failure from a stale visible watermark alone,
* Trust Engine for user risk, surface risk, suspicious queues, payout holds, cap
  reasons, earning eligibility states, and advertiser proof,
* install status for VS Code, Claude Code CLI, Codex CLI, Hermes Agent/TUI, and
  skill packs,
* Stripe Connect readiness as a backend-owned contract,
* local archive, advertiser pulse, recent ledger, and founder-facing developer note.

The Trust Engine is a two-way ledger. Developers see whether their real activity
is syncing. Advertisers get the model for proof that ads were actually seen:
eligible, capped, visible-but-non-billable, held for review, rejected, fraudulent,
refunded, and bot-filtered buckets.

The advertiser proof layer is intentionally auditable. It separates gross adapter
events, held events, rejected or fraudulent events, refunded events, final
billable reach, and payouts released after the trust window. Those numbers should
come from explicit ledgers: event classification, adapter attestation, fraud
clusters, advertiser refunds, and payout holds.

Local evidence is intentionally limited. Cluster detection for same IP/ASN/device,
identical install fingerprints, account age, Stripe/KYC status, refund exposure,
and payout finality requires backend data. The app labels those as backend-owned
instead of inventing certainty.

See [TRUST_ENGINE.md](TRUST_ENGINE.md) for the trust-boundary state machine,
settlement gates, advertiser assurance report, and Stripe payout boundary.

## Plug-and-play integrations

The `kickbacks` binary is an alias for the same tool as `kb`, with app-facing
commands for a desktop product install:

```bash
kickbacks install --all --yes
kickbacks repair --all --yes
kickbacks restore
kickbacks claude
kickbacks codex
kickbacks hermes
```

`kickbacks install` can install or repair marker-owned integrations for VS Code,
Claude Code CLI commands/status line, Codex and Hermes skills, and the Hermes
plugin. Installer, repair, doctor, skills, dashboard, and Trust Engine flows are
non-earning probe mode: they validate setup without creating payable events.

## Commands

| Command | What it does |
| :------ | :----------- |
| `kb top [--theme T] [--chart-style C]` | Live TUI dashboard. Captures on every tick. Press `t` for a theme, `c` for a chart style. |
| `kb snapshot [--width N] [--plain] [--theme T] [--chart-style C]` | One-shot dashboard render to stdout. Same view as `kb top`. |
| `kb statusline [--width N] [--plain]` | One status-bar line: the current ad plus your kb stats. |
| `kb status` | Whether ads are flowing now, and why not (killswitch, idle, signed out). |
| `kb app [--port N] [--no-open]` | Local dark desktop trust console and JSON API. |
| `kb sync status` | Ledger freshness monitor for local metric sends versus account ledger watermark. |
| `kb sync mark --at TIME` | Record the last known account ledger sync time. |
| `kb trust [--json]` | Two-way Trust Engine: eligibility states, caps, holds, advertiser proof, bot-risk contract. |
| `kb install --all --yes` / `kb repair --all --yes` | Plug-and-play installer/repair for supported surfaces and skills. |
| `kb claude` / `kb codex` / `kb hermes` | Launch agent CLIs through Kickbacks wrappers. |
| `kb watch [--interval N] [--once]` | Headless capture loop. Default poll is 3 seconds. |
| `kb archive stats` | Summary: ads seen, advertisers, sightings, today, this week. |
| `kb archive list [--limit N]` | Captured ads, most recent first. |
| `kb archive top [--limit N]` | Advertiser leaderboard by sightings. |
| `kb export [--format jsonl\|csv] [--out FILE]` | Dump the corpus. JSONL loads straight into `datasets`. |
| `kb setup` | First-run: create the archive, capture once. |
| `kb doctor` | Check the local data sources and the archive. |
| `kb install-claude` / `kb uninstall-claude` | Add or remove the `/kbtop` and `/kbstatus` commands and the status line. |

## Themes

The dashboard reads on a dark or a light terminal. Pick a theme with `--theme`
on `kb top` or `kb snapshot`, or press `t` inside `kb top` for a live picker
(arrow keys preview, Enter saves, Esc reverts). The choice is remembered.

| Theme | What you get |
| :---- | :----------- |
| `auto` | Detect a light or dark terminal and match it. Falls back to dark when the terminal does not report its background. This is the default. |
| `dark` | A dark canvas, the same look as the screenshot above, on any terminal. |
| `light` | A light canvas tuned for bright terminals. Every color clears WCAG AA contrast. |
| `terminal` | No painted canvas: use your terminal's own colors and background. |

Auto-detection uses the `COLORFGBG` variable that many terminals export. When it
is absent (some terminals, including Windows Terminal, do not set it), `auto`
stays on the dark canvas, which is readable on a light background too. Pick
`light` or `terminal` explicitly, or use the picker, to override. Your selection
is saved to `<config-dir>/kickbacks-kit/config.json` (override with
`KICKBACKS_KIT_CONFIG`).

The sightings chart has two styles, saved in the same config. `heat` (the
default) is a calendar strip, one cell per hour colored by how busy it was, and
stays readable whether one hour or all twenty four have data. `bars` draws block
bars on a baseline floor when you want to read magnitude as height. Press `c` in
`kb top` to switch, or pass `--chart-style heat|bars`.

## How it works

The kickbacks.ai extension writes a handful of local files. `kickbacks-kit` reads
them and nothing else:

| Source | Provides | Used for |
| :----- | :------- | :------- |
| `~/.vibe-ads/cli-ad.json` | The current ad: text, click URL, icon, rotation timestamp. | Capturing each ad into the archive. |
| `~/.vibe-ads/debug.log` | Lifecycle events: signed in, ads on, killswitch, Claude Code version. | The status header and session state. |

Each ad is keyed by a hash of its click URL and text, so repeated rotations of the
same creative collapse to one row with a `times_seen` count. A rotation is recorded
once, by its timestamp, which makes capture idempotent.

## Your data

The archive is a single SQLite file under your platform data directory:

* Windows: `%APPDATA%\kickbacks-kit\kickbacks.db`
* macOS: `~/Library/Application Support/kickbacks-kit/kickbacks.db`
* Linux: `~/.local/share/kickbacks-kit/kickbacks.db`

It never leaves your machine. `kb export` hands it back to you as JSONL or CSV
whenever you want it. Override the location with `KICKBACKS_KIT_DB`, and point the
reader at a different artifact directory with `KICKBACKS_VIBE_DIR`.

## Status and the killswitch

kickbacks.ai can pause ads server-side with a killswitch. When that happens, the
extension keeps running but no ads show, which looks like something on your end
broke. `kb status` reads the extension's own last reported state and tells you
plainly:

```
ads  ● PAUSED (kickbacks killswitch active)
```

`kb top` shows the same thing as a red "ADS PAUSED" banner. The state comes from
the extension log, so reload the VS Code window if you want it refreshed.

kickbacks.ai does not publish a status page. The maintainer posts outages and
"we're back" notes on X: [@andrewmccalip](https://x.com/andrewmccalip). That, plus
`kb status`, is the most honest read available.

## FAQ

**Why did ads suddenly stop showing?**
Usually the kickbacks.ai killswitch, which pauses ads on their side (for example
during a backend outage). Run `kb status`: if it says PAUSED, it is not your setup
and you cannot override it. If it says IDLE, just start a Claude Code task so a
spinner runs.

**What is kickbacks-kit?**
A small Rust command line tool that archives the ads the kickbacks.ai extension
shows in your Claude Code and Codex spinner, and displays them in a terminal
dashboard. Two pieces: a local ad archive (`kb archive`) and a live TUI (`kb top`).

**Does it earn me more money or boost my kickbacks earnings?**
No, and that is deliberate. It is read-only. It never posts an impression, view,
or click, and never contacts the kickbacks.ai backend. The honest way to earn more
is to do real work with the extension running. This tool just keeps the record.

**Where do I see my actual earnings?**
On your kickbacks portfolio at [kickbacks.ai/me](https://kickbacks.ai/me). kb does
not read your balance: that needs the cloud backend, and kb stays read-only and
offline. The dashboard and `kb status` link you there rather than showing a number
they cannot verify.

**Do I need to be signed in to kickbacks.ai?**
No. It reads local files, so it works whether you are signed in or not. Sign-in
only matters for the earnings the extension itself accrues.

**Where is my data stored, and is anything uploaded?**
In one SQLite file on your machine (see "Your data"). Nothing is uploaded. `kb export`
gives you the whole corpus as JSONL or CSV.

**Does it work with Codex as well as Claude Code?**
The archive captures any ad written to the shared CLI file. Codex-specific surface
support is on the roadmap.

## Roadmap

* Anonymized, opt-in public dataset of spinner ad creatives.
* Codex surface support alongside Claude Code.
* Per-advertiser detail view in the dashboard.

Reading live earnings was considered and dropped: it would require the
kickbacks.ai cloud backend, which crosses the read-only line this tool is built
on. Earnings stay where they belong, on your [portfolio](https://kickbacks.ai/me).

## Testing

```bash
cargo fmt --all -- --check
cargo test       # unit tests plus TUI render snapshots
cargo clippy --all-targets -- -D warnings
cargo build --release
```

## Contributing

Issues and pull requests are welcome. Contributors are credited in the CHANGELOG
and `CONTRIBUTORS.md`, not in commit trailers. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

Built by [Ahmad-Othman Adi](https://github.com/OthmanAdi) (CodingWithAdi).
