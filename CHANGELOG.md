# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2]

### Added
* A selectable activity chart, defaulting to a "heat" calendar strip. The
  sightings panel now draws one cell per hour across a fixed 24 hour row,
  colored by intensity (a dim to gold ramp on color themes, shaded glyphs on
  the terminal theme), with a faint mark for hours kb was not watching. It
  reads the same whether one hour or all twenty four have data, which the old
  chart did not.
* A "bars" chart style alongside it: block bars on a continuous baseline floor,
  so a single busy hour stands on an axis instead of floating. Press `c` in
  `kb top` to switch (it persists next to the theme), or pass
  `--chart-style heat|bars` to `kb top` and `kb snapshot`.

### Fixed
* The activity chart was unreadable with sparse data: unobserved hours rendered
  as chunky shaded blocks and a lone busy hour looked like a floating stick.
  Both chart styles now handle one to twenty four hours of data cleanly, with
  no shaded slab.

## [0.3.1]

### Fixed
* The 24 hour activity chart was a wall of gray when most hours had no data.
  Unobserved hours rendered as full-height shaded slabs, so a new install (or
  any run with long gaps) drowned the real bars. Unobserved hours now show a
  single dim baseline mark, and observed hours rise as gold bars scaled to the
  busiest hour. Watched-but-quiet hours stay blank, so they still read
  differently from hours kb was not watching.

## [0.3.0]

### Added
* Theming for the dashboard. A new `--theme` flag on `kb top` and `kb snapshot`
  takes `auto`, `dark`, `light`, or `terminal`:
  * `dark` and `light` paint their own canvas (so the dashboard reads the same
    on any terminal). The light palette is tuned to clear WCAG AA contrast.
  * `terminal` drops the truecolor palette and uses the terminal's own colors
    and background, so it adopts whatever scheme you already run.
  * `auto` detects a light or dark terminal from `COLORFGBG` and falls back to
    the (painted) dark canvas when nothing reports it.
* A live theme picker in `kb top`: press `t`, arrow through the options with a
  live preview behind the overlay, Enter to save, Esc to revert. The choice
  persists to a small config file (`KICKBACKS_KIT_CONFIG`, default
  `<config-dir>/kickbacks-kit/config.json`).

### Fixed
* `kb top` was washed out on a light terminal: the palette was seven hardcoded
  dark colors and nothing painted the background, so the near-white text and
  muted grays vanished. The dashboard now paints its canvas (dark and light
  themes) or adopts the terminal's colors (terminal theme).

### Changed
* The 24 hour activity query buckets sightings in SQLite (`GROUP BY` hour)
  instead of pulling every row into memory on each render tick, so the cost no
  longer grows with the size of the sightings table.
* `kb archive stats` (and the totals on every dashboard tick and status line)
  now runs two queries instead of seven, with a single pass over the sightings
  table for the total and both time windows.

## [0.2.0]

### Added
* `kb snapshot`: a one-shot render of the dashboard to stdout (colored on a
  terminal, plain when piped). The interactive `kb top`, this snapshot, and the
  status line now draw through one shared render core, so they cannot disagree.
* `kb statusline`: one status-bar line that keeps the current kickbacks ad
  (prefix, hyperlink, control-character stripping, exactly like the extension's
  own line) and appends your kb stats after it. Built for Claude Code's status
  line setting.
* `kb install-claude` and `kb uninstall-claude`: add or remove two global slash
  commands (`/kbtop`, `/kbstatus`) and wire the status line. When the kickbacks
  extension already owns the status line, the installer wraps it and keeps a
  backup rather than replacing it.
* An "earnings" pointer on the dashboard and in `kb status`. kb stays read-only
  and offline, so it links to your portfolio (kickbacks.ai/me) instead of
  reading a balance it cannot verify.

### Changed
* The 24 hour sparkline now distinguishes hours kb was not watching (shaded)
  from hours with zero ads, so a gap in capture no longer reads as "no ads". A
  per-hour coverage record backs this.
* `debug.log` is read incrementally by byte offset and the live state is read
  from a bounded tail, instead of re-parsing the whole file on every refresh.
* Tagline parsing now shares the advertiser separator logic, so the "now
  playing" tagline and the advertiser name always agree.
* `--demo` is now a hidden dev-only flag for screenshots, and the demo dashboard
  is built through the real archive path so it cannot drift from live data.

### Notes
* Reading live earnings over the extension's loopback was evaluated and dropped:
  the local endpoint exposes only the log tail (no balance), and a real balance
  needs the Kickback.ai cloud backend, which the read-only invariant keeps out
  of scope.

## [0.1.3]

### Added
* `kb status`: an honest, local read of whether ads are flowing now, and why not
  (killswitch, idle, signed out, injection off), plus the current ad, Claude Code
  and extension versions, and archive totals.
* `kb top` shows a red "ADS PAUSED" banner when the Kickback.ai killswitch is
  active, and `kb doctor` gained an "ads status" line.
* Documented that Kickback.ai has no status page; the maintainer posts outages
  on X (@andrewmccalip).

## [0.1.2]

### Fixed
* Advertiser names now parse creatives that use a hyphen or dash separator
  (for example "Solo - run your agents"), not just the middot, and fall back to
  the click host only when no short brand head is present.
* The advertiser label is refreshed when an ad is seen again, so earlier rows
  heal to the better name on the next rotation.

## [0.1.1]

### Added
* `kb top --demo`: render the dashboard with sample data, labelled "demo data",
  touching no archive and writing nothing.
* README hero image of the dashboard, generated as a standalone SVG from the
  demo render by an ignored asset test (`generate_readme_svg`).
* FAQ section and search-friendly description, headings, and repo topics.

## [0.1.0]

### Added
* `kb top`: live terminal dashboard with now playing, lifetime totals, a 24 hour
  sightings sparkline, the advertiser leaderboard, and recent ads.
* `kb watch`: headless capture daemon with a configurable poll interval.
* `kb archive` subcommands: `stats`, `list`, `top`.
* `kb export`: dump the corpus as JSONL or CSV, to stdout or a file.
* `kb setup` and `kb doctor` helpers for first run and diagnostics.
* SQLite archive with idempotent ad capture keyed by rotation timestamp.
* Read-only by design: no billing event is ever emitted.
