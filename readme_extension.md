<h1 align="center">Kickbacks</h1>

<p align="center"><em>Get paid while you code. Earn up to 50% of ad revenue.</em></p>

<p align="center">
  <a href="https://kickbacks.ai">kickbacks.ai</a> ·
  <a href="https://github.com/andrewmccalip/kickbacks.ai">GitHub</a> ·
  <a href="https://github.com/andrewmccalip/kickbacks.ai/issues">Issues</a>
</p>

---

## How it works

Kickbacks works with the **Claude Code** and **Codex** VS Code extensions, and
with the **Claude Code terminal CLI**. While either tool is thinking, its
spinner shows a random verb ("Discombobulating...", "Baking..."). Kickbacks
replaces that verb with a tiny, clickable sponsored line. Advertisers bid for
the slot; **up to 50% of the resulting ad revenue is credited to you**.

In a terminal, the same ad appears two ways: a clickable line in the status bar
(every Claude Code version) and the thinking-spinner verb itself (Claude Code
2.1.143 and newer). The terminal verb refreshes when you start a new `claude`
session.

Your balance shows in the VS Code status bar and updates in real time.

## Features

- **Earn passively** — impressions and clicks accrue while Claude Code or Codex works. Clicks earn 50× an impression.
- **Revenue share** — up to 50% of ad revenue, credited per impression and click.
- **Fully reversible** — one click restores Claude Code to its original state.
- **Zero interference** — never reads your code, prompts, or completions.
- **Auto-updates** — new versions install silently in the background.

## Getting started

1. Install from the VS Code marketplace (search **Kickbacks**).
2. Click **Kickbacks: Sign in** in the status bar.
3. Authenticate with Google.
4. Start using Claude Code. Earnings begin automatically.

Before you sign in you'll already see real sponsored lines in the spinner — a
live preview of the product. **Those preview impressions don't earn you
anything; sign in to start earning your share.**

Your balance appears in the status bar: **Kickbacks ($0.42 today · $7.11)**

## Status bar

| State | Meaning |
| --- | --- |
| *Kickbacks: Sign in* | Not signed in yet. Click to authenticate. |
| *Kickbacks ($0.42 today · $7.11)* | Signed in and earning. |
| *Kickbacks: Off* | You disabled Kickbacks. Click to re-enable. |
| *Kickbacks incompatible* | Your Claude Code version isn't supported yet. |
| *Kickbacks offline* | Backend is temporarily unreachable. |
| *Kickbacks killed* | Serving is remotely paused fleet-wide (safety kill-switch). |
| *⚠ Kickbacks: RELOAD to earn money* | An update needs a window reload before earning resumes. Click to reload. |

When you hit an earning limit, a second red pill appears next to your balance —
*🕐 Hourly cap · 42m* or *⚠ Daily cap · 6h 12m* — showing which cap you hit
and when it resets. Ads keep showing but stop accruing until the reset; click
the pill for details.

Click the status bar to open the Kickbacks menu (sign in/out, enable/disable,
restore Claude Code, check for updates, open debug log).

## Privacy

Kickbacks communicates only with the Kickbacks backend at
[kickbacks.ai](https://kickbacks.ai). It sends:

- An anonymous device ID (not tied to your identity until you sign in).
- Per-impression events (ad ID, surface, visible time, click).
- Your Google email only after you sign in, so earnings can be credited.

**Kickbacks never reads your code, prompts, completions, or any chat content.**

Patching is done by modifying Claude Code's `webview/index.js` (and the Codex
extension's webview bundle) from byte-exact backups (VS Code), and by editing
`~/.claude/settings.json` to add a status-line script and a spinner-verb
override (terminal CLI). If you already use a custom status line (a HUD,
for example), it is kept: the ad renders on the line above it, and your
original entry is put back on restore. All edits are fully reversible —
select *Restore Claude Code* from the menu at any time and the originals
are restored byte-for-byte.

## Commands

Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
| --- | --- |
| Kickbacks: Sign in | Authenticate with Google. |
| Kickbacks: Sign out | Sign out and stop earning. |
| Kickbacks: Restore Claude Code | Revert to unpatched Claude Code. |
| Kickbacks: Menu | Open the full Kickbacks menu. |

## Compatibility

Works with both the **VS Code extensions** (Claude Code and Codex) and the
**Claude Code terminal CLI**:

| Surface | Where | Requirements |
| --- | --- | --- |
| Spinner overlay | Claude Code / Codex VS Code panel | Compatible extension build |
| Status-bar line | Claude Code terminal CLI | Any Claude Code version |
| Spinner verb | Claude Code terminal CLI | Claude Code **2.1.143+** |

VS Code surfaces work on local VS Code, Cursor, Remote-SSH, and devcontainers.
The terminal status-bar line works on every Claude Code CLI; the
terminal spinner-verb ad needs Claude Code 2.1.143 or newer (older CLIs simply
keep their stock verbs — nothing breaks).

If Kickbacks can't find a compatible target, it does nothing. It will never
break your editor or your terminal.

## FAQ

**Does this affect Claude Code or Codex?**
No. The only change is the spinner text and the idle usage banner. All Claude Code
and Codex features work exactly as before.

**How do I get paid?**
Earnings are tracked on the Kickbacks backend. Visit [kickbacks.ai](https://kickbacks.ai)
to view your balance and set up payouts.

**Can I turn it off?**
Yes. Click the status bar and select *Disable Kickbacks*, or run *Restore Claude Code*
to fully revert.

**Is my code safe?**
Kickbacks has no access to your code, prompts, or AI responses. It only modifies
the spinner display text.

---

<p align="center">
  <a href="https://kickbacks.ai">kickbacks.ai</a> ·
  <a href="https://github.com/andrewmccalip/kickbacks.ai">GitHub</a>
</p>
