# Contributing

Thanks for your interest in kickbacks-kit. Issues and pull requests are welcome.

## Ground rule

This project is read-only by design. It observes the local files the Kickback.ai
extension writes, and it never emits a billing event or contacts the backend. Any
change that would post an impression, a view, a click, or otherwise inflate credit
is out of scope and will not be merged. Keeping that line clean is the whole point.

## Development

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt
```

All four should be clean before you open a pull request. New behavior needs a test.
The parsing, dedup, and TUI render paths are all covered today; please keep them so.

## Testing against fixtures

You do not need the extension installed to develop. Point the reader at a fixture
directory and use a scratch database:

```bash
export KICKBACKS_VIBE_DIR=/tmp/kbfix
export KICKBACKS_KIT_DB=/tmp/kbfix/fixture.db
# write a cli-ad.json into $KICKBACKS_VIBE_DIR, then:
kb watch --once
kb archive stats
```

## Credit

Contributors are credited in the [CHANGELOG](CHANGELOG.md) and in
[CONTRIBUTORS.md](CONTRIBUTORS.md), not in commit trailers.
