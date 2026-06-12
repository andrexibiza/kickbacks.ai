# AGENTS.md

## Product Name

This repo is for **Kickback.ai**.

- Use `Kickback.ai` in product prose, founder-facing copy, UI labels, docs, and agent summaries.
- Do not rename the product to `Kickbacks.ai`, `kickbacks.ai`, or `Kickbacks` in new user-facing language.
- Existing technical identifiers such as `kickbacks-kit`, the `kickbacks` binary, `kb`, `KICKBACKS_*` environment variables, paths, extension IDs, and legacy file names are implementation details. Preserve them unless the task explicitly asks for a rename or migration.

## Product Direction

Kickback.ai is a developer-attention monetization product, not merely a passive archive.

- Billing, monetization, impression, attention, or metric events in the desktop app are allowed when they are deliberate product behavior.
- Do not block desktop-app billing work because of an older read-only invariant from the local archive/TUI layer.
- Keep event semantics explicit: distinguish local observations, billable attention events, backend settlement, payout readiness, fraud review, refunds, and advertiser reporting.
- Do not fabricate balances, payouts, advertiser charges, impressions, or backend state. If data is inferred, labeled, stale, simulated, or backend-owned, say so in the UI/API/docs.
- Protect auth, payout, Stripe, and backend secrets. Do not print or persist secrets in logs, docs, tests, fixtures, or memory.

## Architecture Boundaries

- The Rust CLI/TUI remains the local engine for capture, diagnostics, installer flows, sync visibility, and the desktop app.
- The desktop app is the main Kickback.ai product surface and may evolve beyond local observation.
- Trust, fraud, settlement, payout, and advertiser proof should be designed as auditable ledgers with reason codes, not opaque UI claims.
- Installer, repair, doctor, and skill/agent integration flows should be safe probes unless the user or product flow explicitly makes an earning/billing event.
- Keep Hermes, Claude, Codex, VS Code, and skill integrations marker-owned where possible. Never overwrite foreign user files without explicit approval.

## Swarm Delegation Standards

Swarm or subagent delegation in this repo has a high bar.

- Use subagents only when parallel work will materially improve speed, coverage, or review quality.
- Every spawned subagent must have a concrete lane, bounded scope, expected output, and evidence target.
- Actually use all assigned subagents efficiently. Idle, standby, duplicate, or ceremonial subagents are not allowed.
- Split work so subagents do non-overlapping investigation, implementation, verification, or review tasks.
- Use parallel git worktrees for swarm lanes when work spans multiple areas, experiments, or risky edits that should stay isolated.
- Each parallel worktree needs a named purpose, branch, assigned subagent, verification target, and cleanup or merge path.
- Do not leave idle worktrees, abandoned branches, or unsynchronized divergent edits behind.
- Reassign or stop any subagent that becomes blocked or no longer has useful work.
- Integrate subagent findings into the final repo state; do not leave swarm output as disconnected notes.
- The lead agent remains accountable for correctness, final edits, verification, and preserving user changes.

## Development Workflow

- Read the local diff before editing; this repo may contain active user changes.
- Prefer focused changes that match the existing Rust module layout.
- Use `rg` / `rg --files` for repo search.
- Use `apply_patch` for manual edits.
- Do not run destructive git commands or revert user work unless explicitly asked.
- On Windows, use PowerShell-native file operations and avoid fragile mixed-shell command chains.

## Verification

Use the repo's Rust checks for implementation work:

```powershell
cargo fmt --all -- --check
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --release
```

For narrow doc-only changes, a full build is not required, but still inspect the final file and `git diff`.

## Firecrawl Runtime Contract

Firecrawl on this machine is local-only and Windows-native only.

- Required local API: `http://127.0.0.1:3002`
- Health check: `http://127.0.0.1:3002/v0/health/liveness`
- Source checkout: `C:\Users\andre\firecrawl`
- Preferred watchdog/start path: Windows scheduled task `Firecrawl Native Heartbeat`
- Scheduled task hidden setting: `True`
- Watchdog script: `C:\Users\andre\.hermes\scripts\firecrawl-native-heartbeat.ps1`
- Native start script: `C:\Users\andre\firecrawl\tools\windows\Start-FirecrawlNative.ps1`
- Native stop script: `C:\Users\andre\firecrawl\tools\windows\Stop-FirecrawlNative.ps1`
- Native state file: `C:\Users\andre\.firecrawl-windows\firecrawl-native-processes.json`

Do not check hosted Firecrawl status, assume Firecrawl Cloud, ask for a cloud API key, start Docker, start Podman, or start a WSL Firecrawl runtime. Do not use `C:\Users\andre\.agent-tools\firecrawl\Start-FirecrawlStack.ps1` for active startup; that path is legacy cleanup/compatibility only. A `wslrelay.exe` owner on port `3002` is a fault, not a healthy Firecrawl API.

Do not use `firecrawl --status` as the local health gate. CLI v1.18.0 can report `Could not fetch account info` because it reads stored cloud credentials and calls local account endpoints such as `/v2/team/credit-usage`; that warning does not mean local scraping is down. Prove readiness with `/v0/health/liveness` plus a tiny `/v2/scrape` or CLI scrape against `--api-url http://127.0.0.1:3002`.

If Firecrawl is down, first verify local port owners and then run the Windows-native heartbeat silently through the scheduled task:

```powershell
Start-ScheduledTask -TaskName "Firecrawl Native Heartbeat"
```

If a direct launch is unavoidable, use `Start-Process` with `-WindowStyle Hidden`; do not foreground a PowerShell window.
