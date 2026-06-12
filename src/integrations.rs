use anyhow::{Context, Result};
use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths;
use crate::sources;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationCapability {
    Earn,
    Observe,
    Configure,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntegrationStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub detected: bool,
    pub enabled: bool,
    pub capability: IntegrationCapability,
    pub version: Option<String>,
    pub path: Option<String>,
    pub detail: String,
    pub install_command: String,
    pub repair_command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub path: String,
    pub installed: bool,
    pub install_command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StripeConnectStatus {
    pub backend_owned: bool,
    pub api_version: &'static str,
    pub account_api: &'static str,
    pub dashboard_access: &'static str,
    pub requirement_collection: &'static str,
    pub payouts_ready: Option<bool>,
    pub requirements_due: Vec<String>,
    pub note: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemStatus {
    pub integrations: Vec<IntegrationStatus>,
    pub skills: Vec<SkillStatus>,
    pub stripe: StripeConnectStatus,
}

pub fn system_status() -> Result<SystemStatus> {
    Ok(SystemStatus {
        integrations: integrations()?,
        skills: skills()?,
        stripe: stripe_status(),
    })
}

pub fn integrations() -> Result<Vec<IntegrationStatus>> {
    Ok(vec![
        vscode_status(),
        claude_status(),
        codex_status(),
        hermes_status(),
    ])
}

pub fn skills() -> Result<Vec<SkillStatus>> {
    let home = dirs::home_dir().context("could not resolve home directory")?;
    let entries = [
        (
            "claude",
            "Claude skill",
            home.join(".claude")
                .join("skills")
                .join("kickbacks")
                .join("SKILL.md"),
        ),
        (
            "codex",
            "Codex skill",
            home.join(".codex")
                .join("skills")
                .join("kickbacks")
                .join("SKILL.md"),
        ),
        (
            "hermes",
            "Hermes skill",
            home.join(".hermes")
                .join("skills")
                .join("kickbacks")
                .join("SKILL.md"),
        ),
    ];
    Ok(entries
        .into_iter()
        .map(|(id, label, path)| SkillStatus {
            id,
            label,
            installed: path.exists(),
            path: path.display().to_string(),
            install_command: match id {
                "claude" => "kickbacks install --claude-cli --skills".to_string(),
                "codex" => "kickbacks install --codex-cli --skills".to_string(),
                "hermes" => "kickbacks install --hermes --skills".to_string(),
                _ => "kickbacks install --skills".to_string(),
            },
        })
        .collect())
}

pub fn stripe_status() -> StripeConnectStatus {
    StripeConnectStatus {
        backend_owned: true,
        api_version: "2026-05-27.dahlia",
        account_api: "Stripe Connect Accounts v2 (/v2/core/accounts)",
        dashboard_access: "Express-style dashboard access via controller properties",
        requirement_collection: "Stripe/Kickbacks backend collects requirements; desktop is display-only",
        payouts_ready: None,
        requirements_due: Vec::new(),
        note: "Desktop app must not hold Stripe secret keys or create money movement. It displays backend-provided Connect account, requirements, and payout readiness.",
    }
}

pub fn run_wrapped(tool: &str, default_args: &[&str], args: &[String]) -> Result<()> {
    let mut final_args: Vec<String> = if args.is_empty() {
        default_args.iter().map(|s| (*s).to_string()).collect()
    } else {
        args.to_vec()
    };
    if final_args.first().map(String::as_str) == Some("--") {
        final_args.remove(0);
    }
    let exe = find_executable(tool).with_context(|| format!("{tool} was not found on PATH"))?;
    let status = Command::new(&exe)
        .args(&final_args)
        .status()
        .with_context(|| format!("launching {}", exe.display()))?;
    if !status.success() {
        anyhow::bail!("{tool} exited with status {status}");
    }
    Ok(())
}

pub fn installed_extension_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".vscode").join("extensions");
    let entries = std::fs::read_dir(dir).ok()?;
    let mut matches: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("kickbacksai.kickbacks-ai"))
                .unwrap_or(false)
        })
        .collect();
    matches.sort();
    matches.pop()
}

pub fn find_executable(name: &str) -> Option<PathBuf> {
    let name_path = Path::new(name);
    if name_path.is_absolute() && name_path.exists() {
        return Some(name_path.to_path_buf());
    }
    let path = env::var_os("PATH")?;
    let exts = executable_extensions();
    for dir in env::split_paths(&path) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn executable_extensions() -> Vec<String> {
    if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|s| s.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    }
}

