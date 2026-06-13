//! Filesystem path resolution. Every path is overridable via environment
//! variables so the tool is testable and works on non-standard installs.
//!
//! - `KICKBACKS_VIBE_DIR` overrides the extension artifact directory
//!   (default `~/.vibe-ads`).
//! - `KICKBACKS_KIT_DB` overrides the archive database path
//!   (default `<data-dir>/kickbacks-kit/kickbacks.db`).

use anyhow::{Context, Result};
use std::path::PathBuf;

/// Directory where the kickbacks.ai extension writes its CLI artifacts.
pub fn vibe_dir() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("KICKBACKS_VIBE_DIR") {
        return Ok(PathBuf::from(p));
    }
    let home = dirs::home_dir().context("could not resolve home directory")?;
    Ok(home.join(".vibe-ads"))
}

/// Current ad served to the CLI status line.
pub fn cli_ad_path() -> Result<PathBuf> {
    Ok(vibe_dir()?.join("cli-ad.json"))
}

/// Extension lifecycle log (JSONL).
pub fn debug_log_path() -> Result<PathBuf> {
    Ok(vibe_dir()?.join("debug.log"))
}

/// Directory holding our own archive database. Created on demand.
pub fn data_dir() -> Result<PathBuf> {
    let base = if let Ok(p) = std::env::var("KICKBACKS_KIT_DATA_DIR") {
        PathBuf::from(p)
    } else {
        dirs::data_dir()
            .context("could not resolve platform data directory")?
            .join("kickbacks-kit")
    };
    std::fs::create_dir_all(&base)
        .with_context(|| format!("could not create data directory: {}", base.display()))?;
    Ok(base)
}

/// Path to the archive database.
pub fn db_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("KICKBACKS_KIT_DB") {
        return Ok(PathBuf::from(p));
    }
    Ok(data_dir()?.join("kickbacks.db"))
}
