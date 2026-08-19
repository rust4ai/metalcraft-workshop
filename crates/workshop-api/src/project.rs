//! Project-level snapshot. A snapshot is the list of artifacts available in
//! whatever backing project the workshop is currently connected to — either a
//! local directory or a remote agent's REST API.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::agents::{self, AgentInstance, AgentPresetSummary};
use crate::api_tools::{self, ApiToolSummary};
use crate::diagnostics::{self, DiagnosticsSessionSummary};
use crate::flows;
use crate::keys::{self, KeySummary};
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
    #[serde(default)]
    pub keys: Vec<KeySummary>,
    /// What this pod can be. The chat entry point picks one of these, not a persona.
    #[serde(default)]
    pub agent_presets: Vec<AgentPresetSummary>,
    /// Agents that actually exist. Persistent ones only from the remote backend —
    /// every chat ever started mints an ephemeral instance, so an unfiltered list is
    /// one row per chat and pure noise.
    #[serde(default)]
    pub agent_instances: Vec<AgentInstance>,
    /// The preset a new chat gets if nobody chooses. Absent on an agent old enough
    /// to predate presets, where the persona picker is still the entry point.
    #[serde(default)]
    pub default_agent_preset: Option<String>,
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
    pub has_session_logs: bool,
    pub has_api_tools: bool,
    #[serde(default)]
    pub has_agent_presets: bool,
    #[serde(default)]
    pub has_agent_instances: bool,
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
        keys: keys::list(root),
        agent_presets: agents::list_presets(root),
        // Local mode has no TTL reaper running, so it shows what is on disk. That is
        // the honest answer for a directory you opened yourself.
        agent_instances: agents::list_instances(root),
        default_agent_preset: agents::list_presets(root)
            .iter()
            .map(|p| p.slug.clone())
            .find(|s| s == "general-agent")
            .or_else(|| agents::list_presets(root).first().map(|p| p.slug.clone())),
        layout: ProjectLayout {
            has_personas: personas::personas_dir(root).is_dir(),
            has_skills: skills::skills_dir(root).is_dir(),
            has_flows: flows::flows_dir(root).is_dir(),
            has_session_logs: diagnostics::logs_dir(root).is_dir(),
            has_api_tools: api_tools::api_tools_dir(root).is_dir(),
            has_agent_presets: agents::presets_dir(root).is_dir(),
            has_agent_instances: agents::instances_dir(root).is_dir(),
        },
    }
}