fn vscode_status() -> IntegrationStatus {
    let code = find_executable("code");
    let extension = installed_extension_dir();
    let version = sources::installed_extension_version();
    IntegrationStatus {
        id: "vscode",
        label: "VS Code extension",
        kind: "desktop_editor",
        detected: code.is_some() || extension.is_some(),
        enabled: extension.is_some(),
        capability: if extension.is_some() {
            IntegrationCapability::Earn
        } else {
            IntegrationCapability::Configure
        },
        version,
        path: extension.or(code).map(|p| p.display().to_string()),
        detail: if sources::installed_extension_version().is_some() {
            "Kickbacks extension detected".to_string()
        } else {
            "Install the Kickbacks extension to enable VS Code earning surfaces".to_string()
        },
        install_command: "kickbacks install --vscode".to_string(),
        repair_command: "kickbacks repair --vscode".to_string(),
    }
}

fn claude_status() -> IntegrationStatus {
    let exe = find_executable("claude");
    let home = dirs::home_dir();
    let settings = home
        .as_ref()
        .map(|h| h.join(".claude").join("settings.json"));
    let enabled = settings
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.contains("kb statusline") || s.contains("kickbacks statusline"))
        .unwrap_or(false);
    IntegrationStatus {
        id: "claude",
        label: "Claude Code CLI",
        kind: "cli",
        detected: exe.is_some(),
        enabled,
        capability: if enabled {
            IntegrationCapability::Earn
        } else {
            IntegrationCapability::Configure
        },
        version: tool_version("claude"),
        path: exe.map(|p| p.display().to_string()),
        detail: if enabled {
            "Claude statusLine is wired to Kickbacks".to_string()
        } else {
            "Run the installer to add statusLine, slash commands, and skill".to_string()
        },
        install_command: "kickbacks install --claude-cli --skills".to_string(),
        repair_command: "kickbacks repair --claude-cli".to_string(),
    }
}

fn codex_status() -> IntegrationStatus {
    let exe = find_executable("codex");
    let home = dirs::home_dir();
    let skill = home.as_ref().map(|h| {
        h.join(".codex")
            .join("skills")
            .join("kickbacks")
            .join("SKILL.md")
    });
    let enabled = skill.as_ref().map(|p| p.exists()).unwrap_or(false);
    IntegrationStatus {
        id: "codex",
        label: "Codex CLI",
        kind: "cli",
        detected: exe.is_some(),
        enabled,
        capability: if enabled {
            IntegrationCapability::Observe
        } else {
            IntegrationCapability::Configure
        },
        version: tool_version("codex"),
        path: exe.map(|p| p.display().to_string()),
        detail: "Codex wrapper and skill support Kickbacks diagnostics; earning events remain owned by official adapters".to_string(),
        install_command: "kickbacks install --codex-cli --skills".to_string(),
        repair_command: "kickbacks repair --codex-cli".to_string(),
    }
}

fn hermes_status() -> IntegrationStatus {
    let exe = find_executable("hermes");
    let home = dirs::home_dir();
    let plugin = home.as_ref().map(|h| {
        h.join(".hermes")
            .join("plugins")
            .join("kickbacks")
            .join("plugin.yaml")
    });
    let enabled = plugin.as_ref().map(|p| p.exists()).unwrap_or(false);
    IntegrationStatus {
        id: "hermes",
        label: "Hermes Agent/TUI",
        kind: "agent_tui",
        detected: exe.is_some(),
        enabled,
        capability: if enabled {
            IntegrationCapability::Observe
        } else {
            IntegrationCapability::Configure
        },
        version: tool_version("hermes"),
        path: exe.map(|p| p.display().to_string()),
        detail: if enabled {
            "Hermes plugin and skill are installed".to_string()
        } else {
            "Install the Hermes plugin, skill, TUI slash commands, and CLI group".to_string()
        },
        install_command: "kickbacks install --hermes --skills".to_string(),
        repair_command: "kickbacks repair --hermes".to_string(),
    }
}

fn tool_version(tool: &str) -> Option<String> {
    let exe = find_executable(tool)?;
    let output = Command::new(exe).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    Some(raw.lines().next().unwrap_or_default().trim().to_string())
}

pub fn auth_status() -> Result<String> {
    let auth = dirs::home_dir()
        .context("could not resolve home directory")?
        .join(".kickbacks")
        .join("auth.json");
    if !auth.exists() {
        return Ok("not signed in (no ~/.kickbacks/auth.json)".to_string());
    }
    let raw = std::fs::read_to_string(&auth)?;
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    let has_client = v.get("clientId").and_then(|x| x.as_str()).is_some();
    let has_refresh = v.get("refresh").and_then(|x| x.as_str()).is_some();
    Ok(format!(
        "auth file present; client id {}; refresh token {}",
        if has_client { "present" } else { "missing" },
        if has_refresh { "present" } else { "missing" }
    ))
}

pub fn app_data_paths() -> Result<Vec<(String, String)>> {
    Ok(vec![
        (
            "archive_db".to_string(),
            paths::db_path()?.display().to_string(),
        ),
        (
            "vibe_dir".to_string(),
            paths::vibe_dir()?.display().to_string(),
        ),
        (
            "debug_log".to_string(),
            paths::debug_log_path()?.display().to_string(),
        ),
    ])
}
