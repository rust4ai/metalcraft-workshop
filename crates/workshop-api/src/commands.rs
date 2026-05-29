//! Wire-format enums shared between the Tauri command/event surface and the
//! frontend. The Tauri layer derives concrete handlers from these.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::api_tools::ApiToolConfig;
use crate::personas::Persona;
use crate::project::ProjectSnapshot;
use metalcraft_flows::SavedFlow;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FrontendCommand {
    OpenProject { path: PathBuf },
    OpenRemote { base_url: String, api_key: String },
    CloseProject,
    Refresh,
    PersonaSave { slug: String, persona: Persona },
    PersonaDelete { slug: String },
    SkillSave { slug: String, description: String, body: String },
    SkillDelete { slug: String },
    FlowSave { flow: SavedFlow },
    FlowDelete { id: String },
    ApiToolSave { name: String, config: ApiToolConfig },
    ApiToolDelete { name: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Persona,
    Skill,
    Flow,
    Diagnostics,
    ApiTool,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkshopEvent {
    ProjectOpened(ProjectSnapshot),
    ProjectClosed,
    Snapshot(ProjectSnapshot),
    FileChanged { path: PathBuf, kind: FileKind },
    SaveOk { kind: FileKind, id: String },
    Error { message: String },
}
