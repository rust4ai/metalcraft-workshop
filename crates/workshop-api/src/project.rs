//! Project-level snapshot. A snapshot is the list of artifacts available in
//! whatever backing project the workshop is currently connected to — either a
//! local directory or a remote agent's REST API.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::api_tools::{self, ApiToolSummary};
use crate::diagnostics::{self, DiagnosticsSessionSummary};
use crate::flows;
use crate::personas::{self, PersonaSummary};
use crate::skills::{self, SkillSummary};

pub use metalcraft_flows::FlowSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSnapshot {
    /// Display label for the connection source. For local mode this is the
    /// directory path; for remote mode it's the base URL.
    pub root: String,
    pub mode: ConnectionMode,
    pub personas: Vec<PersonaSummary>,
    pub skills: Vec<SkillSummary>,
    pub flows: Vec<FlowSummary>,
    pub sessions: Vec<DiagnosticsSessionSummary>,
    #[serde(default)]
    pub api_tools: Vec<ApiToolSummary>,
    pub layout: ProjectLayout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectLayout {
    pub has_personas: bool,
    pub has_skills: bool,
    pub has_flows: bool,
    pub has_logs: bool,
    pub has_api_tools: bool,
}

pub fn scan_local(root: &Path) -> ProjectSnapshot {
    ProjectSnapshot {
        root: root.display().to_string(),
        mode: ConnectionMode::Local,
        personas: personas::list(root),
        skills: skills::list(root),
        flows: flows::list(root),
        sessions: diagnostics::list_sessions(root),
        api_tools: api_tools::list(root),
        layout: ProjectLayout {
            has_personas: personas::personas_dir(root).is_dir(),
            has_skills: skills::skills_dir(root).is_dir(),
            has_flows: flows::flows_dir(root).is_dir(),
            has_logs: diagnostics::logs_dir(root).is_dir(),
            has_api_tools: api_tools::api_tools_dir(root).is_dir(),
        },
    }
}
