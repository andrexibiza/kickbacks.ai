<div align="center">

# kickbacks-kit

**Phase 0 desktop control plane for Kickbacks.ai developer earning integrity.**

Verified developer activity should start with official earning adapters, flow
through backend trust ledgers, and end in advertiser assurance that is visible
and auditable. This branch packages the local side of that story: a dark desktop
console, installer/repair flows for agent surfaces, a Trust Engine report, and
the older local archive/TUI companion moved underneath the product pitch.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built with Rust](https://img.shields.io/badge/built%20with-Rust-orange.svg)](https://www.rust-lang.org/)
[![Read only](https://img.shields.io/badge/local%20surfaces-non--earning-success.svg)](#safety-boundary)

<img src="media/kbtop.svg" alt="kickbacks-kit kbtop terminal dashboard for kickbacks.ai showing the current ad, total ads seen, a 24 hour sightings sparkline, the advertiser leaderboard, and recent ads in Claude Code" width="820">

</div>

---

Kickbacks.ai already has the important first move: sponsored messages appear
inside developer workflows and the revenue is shared with real users. Phase 0 is
about making that feel trustworthy before it feels large. Developers need to see
whether their local surfaces are installed and syncing. Advertisers need proof
that bot pressure, probe traffic, caps, refunds, holds, reversals, and payout
release are separated in ledgers instead of blurred into one impression count.

`kickbacks-kit` is the local control plane for that MVP:

- verified developer activity starts with official Kickbacks earning adapters,
  not with dashboard, repair, skill, or diagnostic code;
- `kb app` opens a dark desktop console for install state, ledger freshness,
  Trust Engine state, Stripe readiness boundaries, local archive, and a
  founder-facing developer note;
- `kb trust` shows the two-way Trust Engine: user risk, surface risk, earning
  eligibility states, caps, payout holds, refund exposure, finality gates, and
  advertiser proof;
- `kickbacks install --all --yes` and `kickbacks repair --all --yes` wire the
  local control surfaces for VS Code, Claude Code, Codex, Hermes Agent/TUI, and
  Claude/Codex/Hermes skills;
- the original `kb top`, `kb watch`, `kb snapshot`, and archive commands still
  keep a local history of the ads the extension shows.

Nothing in this repository mints money. The local app observes, diagnoses,
installs marker-owned files, and labels backend-owned states. Official adapters
create earning candidates; backend ledgers decide settlement; Stripe Connect is
only a payout rail after those gates clear.

`kickbacks-kit` is an independent community tool. It is not affiliated with
Kickbacks.ai or ShiftKeys, Inc.

## Shipped locally

These features are implemented in this Rust repository:

| Surface | Local behavior |
| :------ | :------------- |
| Desktop console | `kb app` serves a dark local console and JSON API at `http://127.0.0.1:38241`. |
| Trust Engine | `kb trust` classifies local evidence, names backend-required gates, and exposes advertiser assurance buckets. |
| Ledger freshness | `kb sync status` compares local metric sends, auth failures, and a user-provided account-ledger watermark. |
| Installer/repair | `kickbacks install`, `kickbacks repair`, and `kickbacks restore` manage marker-owned integrations without overwriting foreign files. |
| Agent wrappers | `kickbacks claude`, `kickbacks codex`, and `kickbacks hermes` launch the underlying CLIs through Kickbacks wrappers. |
| Skills | Claude, Codex, and Hermes skills explain install state, ledger freshness, Trust Engine output, and non-earning probe rules. |
| Hermes | Hermes gets a plugin, skill, CLI command group, and TUI slash command manifests for status, repair, dashboard, sync, trust, and doctor flows. |
| Local archive/TUI | `kb setup`, `kb watch`, `kb top`, `kb snapshot`, `kb archive`, and `kb export` store and display local ad observations. |

Local evidence is intentionally limited. Cluster detection across IP, ASN,
device, account age, Stripe/KYC state, payout identity, advertiser refund
exposure, and payout finality requires backend data. The app labels those as
backend-owned instead of pretending the desktop can settle them.

## Backend roadmap

These are product contracts for Kickbacks backend work, not local desktop claims:

- official earning adapters sign candidate events with surface ID, adapter
  ID/version, user/session ID, campaign/creative ID, render timestamp,
  wait-state proof, threshold timestamp, cap context, and backend nonce or
  receipt;
- the backend Trust Engine owns acceptance, rejection, cap arithmetic, invalid
  traffic filtering, advertiser refunds or credits, payout holds, and payout
  release;
- ML is a fraud-risk signal layer that emits reason-code candidates, while
  deterministic policy, manual review, and ledgers decide settlement;
- Stripe Connect stays server-side: the desktop can show backend-provided
  requirements and payout readiness, but never holds Stripe secrets or creates
  money movement;
- Telegram and Discord earning surfaces, if Kickbacks chooses to launch them,
  need the same official-adapter contract and must not be created by Hermes,
  skills, dashboards, or repair probes.

## Reward Exchange

The current payout story should remain cash-first: accepted earnings release
through backend trust gates and Stripe Connect readiness. The Reward Exchange is
a backend roadmap layer that can add optional sponsor-funded credits without
weakening the trust boundary.

Reward Exchange concepts:

- cash remains the default developer reward;
- sponsor-funded credits are optional and should be clearly labeled as credits,
  not cash;
- blended rewards can combine cash plus sponsor credits when the developer opts
  in;
- exchange multipliers can make some sponsor credits worth more inside a vendor
  ecosystem, but the multiplier belongs in a backend ledger;
- linked vendor accounts should be explicit, revocable, and separate from the
  local desktop archive;
- holds apply to both cash and credits until trust, refund, KYC, and reversal
  windows clear;
- reversals must claw back or adjust cash, credits, and multiplier benefits when
  events are rejected, refunded, disputed, or later classified as fraudulent.

The local console can display backend-provided Reward Exchange status later. It
should not create credits, choose multipliers, link vendor accounts, release
holds, or reverse balances locally.

## Safety boundary

This tool observes and configures. It does not, ever:

- post an impression, a view, a click, a credit, or any other billing event;
- call Kickbacks billing, metrics, or settlement routes from dashboard, doctor,
  installer, repair, skills, Hermes plugin, Telegram, Discord, or tests;
- keep a session visible to inflate view time;
- turn a local archive sighting into a payable event;
- hold Stripe secret keys, create charges, release payouts, or reverse payouts;
- overwrite user-owned skill, command, or plugin files that lack the
  `generated by kickbacks-kit` marker.

The honest lever for more and better ads is still real developer work with the
official Kickbacks adapter running. This project makes that work observable and
auditable; it does not manufacture activity.

## Install

From this Phase 0 branch:

```bash
git clone https://github.com/andrexibiza/kickbacks.ai.git
cd kickbacks.ai
git checkout axl/phase0-mvp-swarm
cargo build --release
```

The build produces both binaries:

```bash
target/release/kb --help
target/release/kickbacks --help
```

From the original upstream package:

```bash
cargo install --git https://github.com/OthmanAdi/kickbacks-kit
```

## Quickstart

```bash
kb setup                     # create the local archive and capture once
kb status                    # are ads flowing right now, and if not, why
kb doctor                    # verify local data sources and archive wiring
kb sync status               # ledger freshness monitor
kb trust                     # user, surface, hold, cap, and advertiser proof report
kb app                       # dark local desktop console and API
kb top                       # live archive/TUI dashboard
kb watch                     # headless local capture loop
```

For the founder-facing product install:

```bash
kickbacks install --all --yes
kickbacks repair --all --yes
kickbacks restore
kickbacks claude
kickbacks codex
kickbacks hermes
kickbacks developer-note
```

Installer, repair, doctor, skills, dashboard, Trust Engine, Hermes, Telegram,
and Discord flows must remain non-earning probe mode unless an official
Kickbacks adapter and backend ledger explicitly promote a candidate event.

## Desktop console

`kb app` starts the local dark-mode desktop console at
`http://127.0.0.1:38241`. It is designed as a working product surface, not a
marketing page:

- ledger freshness monitor for local metric sends versus the last known account
  ledger, without implying Stripe failure from a stale visible watermark alone;
- Trust Engine for user risk, surface risk, suspicious queues, payout holds, cap
  reasons, earning eligibility states, and advertiser proof;
- install status for VS Code, Claude Code CLI, Codex CLI, Hermes Agent/TUI, and
  skill packs;
- Hermes-specific status for the plugin, skill, CLI command group, and TUI
  slash commands;
- Stripe Connect readiness as a backend-owned contract;
- local archive, advertiser pulse, recent ledger, and founder-facing developer
  note.

The advertiser proof layer separates gross adapter events, held events,
rejected or fraudulent events, refunded events, final billable reach, and
payouts released after the trust window. Those numbers should come from explicit
backend ledgers: event classification, adapter attestation, fraud clusters,
advertiser refunds, and payout holds.

See [TRUST_ENGINE.md](TRUST_ENGINE.md) for the trust-boundary state machine,
settlement gates, advertiser assurance report, Reward Exchange boundary, and
Stripe payout boundary.

## Agent and skill surfaces

Claude Code:

```bash
kb install-claude --yes
kickbacks install --claude-cli --skills --yes
```

This installs `/kbtop` and `/kbstatus`, wraps the Claude Code status line with
`kb statusline`, and adds marker-owned Kickbacks slash commands for dashboard,
status, repair, trust, and doctor flows.

Codex:

```bash
kickbacks install --codex-cli --skills --yes
kickbacks codex
```

Codex gets a marker-owned skill and wrapper diagnostics. Earning events remain
owned by official Kickbacks adapters, not by Codex skill output.

Hermes:

```bash
kickbacks install --hermes --skills --yes
kickbacks hermes
```

Hermes gets a marker-owned skill, plugin, CLI command group, and TUI slash
commands:

```text
/kickbacks
/kickbacks-status
/kickbacks-repair
/kickbacks-dashboard
/kickbacks-sync
/kickbacks-trust
/kickbacks-doctor
```

Hermes should inspect, explain, repair marker-owned files, open the dashboard,
and hand implementation work to Codex. Hermes should not create earning events
or write settlement logic.

Telegram and Discord:

This repository does not ship Telegram or Discord earning adapters. If those
surfaces are added later, they should be official backend adapters with the same
attestation, cap, hold, refund, reversal, and advertiser assurance model as the
VS Code/developer-tool surfaces.

## Commands

| Command | What it does |
| :------ | :----------- |
| `kb app [--port N] [--no-open]` | Local dark desktop trust console and JSON API. |
| `kb api ENDPOINT` | Print one local app API payload, such as `health`, `trust`, `install/status`, or `skills`. |
| `kb trust [--json]` | Two-way Trust Engine: eligibility states, caps, holds, advertiser proof, and bot-risk contract. |
| `kb sync status [--json]` | Ledger freshness monitor for local metric sends versus account ledger watermark. |
| `kb sync mark --at TIME` | Record the last known account-ledger sync time. Accepts epoch millis, RFC3339, or `YYYY-MM-DD HH:mm`. |
| `kb sync clear` | Clear the account-ledger sync watermark. |
| `kb auth status` | Show local auth-file presence without printing secrets. |
| `kb auth sign-in` | Point the user to the official Kickbacks sign-in flow. |
| `kb auth sign-out` | Explain safe sign-out boundaries. |
| `kb install --all --yes` / `kb repair --all --yes` | Plug-and-play installer/repair for supported surfaces and skills. |
| `kb restore` | Remove marker-owned skills, plugin files, and slash commands. |
| `kb claude` / `kb codex` / `kb hermes` | Launch agent CLIs through Kickbacks wrappers. Hermes launches with its TUI default. |
| `kb developer-note [--json]` | Print the founder-friendly contribution note. |
| `kb top [--theme T] [--chart-style C]` | Live TUI dashboard. Captures on every tick. Press `t` for a theme, `c` for a chart style. |
| `kb snapshot [--width N] [--plain] [--theme T] [--chart-style C]` | One-shot dashboard render to stdout. Same view as `kb top`. |
| `kb statusline [--width N] [--plain]` | One status-bar line: the current ad plus local kb stats. |
| `kb status` | Whether ads are flowing now, and why not: killswitch, idle, signed out, or local state. |
| `kb watch [--interval N] [--once]` | Headless capture loop. Default poll is 3 seconds. |
| `kb archive stats` | Summary: ads seen, advertisers, sightings, today, this week. |
| `kb archive list [--limit N]` | Captured ads, most recent first. |
| `kb archive top [--limit N]` | Advertiser leaderboard by sightings. |
| `kb export [--format jsonl\|csv] [--out FILE]` | Dump the local corpus. |
| `kb setup` | First run: create the archive and capture once. |
| `kb doctor` | Check local data sources and the archive. |
| `kb install-claude` / `kb uninstall-claude` | Add or remove legacy `/kbtop` and `/kbstatus` commands and the status line. |

The `kickbacks` binary is an alias for the same CLI as `kb`.

## Local archive and TUI companion

The original `kickbacks-kit` flow is still useful. The Kickbacks.ai extension
writes a handful of local files. This tool reads them and stores what it sees in
SQLite:

| Source | Provides | Used for |
| :----- | :------- | :------- |
| `~/.vibe-ads/cli-ad.json` | The current ad: text, click URL, icon, rotation timestamp. | Capturing each ad into the archive. |
| `~/.vibe-ads/debug.log` | Lifecycle events: signed in, ads on, killswitch, Claude Code version, metric-send hints. | Status, sync health, and session state. |

Each ad is keyed by a hash of its click URL and text, so repeated rotations of
the same creative collapse to one row with a `times_seen` count. A rotation is
recorded once by timestamp, which makes capture idempotent.

The archive is a single SQLite file under your platform data directory:

- Windows: `%APPDATA%\kickbacks-kit\kickbacks.db`
- macOS: `~/Library/Application Support/kickbacks-kit/kickbacks.db`
- Linux: `~/.local/share/kickbacks-kit/kickbacks.db`

It never leaves your machine. `kb export` hands it back to you as JSONL or CSV.
Override the location with `KICKBACKS_KIT_DB`, and point the reader at a
different artifact directory with `KICKBACKS_VIBE_DIR`.

## Themes

The terminal dashboard reads on dark or light terminals. Pick a theme with
`--theme` on `kb top` or `kb snapshot`, or press `t` inside `kb top` for a live
picker. The choice is remembered.

| Theme | What you get |
| :---- | :----------- |
| `auto` | Detect a light or dark terminal and match it. Falls back to dark when the terminal does not report its background. |
| `dark` | A dark canvas, matching the screenshot. |
| `light` | A light canvas tuned for bright terminals. |
| `terminal` | No painted canvas: use your terminal's own colors and background. |

The sightings chart has two styles. `heat` is a calendar strip, one cell per
hour colored by activity. `bars` draws block bars on a baseline floor. Press `c`
in `kb top` to switch, or pass `--chart-style heat|bars`.

## Status and killswitch

Kickbacks.ai can pause ads server-side with a killswitch. When that happens, the
extension keeps running but no ads show, which can look like a local breakage.
`kb status` reads the extension's own last reported state and says so plainly:

```text
ads  PAUSED (kickbacks killswitch active)
```

`kb top` shows the same state as an "ADS PAUSED" banner. The state comes from
the extension log, so reload the VS Code window if you want it refreshed.

Kickbacks.ai does not publish a status page. The maintainer posts outages and
"we're back" notes on X: [@andrewmccalip](https://x.com/andrewmccalip). That,
plus `kb status`, is the most honest local read available.

## FAQ

**Does this earn me more money or boost Kickbacks earnings?**
No. Local surfaces never post impressions, views, clicks, credits, or payouts.
The honest way to earn more is real developer activity with the official
Kickbacks adapter running.

**Where do I see actual cash earnings?**
On your Kickbacks portfolio at [kickbacks.ai/me](https://kickbacks.ai/me). The
desktop console can show local activity and backend-provided readiness later,
but it does not invent balances.

**Do I need to be signed in to Kickbacks.ai?**
The archive can read local files whether you are signed in or not. Sign-in only
matters for official earning surfaces and backend payout state.

**Does it work with Codex and Hermes as well as Claude Code?**
The archive captures any ad written to the shared local file. This branch also
adds Codex and Hermes install/skill/control surfaces. Codex and Hermes wrappers
are diagnostic/control-plane surfaces unless an official Kickbacks adapter says
otherwise.

**Does it support Telegram or Discord?**
Not as shipped local adapters. The docs name the boundary because Telegram and
Discord are natural future surfaces for agent notifications or bot workflows,
but any earning path there should be official, signed, capped, and backend
settled.

**What happens with sponsor credits or Reward Exchange multipliers?**
Those are backend roadmap features. Cash, sponsor-funded credits, blended
rewards, multipliers, linked vendor accounts, holds, and reversals all need
backend ledgers and advertiser-visible audit trails before the desktop displays
them as settled value.

## Roadmap

Local next steps:

- keep the desktop console polished around install state, Trust Engine evidence,
  sync freshness, Hermes status, and developer note surfaces;
- add stronger API snapshots for README/PR screenshots;
- keep `kb top` as the compact local archive view below the desktop product.

Backend/product next steps:

- official adapter receipts for every earning surface;
- append-only event classification, adapter attestation, refund, reversal, and
  payout-hold ledgers;
- Reward Exchange for cash, optional sponsor-funded credits, blended rewards,
  exchange multipliers, linked vendor accounts, holds, and reversals;
- advertiser assurance reports showing gross, held, rejected, fraudulent,
  refunded, final billable, and payout-released counts separately;
- Telegram and Discord official adapters only if they can meet the same trust
  contract;
- ML fraud signals trained from known bot/farm labels and reviewed clean users,
  with policy and manual review retaining settlement authority.

Reading live earnings directly in the local app is intentionally not part of
this repository. Account balances, credits, multipliers, holds, reversals,
refunds, and payouts belong to the Kickbacks backend.

## Testing

```bash
cargo fmt --all -- --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release
```

Coverage should stay focused on the product boundary:

- Hermes plugin, skill, CLI group, and TUI command manifests are marker-owned
  and restorable;
- Claude/Codex/Hermes skills preserve non-earning probe mode;
- Trust Engine states keep local observation separate from backend acceptance;
- Reward Exchange, Telegram, and Discord docs do not imply shipped local
  settlement or earning adapters;
- dashboard, doctor, repair, skills, and tests never create payable events.

## Contributing

Issues and pull requests are welcome. Contributors are credited in the
CHANGELOG and `CONTRIBUTORS.md`, not in commit trailers. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

Built by [Ahmad-Othman Adi](https://github.com/OthmanAdi) (CodingWithAdi).
