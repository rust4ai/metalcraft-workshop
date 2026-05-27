//! Project-level snapshot: scans a metalcraft-agent directory and returns
//! summary lists for each of the four artifact types the workshop renders.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::diagnostics::{self, DiagnosticsSessionSummary};
use crate::flows;
use crate::personas::{self, PersonaSummary};
use crate::skills::{self, SkillSummary};

pub use metalcraft_flows::FlowSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSnapshot {
    pub root: PathBuf,
    pub personas: Vec<PersonaSummary>,
    pub skills: Vec<SkillSummary>,
    pub flows: Vec<FlowSummary>,
    pub sessions: Vec<DiagnosticsSessionSummary>,
    pub layout: ProjectLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectLayout {
    pub has_personas_dir: bool,
    pub has_skills_dir: bool,
    pub has_flows_dir: bool,
    pub has_logs_dir: bool,
}

pub fn scan_project(root: &Path) -> ProjectSnapshot {
    ProjectSnapshot {
        root: root.to_path_buf(),
        personas: personas::list(root),
        skills: skills::list(root),
        flows: flows::list(root),
        sessions: diagnostics::list_sessions(root),
        layout: ProjectLayout {
            has_personas_dir: personas::personas_dir(root).is_dir(),
            has_skills_dir: skills::skills_dir(root).is_dir(),
            has_flows_dir: flows::flows_dir(root).is_dir(),
            has_logs_dir: diagnostics::logs_dir(root).is_dir(),
        },
    }
}
