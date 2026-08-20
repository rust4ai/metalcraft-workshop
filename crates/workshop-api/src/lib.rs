//! Headless API layer for metalcraft-workshop.
//!
//! Wraps two interchangeable backends for a metalcraft-agent project:
//! a local filesystem directory ([`connection::LocalConnection`]) and a remote
//! REST endpoint served by `metalcraft-agent --api` ([`connection::RemoteConnection`]).
//! The Tauri crate is a thin wrapper that exposes this surface to the webview
//! via `#[tauri::command]` handlers and (for local mode) forwards file-watcher
//! events.

pub mod agents;
pub mod api_tools;
pub mod chat;
pub mod commands;
pub mod connection;
pub mod diagnostics;
pub mod flow_templates;
pub mod flows;
pub mod gateway;
pub mod integrations;
pub mod keys;
pub mod personas;
pub mod project;
pub mod skills;
pub mod watcher;

pub use agents::{
    AgentInstance, AgentPackManifest, AgentPackPreview, AgentPreset, AgentPresetDetail,
    AgentPresetSummary, ConsentSummary, InstalledAgentPack, InstallReport, InstanceDetail,
    InstanceMemory, InstancePatch, PackSource, RosterPersona, UninstallReport,
};
pub use api_tools::{ApiToolConfig, ApiToolSummary};
pub use chat::{ChatDetail, ChatEvent, ChatSummary, ChatWireMessage, RunFlowResult};
pub use commands::{FileKind, FrontendCommand, WorkshopEvent};
pub use connection::{LocalConnection, ProjectConnection, RemoteConnection};
pub use diagnostics::{ChatTimeline, DiagnosticsSessionSummary, TimelineEvent};
pub use flow_templates::{FlowTemplate, FlowTemplateSummary};
pub use gateway::{Channel, GatewayEvent};
pub use integrations::{PackDetail, PackSummary};
pub use keys::{KeyEntry, KeySummary, RecommendedKey};
pub use personas::{Persona, PersonaSummary};
pub use project::{ConnectionMode, ProjectLayout, ProjectSnapshot, scan_local};
pub use skills::{Skill, SkillSummary};
