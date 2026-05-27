//! Headless API layer for metalcraft-workshop.
//!
//! All file I/O and data shaping lives here so it can be unit-tested without
//! Tauri. The Tauri crate is a thin wrapper that exposes this surface to the
//! webview via `#[tauri::command]` handlers and forwards file-watcher events.

pub mod commands;
pub mod diagnostics;
pub mod flows;
pub mod personas;
pub mod project;
pub mod skills;
pub mod watcher;

pub use commands::{FileKind, FrontendCommand, WorkshopEvent};
pub use diagnostics::{ChatTimeline, DiagnosticsSessionSummary, TimelineEvent};
pub use personas::{Persona, PersonaSummary};
pub use project::{ProjectSnapshot, scan_project};
pub use skills::{Skill, SkillSummary};
