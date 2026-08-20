//! Connection abstraction over a metalcraft-agent project. Two implementations:
//!
//! - [`LocalConnection`] — operates on a project directory directly via
//!   filesystem I/O. The Tauri layer attaches a [`watcher`](crate::watcher)
//!   for this mode so frontend reloads on external edits.
//!
//! - [`RemoteConnection`] — talks HTTPS to a metalcraft-agent running in
//!   `--api` mode (see `metalcraft-agent/openapi/workshop-api.yaml`). Used as
//!   an "admin control connection" for agents running on another host.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::agents::{
    self, AgentInstance, AgentPackPreview, AgentPreset, AgentPresetDetail, AgentPresetSummary,
    FlowBinding, InstallReport, InstalledAgentPack, InstanceDetail, InstanceMemory, InstancePatch,
    PackSource, UninstallReport,
};
use crate::api_tools::{self, ApiToolConfig, ApiToolSummary};
use crate::chat::{self, ChatDetail, ChatEvent, ChatSummary, RunFlowResult};
use crate::diagnostics::{self, ChatTimeline, DiagnosticsSessionSummary};
use crate::flow_templates::{self, FlowTemplate, FlowTemplateSummary};
use crate::flows;
use crate::gateway::{Channel, GatewayEvent};
use crate::integrations::{IntegrationDetail, IntegrationSummary};
use crate::keys::{self, KeyEntry, KeySummary, RecommendedKey};
use crate::personas::{self, Persona};
use crate::project::{ConnectionMode, ProjectLayout, ProjectSnapshot};
use crate::skills::{self, Skill};
use futures_util::stream::Stream;
use metalcraft_flows::{SavedFlow, ValidationError};
use std::pin::Pin;

/// Identity/version of the connected agent, surfaced in the Workshop's
/// Settings tab. `version` is `None` in local mode (no agent process) or when
/// talking to an agent old enough to predate the `/api/v1/info` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentInfo {
    pub name: Option<String>,
    pub version: Option<String>,
    /// Persona the Workshop's New Chat modal defaults to. `None` for local mode
    /// or an agent old enough to predate the field.
    #[serde(default)]
    pub default_persona: Option<String>,
}

/// A scheduled follow-up, as returned by the agent's `/api/v1/scheduled-tasks`.
/// Timestamps arrive as RFC3339 strings (the agent stores `DateTime<Utc>`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    #[serde(default)]
    pub chat_id: Option<String>,
    pub run_at: String,
    pub created_at: String,
    pub task: String,
    #[serde(default)]
    pub persona: Option<String>,
    pub status: String,
}

/// What a new chat is being started as.
///
/// Every field is optional because the agent has a defensible default for each: the
/// default preset, that preset's default persona, a freshly minted instance. Passing
/// nothing at all reproduces the pre-preset behaviour exactly.
#[derive(Debug, Clone, Default, Serialize)]
pub struct NewChat<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_preset: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_slug: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'a str>,
}

#[async_trait]
pub trait ProjectConnection: Send + Sync {
    fn mode(&self) -> ConnectionMode;
    /// Filesystem root if this is a local connection. None for remote.
    fn local_root(&self) -> Option<&Path> {
        None
    }

    async fn snapshot(&self) -> anyhow::Result<ProjectSnapshot>;

    /// Identity/version of the agent behind this connection. Local mode has no
    /// agent process, so the default returns an empty [`AgentInfo`]; the remote
    /// impl fetches `GET /api/v1/info`.
    async fn agent_info(&self) -> anyhow::Result<AgentInfo> {
        Ok(AgentInfo::default())
    }

    async fn get_persona(&self, slug: &str) -> anyhow::Result<Persona>;
    async fn save_persona(&self, slug: &str, persona: &Persona) -> anyhow::Result<()>;
    async fn delete_persona(&self, slug: &str) -> anyhow::Result<()>;

    async fn get_skill(&self, slug: &str) -> anyhow::Result<Skill>;
    async fn save_skill(&self, slug: &str, description: &str, body: &str) -> anyhow::Result<()>;
    async fn delete_skill(&self, slug: &str) -> anyhow::Result<()>;

    async fn get_flow(&self, id: &str) -> anyhow::Result<SavedFlow>;
    async fn save_flow(&self, flow: &SavedFlow) -> anyhow::Result<Vec<ValidationError>>;
    async fn delete_flow(&self, id: &str) -> anyhow::Result<bool>;

    async fn list_diagnostics(&self) -> anyhow::Result<Vec<DiagnosticsSessionSummary>>;
    async fn load_diagnostics(&self, id: &str) -> anyhow::Result<ChatTimeline>;

    async fn list_api_tools(&self) -> anyhow::Result<Vec<ApiToolSummary>>;
    async fn get_api_tool(&self, name: &str) -> anyhow::Result<ApiToolConfig>;
    async fn save_api_tool(&self, name: &str, config: &ApiToolConfig) -> anyhow::Result<()>;
    async fn delete_api_tool(&self, name: &str) -> anyhow::Result<()>;

    async fn list_keys(&self) -> anyhow::Result<Vec<KeyEntry>>;
    /// Upsert a key. `channel_id` targets a channel's secret scope; `None` is global.
    async fn save_key(&self, name: &str, value: &str, channel_id: Option<&str>) -> anyhow::Result<()>;
    /// Delete a key. `channel_id` targets a channel's secret scope; `None` is global.
    async fn delete_key(&self, name: &str, channel_id: Option<&str>) -> anyhow::Result<()>;
    /// Reveal a key's raw value. `channel_id` targets a channel's secret scope.
    async fn reveal_key(&self, name: &str, channel_id: Option<&str>) -> anyhow::Result<String>;

    /// Keys that enabled integrations declare they need. Remote-only —
    /// pack state lives on the agent, so local mode returns an empty list.
    async fn list_recommended_keys(&self) -> anyhow::Result<Vec<RecommendedKey>>;

    // Flow templates — readable in both modes; the workshop offers them when
    // the user creates a new flow.
    async fn list_flow_templates(&self) -> anyhow::Result<Vec<FlowTemplateSummary>>;
    async fn get_flow_template(&self, slug: &str) -> anyhow::Result<FlowTemplate>;

    // Runtime — remote-only because they invoke the agent process. Local
    // returns an explanatory error.
    async fn run_flow(
        &self,
        id: &str,
        persona_slug: Option<&str>,
        model_name: Option<&str>,
        inputs: Option<serde_json::Value>,
    ) -> anyhow::Result<RunFlowResult>;

    /// Resume a paused v2 flow run by supplying a handle (an approval decision,
    /// or `"after"` for a wait) and optional `_last` data.
    async fn resume_flow_run(
        &self,
        run_id: &str,
        handle: &str,
        data: Option<serde_json::Value>,
    ) -> anyhow::Result<RunFlowResult>;

    /// Fetch one persisted flow run (status / pause info / steps / variables).
    async fn get_flow_run(&self, run_id: &str) -> anyhow::Result<serde_json::Value>;

    /// List persisted flow runs, optionally filtered by flow id.
    async fn list_flow_runs(
        &self,
        flow_id: Option<&str>,
    ) -> anyhow::Result<Vec<serde_json::Value>>;

    // ---- Agents ----
    //
    // Presets are readable in both modes — they are files, like personas. Instances
    // are readable locally too, but only the agent can *mint* one, because minting
    // is bound up with memory layout it owns.

    async fn list_agent_presets(&self) -> anyhow::Result<Vec<AgentPresetSummary>>;
    async fn get_agent_preset(&self, slug: &str) -> anyhow::Result<AgentPresetDetail>;
    async fn save_agent_preset(&self, slug: &str, preset: &AgentPreset) -> anyhow::Result<()>;
    async fn delete_agent_preset(&self, slug: &str) -> anyhow::Result<()>;

    async fn list_agent_instances(&self) -> anyhow::Result<Vec<AgentInstance>>;
    async fn get_agent_instance(&self, id: &str) -> anyhow::Result<InstanceDetail>;
    async fn create_agent_instance(
        &self,
        agent_preset: Option<&str>,
        name: Option<&str>,
    ) -> anyhow::Result<AgentInstance>;
    async fn patch_agent_instance(
        &self,
        id: &str,
        patch: &InstancePatch,
    ) -> anyhow::Result<AgentInstance>;
    /// Returns how many conversations were kept — deleting an agent must not lose
    /// transcripts, and the dialog should be able to say so.
    async fn delete_agent_instance(&self, id: &str) -> anyhow::Result<usize>;
    async fn agent_instance_memory(
        &self,
        id: &str,
        limit: Option<usize>,
    ) -> anyhow::Result<InstanceMemory>;

    // ---- Flow bindings ----
    //
    // Which agent a flow runs as, and which agent instance each of its schedules
    // actually runs as once armed. Arming is the second consent moment — the first
    // being install — and the sharper one, because a scheduled flow acts while
    // nobody is watching.

    async fn flow_binding(&self, flow_id: &str) -> anyhow::Result<FlowBinding>;
    async fn bind_flow_preset(
        &self,
        flow_id: &str,
        agent_preset: Option<&str>,
    ) -> anyhow::Result<FlowBinding>;
    /// Arm a schedule, minting the agent it runs as — or attaching to an existing
    /// one, which is how you get a briefer that knows what you discussed yesterday.
    async fn arm_schedule(
        &self,
        flow_id: &str,
        schedule_id: &str,
        instance_id: Option<&str>,
    ) -> anyhow::Result<AgentInstance>;
    /// Disarm. The agent and everything it learned survive; re-arming reuses it.
    async fn disarm_schedule(
        &self,
        flow_id: &str,
        schedule_id: &str,
    ) -> anyhow::Result<FlowBinding>;

    // ---- Agent packs ----
    //
    // Installing is remote-only: it writes into the pod's content store and rebuilds
    // its memory index. A local directory can be *read* for what is installed, but
    // there is nothing there to install into.

    async fn list_agent_packs(&self) -> anyhow::Result<Vec<InstalledAgentPack>>;
    async fn get_agent_pack(&self, id: &str) -> anyhow::Result<InstalledAgentPack>;
    /// Origins this pod will download a pack from, so a UI can say what it accepts
    /// before someone pastes a link and gets refused.
    async fn agent_pack_registries(&self) -> anyhow::Result<Vec<String>>;
    /// What installing would grant — **without installing**. The install dialog's
    /// reason to exist: showing a permission summary after the fact is not consent.
    async fn inspect_agent_pack(&self, source: &PackSource) -> anyhow::Result<AgentPackPreview>;
    async fn install_agent_pack(&self, source: &PackSource) -> anyhow::Result<InstallReport>;
    async fn uninstall_agent_pack(
        &self,
        id: &str,
        force: bool,
    ) -> anyhow::Result<UninstallReport>;
    /// Package one of this pod's own presets as a distributable archive.
    async fn export_agent_pack(&self, preset: &str, version: &str) -> anyhow::Result<Vec<u8>>;

    async fn list_chats(&self) -> anyhow::Result<Vec<ChatSummary>>;
    async fn get_chat(&self, id: &str) -> anyhow::Result<ChatDetail>;
    /// Start a chat.
    ///
    /// `agent_preset` is the thing a person picks; `persona_slug` is the Advanced
    /// escape hatch and must be inside that preset's roster (the agent enforces it).
    /// `instance_id` continues an existing agent instead of minting a new one.
    async fn create_chat(
        &self,
        req: &NewChat<'_>,
    ) -> anyhow::Result<ChatSummary>;
    async fn delete_chat(&self, id: &str) -> anyhow::Result<()>;

    /// Start a turn: send a user message and stream back agent events until
    /// the executor returns. Each item is one decoded SSE event.
    async fn chat_turn(
        &self,
        id: &str,
        message: &str,
    ) -> anyhow::Result<Pin<Box<dyn Stream<Item = anyhow::Result<ChatEvent>> + Send>>>;

    /// Subscribe to a chat's *agent-initiated* turns (scheduled follow-ups the
    /// daemon fires while no user turn is in flight). Long-lived SSE stream;
    /// each item is one decoded event, same wire shape as `chat_turn`.
    async fn subscribe_chat_events(
        &self,
        id: &str,
    ) -> anyhow::Result<Pin<Box<dyn Stream<Item = anyhow::Result<ChatEvent>> + Send>>>;

    /// List scheduled follow-ups (pending + recent), newest first.
    async fn list_scheduled_tasks(&self) -> anyhow::Result<Vec<ScheduledTask>>;
    /// Cancel a pending scheduled follow-up.
    async fn cancel_scheduled_task(&self, id: &str) -> anyhow::Result<()>;

    // Integrations — remote-only. Pack state is managed by the agent
    // process (lives in `<data>/integrations.json`), not the workshop.
    async fn list_integrations(&self) -> anyhow::Result<Vec<IntegrationSummary>>;
    async fn get_integration(&self, id: &str) -> anyhow::Result<IntegrationDetail>;
    async fn set_pack_enabled(&self, id: &str, enabled: bool) -> anyhow::Result<()>;
    /// Install a pack from the registry, optionally pinning a version and/or a
    /// content hash. Returns the installed [`IntegrationSummary`] (enabled + pinned).
    async fn install_pack(
        &self,
        slug: &str,
        version: Option<&str>,
        content_sha256: Option<&str>,
    ) -> anyhow::Result<IntegrationSummary>;
    /// Uninstall a pack. Returns `UninstallPackResult` (`dependent_flows` /
    /// `dependent_personas` that still reference it) as raw JSON.
    async fn uninstall_pack(&self, id: &str) -> anyhow::Result<serde_json::Value>;

    // Flow install-from-registry + dependency install — remote-only.
    /// Install a flow from the registry by slug. Returns `InstallResult`
    /// (`{ flow, dependencies }`) as raw JSON.
    async fn install_flow(&self, slug: &str) -> anyhow::Result<serde_json::Value>;
    /// Install the packs a flow's `requires` block declares. Returns
    /// `{ flow, packs: [PackInstallOutcome] }` as raw JSON.
    async fn install_flow_dependencies(&self, id: &str) -> anyhow::Result<serde_json::Value>;

    // Lockfile (reproducible rebuild) — remote-only.
    /// Fetch the agent's `metalcraft.lock` (pinned packs + flows) as raw JSON.
    async fn get_lockfile(&self) -> anyhow::Result<serde_json::Value>;
    /// Reinstall every pinned pack then flow at its locked version. Returns
    /// `{ outcomes: [RestoreOutcome] }` as raw JSON.
    async fn restore_lockfile(&self) -> anyhow::Result<serde_json::Value>;

    // Gateway activity feed — remote-only. Recent inbound/outbound across all
    // channels, incl. unrouted inbound.
    async fn list_gateway_activity(&self) -> anyhow::Result<Vec<GatewayEvent>>;

    // Channels — the simple {slug, name, url, secret} connection model. The
    // built-in `metalcraft` channel is always listed (read-only); customs carry
    // their own url + secret (secret kept in the agent's scoped key store).
    async fn list_channels(&self) -> anyhow::Result<Vec<Channel>>;
    async fn channel_events(&self, slug: &str) -> anyhow::Result<Vec<GatewayEvent>>;
    async fn create_channel(&self, name: &str, url: &str, secret: &str) -> anyhow::Result<Channel>;
    async fn update_channel(
        &self,
        slug: &str,
        name: &str,
        url: &str,
        enabled: bool,
        secret: Option<&str>,
    ) -> anyhow::Result<Channel>;
    async fn delete_channel(&self, slug: &str) -> anyhow::Result<()>;

    // Metalcraft Gateway zero-copy connect (JSON passthrough).
    async fn gateway_metalcraft_status(&self) -> anyhow::Result<serde_json::Value>;
    async fn gateway_metalcraft_register(&self, phone_number: &str) -> anyhow::Result<serde_json::Value>;
    async fn gateway_metalcraft_connect(&self, webhook_base: Option<String>) -> anyhow::Result<serde_json::Value>;
}

// ─── Local ──────────────────────────────────────────────────────────────────

pub struct LocalConnection {
    root: PathBuf,
}

impl LocalConnection {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

#[async_trait]
impl ProjectConnection for LocalConnection {
    fn mode(&self) -> ConnectionMode {
        ConnectionMode::Local
    }

    fn local_root(&self) -> Option<&Path> {
        Some(&self.root)
    }

    async fn snapshot(&self) -> anyhow::Result<ProjectSnapshot> {
        let root = self.root.clone();
        Ok(tokio::task::spawn_blocking(move || crate::project::scan_local(&root)).await?)
    }

    async fn get_persona(&self, slug: &str) -> anyhow::Result<Persona> {
        personas::load(&self.root, slug)
    }
    async fn save_persona(&self, slug: &str, persona: &Persona) -> anyhow::Result<()> {
        personas::save(&self.root, slug, persona)
    }
    async fn delete_persona(&self, slug: &str) -> anyhow::Result<()> {
        personas::delete(&self.root, slug)
    }

    async fn get_skill(&self, slug: &str) -> anyhow::Result<Skill> {
        skills::load(&self.root, slug)
    }
    async fn save_skill(&self, slug: &str, description: &str, body: &str) -> anyhow::Result<()> {
        skills::save(&self.root, slug, description, body)
    }
    async fn delete_skill(&self, slug: &str) -> anyhow::Result<()> {
        skills::delete(&self.root, slug)
    }

    async fn get_flow(&self, id: &str) -> anyhow::Result<SavedFlow> {
        flows::load(&self.root, id)
    }
    async fn save_flow(&self, flow: &SavedFlow) -> anyhow::Result<Vec<ValidationError>> {
        flows::save(&self.root, flow)
    }
    async fn delete_flow(&self, id: &str) -> anyhow::Result<bool> {
        Ok(flows::delete(&self.root, id))
    }

    async fn list_diagnostics(&self) -> anyhow::Result<Vec<DiagnosticsSessionSummary>> {
        Ok(diagnostics::list_sessions(&self.root))
    }
    async fn load_diagnostics(&self, id: &str) -> anyhow::Result<ChatTimeline> {
        diagnostics::load_session(&self.root, id)
    }

    async fn list_api_tools(&self) -> anyhow::Result<Vec<ApiToolSummary>> {
        Ok(api_tools::list(&self.root))
    }
    async fn get_api_tool(&self, name: &str) -> anyhow::Result<ApiToolConfig> {
        api_tools::load(&self.root, name)
    }
    async fn save_api_tool(&self, name: &str, config: &ApiToolConfig) -> anyhow::Result<()> {
        api_tools::save(&self.root, name, config)
    }
    async fn delete_api_tool(&self, name: &str) -> anyhow::Result<()> {
        api_tools::delete(&self.root, name)
    }

    async fn list_keys(&self) -> anyhow::Result<Vec<KeyEntry>> {
        Ok(keys::list_entries(&self.root))
    }
    async fn save_key(&self, name: &str, value: &str, channel_id: Option<&str>) -> anyhow::Result<()> {
        keys::save(&self.root, name, value, channel_id)
    }
    async fn delete_key(&self, name: &str, channel_id: Option<&str>) -> anyhow::Result<()> {
        keys::delete(&self.root, name, channel_id)
    }
    async fn reveal_key(&self, name: &str, channel_id: Option<&str>) -> anyhow::Result<String> {
        keys::reveal(&self.root, name, channel_id)
    }
    async fn list_recommended_keys(&self) -> anyhow::Result<Vec<RecommendedKey>> {
        // Recommendations are derived from enabled packs, which live on the
        // agent — local projects have nothing to recommend.
        Ok(Vec::new())
    }

    async fn list_flow_templates(&self) -> anyhow::Result<Vec<FlowTemplateSummary>> {
        Ok(flow_templates::list(&self.root))
    }
    async fn get_flow_template(&self, slug: &str) -> anyhow::Result<FlowTemplate> {
        flow_templates::load(&self.root, slug)
    }

    async fn run_flow(
        &self,
        _id: &str,
        _persona_slug: Option<&str>,
        _model_name: Option<&str>,
        _inputs: Option<serde_json::Value>,
    ) -> anyhow::Result<RunFlowResult> {
        Err(chat::not_supported_in_local_mode("Run flow"))
    }
    async fn resume_flow_run(
        &self,
        _run_id: &str,
        _handle: &str,
        _data: Option<serde_json::Value>,
    ) -> anyhow::Result<RunFlowResult> {
        Err(chat::not_supported_in_local_mode("Resume flow run"))
    }
    async fn get_flow_run(&self, _run_id: &str) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Flow run status"))
    }
    async fn list_flow_runs(
        &self,
        _flow_id: Option<&str>,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        Err(chat::not_supported_in_local_mode("List flow runs"))
    }
    // Presets and instances are files, so a local directory can answer for them —
    // which matters, because the desktop app's local mode is a real way to inspect a
    // pod's data dir without the agent running.
    async fn list_agent_presets(&self) -> anyhow::Result<Vec<AgentPresetSummary>> {
        Ok(agents::list_presets(&self.root))
    }
    async fn get_agent_preset(&self, slug: &str) -> anyhow::Result<AgentPresetDetail> {
        agents::load_preset_detail(&self.root, slug)
    }
    async fn save_agent_preset(&self, slug: &str, preset: &AgentPreset) -> anyhow::Result<()> {
        agents::save_preset(&self.root, slug, preset)
    }
    async fn delete_agent_preset(&self, slug: &str) -> anyhow::Result<()> {
        agents::delete_preset(&self.root, slug)
    }

    async fn list_agent_instances(&self) -> anyhow::Result<Vec<AgentInstance>> {
        Ok(agents::list_instances(&self.root))
    }
    async fn get_agent_instance(&self, id: &str) -> anyhow::Result<InstanceDetail> {
        Ok(InstanceDetail {
            instance: agents::load_instance(&self.root, id)?,
            // Conversations and schedules live behind the agent's own indexes, not in
            // a file this reader can walk. Empty is honest; inventing them would not be.
            conversations: Vec::new(),
            scheduled: Vec::new(),
        })
    }
    async fn create_agent_instance(
        &self,
        _agent_preset: Option<&str>,
        _name: Option<&str>,
    ) -> anyhow::Result<AgentInstance> {
        // Minting an agent allocates its memory layers, which is the agent's job.
        Err(chat::not_supported_in_local_mode("Creating an agent"))
    }
    async fn patch_agent_instance(
        &self,
        _id: &str,
        _patch: &InstancePatch,
    ) -> anyhow::Result<AgentInstance> {
        Err(chat::not_supported_in_local_mode("Renaming an agent"))
    }
    async fn delete_agent_instance(&self, _id: &str) -> anyhow::Result<usize> {
        Err(chat::not_supported_in_local_mode("Deleting an agent"))
    }
    async fn flow_binding(&self, _flow_id: &str) -> anyhow::Result<FlowBinding> {
        // The binding is a file, but the consent summary it carries is derived from
        // the pack store at request time and the memory base is the agent's — so
        // half an answer here would be worse than none.
        Err(chat::not_supported_in_local_mode("Flow bindings"))
    }
    async fn bind_flow_preset(
        &self,
        _flow_id: &str,
        _agent_preset: Option<&str>,
    ) -> anyhow::Result<FlowBinding> {
        Err(chat::not_supported_in_local_mode("Binding a flow to an agent"))
    }
    async fn arm_schedule(
        &self,
        _flow_id: &str,
        _schedule_id: &str,
        _instance_id: Option<&str>,
    ) -> anyhow::Result<AgentInstance> {
        // Arming mints an agent and allocates its memory layers, which is the
        // agent's job, not a file writer's.
        Err(chat::not_supported_in_local_mode("Arming a schedule"))
    }
    async fn disarm_schedule(
        &self,
        _flow_id: &str,
        _schedule_id: &str,
    ) -> anyhow::Result<FlowBinding> {
        Err(chat::not_supported_in_local_mode("Disarming a schedule"))
    }

    async fn agent_instance_memory(
        &self,
        _id: &str,
        _limit: Option<usize>,
    ) -> anyhow::Result<InstanceMemory> {
        // Recall is a runtime concern — the index is the agent's, not a file.
        Err(chat::not_supported_in_local_mode("Agent memory"))
    }

    async fn list_agent_packs(&self) -> anyhow::Result<Vec<InstalledAgentPack>> {
        Ok(agents::list_installed_packs(&self.root))
    }
    async fn get_agent_pack(&self, id: &str) -> anyhow::Result<InstalledAgentPack> {
        agents::list_installed_packs(&self.root)
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| anyhow::anyhow!("agent pack '{id}' is not installed"))
    }
    async fn agent_pack_registries(&self) -> anyhow::Result<Vec<String>> {
        // A directory has no opinion about registries; it just holds what was
        // installed. Empty means "this backend cannot download", which the UI reads
        // as "upload a file instead".
        Ok(Vec::new())
    }
    async fn inspect_agent_pack(&self, _source: &PackSource) -> anyhow::Result<AgentPackPreview> {
        Err(chat::not_supported_in_local_mode("Inspecting an agent pack"))
    }
    async fn install_agent_pack(&self, _source: &PackSource) -> anyhow::Result<InstallReport> {
        Err(chat::not_supported_in_local_mode("Installing an agent pack"))
    }
    async fn uninstall_agent_pack(
        &self,
        _id: &str,
        _force: bool,
    ) -> anyhow::Result<UninstallReport> {
        Err(chat::not_supported_in_local_mode("Uninstalling an agent pack"))
    }
    async fn export_agent_pack(&self, _preset: &str, _version: &str) -> anyhow::Result<Vec<u8>> {
        Err(chat::not_supported_in_local_mode("Exporting an agent pack"))
    }

    async fn list_chats(&self) -> anyhow::Result<Vec<ChatSummary>> {
        Err(chat::not_supported_in_local_mode("Chat"))
    }
    async fn get_chat(&self, _id: &str) -> anyhow::Result<ChatDetail> {
        Err(chat::not_supported_in_local_mode("Chat"))
    }
    async fn create_chat(&self, _req: &NewChat<'_>) -> anyhow::Result<ChatSummary> {
        Err(chat::not_supported_in_local_mode("Chat"))
    }
    async fn delete_chat(&self, _id: &str) -> anyhow::Result<()> {
        Err(chat::not_supported_in_local_mode("Chat"))
    }
    async fn chat_turn(
        &self,
        _id: &str,
        _message: &str,
    ) -> anyhow::Result<Pin<Box<dyn Stream<Item = anyhow::Result<ChatEvent>> + Send>>> {
        Err(chat::not_supported_in_local_mode("Chat"))
    }
    async fn subscribe_chat_events(
        &self,
        _id: &str,
    ) -> anyhow::Result<Pin<Box<dyn Stream<Item = anyhow::Result<ChatEvent>> + Send>>> {
        Err(chat::not_supported_in_local_mode("Chat events"))
    }
    async fn list_scheduled_tasks(&self) -> anyhow::Result<Vec<ScheduledTask>> {
        // Scheduled follow-ups live on the agent; local mode has none.
        Ok(Vec::new())
    }
    async fn cancel_scheduled_task(&self, _id: &str) -> anyhow::Result<()> {
        Err(chat::not_supported_in_local_mode("Scheduled tasks"))
    }

    async fn list_integrations(&self) -> anyhow::Result<Vec<IntegrationSummary>> {
        Err(chat::not_supported_in_local_mode("Integrations"))
    }
    async fn get_integration(&self, _id: &str) -> anyhow::Result<IntegrationDetail> {
        Err(chat::not_supported_in_local_mode("Integrations"))
    }
    async fn set_pack_enabled(&self, _id: &str, _enabled: bool) -> anyhow::Result<()> {
        Err(chat::not_supported_in_local_mode("Integrations"))
    }
    async fn install_pack(
        &self,
        _slug: &str,
        _version: Option<&str>,
        _content_sha256: Option<&str>,
    ) -> anyhow::Result<IntegrationSummary> {
        Err(chat::not_supported_in_local_mode("Integrations"))
    }
    async fn uninstall_pack(&self, _id: &str) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Integrations"))
    }
    async fn install_flow(&self, _slug: &str) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Install flow"))
    }
    async fn install_flow_dependencies(&self, _id: &str) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Install flow dependencies"))
    }
    async fn get_lockfile(&self) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Lockfile"))
    }
    async fn restore_lockfile(&self) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Lockfile"))
    }

    async fn list_gateway_activity(&self) -> anyhow::Result<Vec<GatewayEvent>> {
        Err(chat::not_supported_in_local_mode("Gateway activity"))
    }
    async fn list_channels(&self) -> anyhow::Result<Vec<Channel>> {
        Err(chat::not_supported_in_local_mode("Channels"))
    }
    async fn channel_events(&self, _slug: &str) -> anyhow::Result<Vec<GatewayEvent>> {
        Err(chat::not_supported_in_local_mode("Channels"))
    }
    async fn create_channel(&self, _name: &str, _url: &str, _secret: &str) -> anyhow::Result<Channel> {
        Err(chat::not_supported_in_local_mode("Channels"))
    }
    async fn update_channel(
        &self,
        _slug: &str,
        _name: &str,
        _url: &str,
        _enabled: bool,
        _secret: Option<&str>,
    ) -> anyhow::Result<Channel> {
        Err(chat::not_supported_in_local_mode("Channels"))
    }
    async fn delete_channel(&self, _slug: &str) -> anyhow::Result<()> {
        Err(chat::not_supported_in_local_mode("Channels"))
    }
    async fn gateway_metalcraft_status(&self) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn gateway_metalcraft_register(&self, _phone_number: &str) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn gateway_metalcraft_connect(&self, _webhook_base: Option<String>) -> anyhow::Result<serde_json::Value> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
}

// ─── Remote ─────────────────────────────────────────────────────────────────

pub struct RemoteConnection {
    base_url: String,
    /// The Bearer credential, held behind a lock so a background task can swap it
    /// out. For a static key (self-hosted `WORKSHOP_API_KEY`, manual entry) it
    /// never changes; for an OIDC connection token it is re-minted before expiry
    /// by whoever else holds a clone of this `Arc` (see [`with_shared_token`]).
    api_key: std::sync::Arc<std::sync::RwLock<String>>,
    client: reqwest::Client,
    /// Separate client for the long-lived SSE endpoints (`chat_turn`,
    /// `subscribe_chat_events`) with idle-connection reuse disabled. A new chat's
    /// first turn is usually the first activity after an idle spell, so the
    /// shared pooled `client` would often reuse a keep-alive socket the pod/LB
    /// already closed — the read fails instantly and the desktop shows a spurious
    /// "live connection lost — restored from saved state". These requests are
    /// infrequent and run for seconds, so a fresh handshake each time is
    /// negligible; CRUD calls keep the pooled `client`.
    stream_client: reqwest::Client,
}

impl RemoteConnection {
    /// Connect with a fixed Bearer key that never changes (self-hosted agents in
    /// `--api <KEY>` mode, or a manually-entered key).
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> anyhow::Result<Self> {
        Self::build(base_url, std::sync::Arc::new(std::sync::RwLock::new(api_key.into())))
    }

    /// Connect with a refreshable Bearer token. The caller keeps a clone of
    /// `token` and re-mints it (e.g. an audience-scoped Metalcraft ID connection
    /// token nearing its 1h expiry); every request reads the current value.
    pub fn with_shared_token(
        base_url: impl Into<String>,
        token: std::sync::Arc<std::sync::RwLock<String>>,
    ) -> anyhow::Result<Self> {
        Self::build(base_url, token)
    }

    fn build(
        base_url: impl Into<String>,
        api_key: std::sync::Arc<std::sync::RwLock<String>>,
    ) -> anyhow::Result<Self> {
        let raw = base_url.into();
        let trimmed = raw.trim().trim_end_matches('/');
        if trimmed.is_empty() {
            anyhow::bail!("base URL is empty");
        }
        // Require an explicit scheme so reqwest gives a clean error instead of
        // a confusing relative-URL panic when the user types e.g.
        // `localhost:3002` without `http://`.
        if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            anyhow::bail!("base URL must start with http:// or https://");
        }
        // Bound connection establishment, but NOT total request time. The
        // `chat_turn` endpoint streams Server-Sent Events for the entire length
        // of an agent turn, which can run for minutes when the LLM calls a slow
        // tool (e.g. `solarabase_retrieve` making its own external HTTP request).
        // A client-wide `.timeout()` aborts that stream mid-flight at the deadline
        // — surfacing as reqwest's opaque "error decoding response body" — even
        // though the turn completes and persists fine server-side. The quick CRUD
        // calls stay bounded via a per-request timeout on the helpers below.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()?;
        // Streaming client: same connect bound, but no idle-connection pooling so
        // a turn never rides a stale keep-alive socket (see `stream_client`).
        let stream_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .pool_max_idle_per_host(0)
            .build()?;
        Ok(Self {
            base_url: trimmed.to_string(),
            api_key,
            client,
            stream_client,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// The current Bearer value. Cloned per request so the lock isn't held across
    /// the await; a poisoned lock still yields the last-written token.
    fn bearer(&self) -> String {
        self.api_key.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Hard cap for the non-streaming CRUD calls. The streaming `chat_turn`
    /// request deliberately does NOT go through these helpers (see its note).
    const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .get(self.url(path))
            .bearer_auth(self.bearer())
            .timeout(Self::REQUEST_TIMEOUT)
    }
    fn put(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .put(self.url(path))
            .bearer_auth(self.bearer())
            .timeout(Self::REQUEST_TIMEOUT)
    }
    fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .delete(self.url(path))
            .bearer_auth(self.bearer())
            .timeout(Self::REQUEST_TIMEOUT)
    }
    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(self.url(path))
            .bearer_auth(self.bearer())
            .timeout(Self::REQUEST_TIMEOUT)
    }
    fn patch(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .patch(self.url(path))
            .bearer_auth(self.bearer())
            .timeout(Self::REQUEST_TIMEOUT)
    }

    /// Build the POST for an agent-pack source. Shared by inspect and install so the
    /// two cannot address different things.
    ///
    /// Uploading gets a longer timeout: an archive can be tens of megabytes over a
    /// home connection, and the default is tuned for JSON.
    fn pack_request(&self, path: &str, source: &PackSource) -> reqwest::RequestBuilder {
        const UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
        match source {
            PackSource::Url(url) => self
                .post(&format!("{path}?url={}", urlencode(url)))
                .timeout(UPLOAD_TIMEOUT),
            PackSource::Path(p) => self
                .post(&format!("{path}?path={}", urlencode(p)))
                // Reading and unpacking a large archive on the pod takes as long as
                // uploading one; the JSON-tuned default aborted at 30s while the pod
                // was still working.
                .timeout(UPLOAD_TIMEOUT),
            PackSource::Bytes(bytes) => self
                .post(path)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(bytes.clone())
                .timeout(UPLOAD_TIMEOUT),
        }
    }
}

/// Percent-encode one path segment or query value.
///
/// Small on purpose: the alternative is a URL crate. It matters in two ways — a pack
/// URL containing `&` would be truncated into a *different* URL than the one the user
/// approved, and an id containing `/`, `?` or `#` addresses a different endpoint than
/// the caller meant. Agent-pack ids come from an author-controlled manifest, so that
/// second case is reachable from a downloaded pack.
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Deserialize)]
struct ApiError {
    error: String,
}

async fn ok_or_err(resp: reqwest::Response, action: &str) -> anyhow::Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let msg = match resp.json::<ApiError>().await {
        Ok(e) => e.error,
        Err(_) => format!("HTTP {} from {}", status, action),
    };
    anyhow::bail!("{action}: {msg}")
}

/// Deserialize a response body, but on failure include serde's actual error
/// (which field, what was expected) plus a snippet of the raw body — and echo
/// it to stderr so it shows up in the console. Replaces bare `resp.json()?`,
/// whose error collapses to the useless "error decoding response body".
async fn decode_json<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    action: &str,
) -> anyhow::Result<T> {
    let body = resp.text().await?;
    match serde_json::from_str::<T>(&body) {
        Ok(value) => Ok(value),
        Err(err) => {
            let snippet: String = body.chars().take(800).collect();
            eprintln!(
                "[workshop-api] failed to decode {action} response: {err}\n  body: {snippet}"
            );
            anyhow::bail!("decoding {action} response failed: {err}")
        }
    }
}

/// Wire shape returned by `GET /api/v1/snapshot` on the agent. Mirrors
/// `ProjectSnapshot` in `metalcraft-agent/src/workshop_api.rs`.
#[derive(Deserialize)]
struct RemoteSnapshot {
    personas: Vec<personas::PersonaSummary>,
    skills: Vec<skills::SkillSummary>,
    flows: Vec<metalcraft_flows::FlowSummary>,
    sessions: Vec<diagnostics::DiagnosticsSessionSummary>,
    api_tools: Vec<ApiToolSummary>,
    #[serde(default)]
    keys: Vec<KeySummary>,
    #[serde(default)]
    agent_presets: Vec<agents::AgentPresetSummary>,
    #[serde(default)]
    agent_instances: Vec<agents::AgentInstance>,
    #[serde(default)]
    default_agent_preset: Option<String>,
    layout: RemoteLayout,
}

#[derive(Deserialize)]
struct RemoteLayout {
    #[allow(dead_code)]
    data_dir: String,
    personas_dir: String,
    skills_dir: String,
    flows_dir: String,
    sessions_dir: String,
    api_tools_dir: String,
    /// Absent on an agent that predates presets — which is exactly what the
    /// `has_agent_presets` flag below is for.
    #[serde(default)]
    agent_presets_dir: String,
    #[serde(default)]
    agent_instances_dir: String,
}

/// Wire shape returned by `GET /api/v1/diagnostics/{id}`: a flat list of
/// `{kind, file, data}` entries that we re-parse into the workshop's tagged
/// [`TimelineEvent`] union (identical logic to the local file walker in
/// [`crate::diagnostics::load_session`]).
#[derive(Deserialize)]
struct RemoteDiagnosticsSession {
    #[allow(dead_code)]
    id: String,
    session_info: Option<diagnostics::SessionInfo>,
    timeline: Vec<RemoteTimelineEntry>,
}

#[derive(Deserialize)]
struct RemoteTimelineEntry {
    #[allow(dead_code)]
    kind: String,
    file: String,
    data: serde_json::Value,
}

#[derive(Serialize)]
struct PutSkillBody<'a> {
    slug: &'a str,
    description: &'a str,
    body: &'a str,
}

#[derive(Serialize)]
struct PutKeyBody<'a> {
    value: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_id: Option<&'a str>,
}

#[derive(Deserialize)]
struct RevealKeyResponse {
    value: String,
}

#[async_trait]
impl ProjectConnection for RemoteConnection {
    fn mode(&self) -> ConnectionMode {
        ConnectionMode::Remote
    }

    async fn snapshot(&self) -> anyhow::Result<ProjectSnapshot> {
        let resp = ok_or_err(self.get("/api/v1/snapshot").send().await?, "GET /snapshot").await?;
        let snap: RemoteSnapshot = decode_json(resp, "GET /snapshot").await?;
        Ok(ProjectSnapshot {
            root: self.base_url.clone(),
            mode: ConnectionMode::Remote,
            personas: snap.personas,
            skills: snap.skills,
            flows: snap.flows,
            sessions: snap.sessions,
            api_tools: snap.api_tools,
            keys: snap.keys,
            agent_presets: snap.agent_presets,
            agent_instances: snap.agent_instances,
            default_agent_preset: snap.default_agent_preset,
            layout: ProjectLayout {
                has_personas: !snap.layout.personas_dir.is_empty(),
                has_skills: !snap.layout.skills_dir.is_empty(),
                has_flows: !snap.layout.flows_dir.is_empty(),
                has_session_logs: !snap.layout.sessions_dir.is_empty(),
                has_api_tools: !snap.layout.api_tools_dir.is_empty(),
                has_agent_presets: !snap.layout.agent_presets_dir.is_empty(),
                has_agent_instances: !snap.layout.agent_instances_dir.is_empty(),
            },
        })
    }

    async fn agent_info(&self) -> anyhow::Result<AgentInfo> {
        let resp = self.get("/api/v1/info").send().await?;
        // An agent old enough to predate this endpoint 404s — that's not an
        // error, it just means "version unknown". Report reachability without a
        // version rather than failing the whole Settings load.
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(AgentInfo::default());
        }
        let resp = ok_or_err(resp, "GET /info").await?;
        decode_json(resp, "GET /info").await
    }

    async fn get_persona(&self, slug: &str) -> anyhow::Result<Persona> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/personas/{slug}")).send().await?,
            "GET persona",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn save_persona(&self, slug: &str, persona: &Persona) -> anyhow::Result<()> {
        ok_or_err(
            self.put(&format!("/api/v1/personas/{slug}"))
                .json(persona)
                .send()
                .await?,
            "PUT persona",
        )
        .await?;
        Ok(())
    }
    async fn delete_persona(&self, slug: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/personas/{slug}")).send().await?,
            "DELETE persona",
        )
        .await?;
        Ok(())
    }

    async fn get_skill(&self, slug: &str) -> anyhow::Result<Skill> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/skills/{slug}")).send().await?,
            "GET skill",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn save_skill(&self, slug: &str, description: &str, body: &str) -> anyhow::Result<()> {
        let body = PutSkillBody { slug, description, body };
        ok_or_err(
            self.put(&format!("/api/v1/skills/{slug}"))
                .json(&body)
                .send()
                .await?,
            "PUT skill",
        )
        .await?;
        Ok(())
    }
    async fn delete_skill(&self, slug: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/skills/{slug}")).send().await?,
            "DELETE skill",
        )
        .await?;
        Ok(())
    }

    async fn get_flow(&self, id: &str) -> anyhow::Result<SavedFlow> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/flows/{id}")).send().await?,
            "GET flow",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn save_flow(&self, flow: &SavedFlow) -> anyhow::Result<Vec<ValidationError>> {
        // Validate client-side first (same as local path). The agent itself
        // doesn't surface structured validation errors, so this is the only
        // place callers see them in remote mode.
        let errors = flows::validate_only(flow);
        if !errors.is_empty() {
            return Ok(errors);
        }
        ok_or_err(
            self.put(&format!("/api/v1/flows/{}", flow.id))
                .json(flow)
                .send()
                .await?,
            "PUT flow",
        )
        .await?;
        Ok(Vec::new())
    }
    async fn delete_flow(&self, id: &str) -> anyhow::Result<bool> {
        let resp = self
            .delete(&format!("/api/v1/flows/{id}"))
            .send()
            .await?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        ok_or_err(resp, "DELETE flow").await?;
        Ok(true)
    }

    async fn list_diagnostics(&self) -> anyhow::Result<Vec<DiagnosticsSessionSummary>> {
        let resp = ok_or_err(
            self.get("/api/v1/diagnostics").send().await?,
            "GET diagnostics",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn load_diagnostics(&self, id: &str) -> anyhow::Result<ChatTimeline> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/diagnostics/{id}")).send().await?,
            "GET diagnostics session",
        )
        .await?;
        let raw: RemoteDiagnosticsSession = resp.json().await?;
        let session = raw.session_info.unwrap_or_default();
        let mut events = Vec::new();
        for entry in raw.timeline {
            if let Some(ev) = diagnostics::parse_timeline_entry(&entry.file, entry.data) {
                events.push(ev);
            }
        }
        events.sort_by_key(diagnostics::TimelineEvent::sort_key_pub);
        Ok(ChatTimeline { session, events })
    }

    async fn list_api_tools(&self) -> anyhow::Result<Vec<ApiToolSummary>> {
        let resp = ok_or_err(
            self.get("/api/v1/api-tools").send().await?,
            "GET api-tools",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn get_api_tool(&self, name: &str) -> anyhow::Result<ApiToolConfig> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/api-tools/{name}")).send().await?,
            "GET api-tool",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn save_api_tool(&self, name: &str, config: &ApiToolConfig) -> anyhow::Result<()> {
        ok_or_err(
            self.put(&format!("/api/v1/api-tools/{name}"))
                .json(config)
                .send()
                .await?,
            "PUT api-tool",
        )
        .await?;
        Ok(())
    }
    async fn delete_api_tool(&self, name: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/api-tools/{name}")).send().await?,
            "DELETE api-tool",
        )
        .await?;
        Ok(())
    }

    async fn list_keys(&self) -> anyhow::Result<Vec<KeyEntry>> {
        let resp = ok_or_err(self.get("/api/v1/keys").send().await?, "GET keys").await?;
        Ok(resp.json().await?)
    }
    async fn save_key(&self, name: &str, value: &str, channel_id: Option<&str>) -> anyhow::Result<()> {
        ok_or_err(
            self.put(&format!("/api/v1/keys/{name}"))
                .json(&PutKeyBody { value, channel_id })
                .send()
                .await?,
            "PUT key",
        )
        .await?;
        Ok(())
    }
    async fn delete_key(&self, name: &str, channel_id: Option<&str>) -> anyhow::Result<()> {
        let url = match channel_id {
            Some(cid) => format!("/api/v1/keys/{name}?channel_id={cid}"),
            None => format!("/api/v1/keys/{name}"),
        };
        ok_or_err(self.delete(&url).send().await?, "DELETE key").await?;
        Ok(())
    }
    async fn reveal_key(&self, name: &str, channel_id: Option<&str>) -> anyhow::Result<String> {
        let url = match channel_id {
            Some(cid) => format!("/api/v1/keys/{name}/reveal?channel_id={cid}"),
            None => format!("/api/v1/keys/{name}/reveal"),
        };
        let resp = ok_or_err(self.get(&url).send().await?, "GET reveal key").await?;
        let body: RevealKeyResponse = resp.json().await?;
        Ok(body.value)
    }
    async fn list_recommended_keys(&self) -> anyhow::Result<Vec<RecommendedKey>> {
        let resp = ok_or_err(
            self.get("/api/v1/keys/recommended").send().await?,
            "GET recommended keys",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn list_flow_templates(&self) -> anyhow::Result<Vec<FlowTemplateSummary>> {
        let resp = ok_or_err(
            self.get("/api/v1/flow-templates").send().await?,
            "GET flow-templates",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn get_flow_template(&self, slug: &str) -> anyhow::Result<FlowTemplate> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/flow-templates/{slug}")).send().await?,
            "GET flow-template",
        )
        .await?;
        // Agent returns `{ slug, name, flow: <full SavedFlow doc> }`. Deserialize
        // straight into our FlowTemplate.
        Ok(resp.json().await?)
    }

    async fn run_flow(
        &self,
        id: &str,
        persona_slug: Option<&str>,
        model_name: Option<&str>,
        inputs: Option<serde_json::Value>,
    ) -> anyhow::Result<RunFlowResult> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            persona_slug: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            model_name: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            inputs: Option<serde_json::Value>,
        }
        let resp = ok_or_err(
            self.post(&format!("/api/v1/flows/{id}/run"))
                .json(&Body { persona_slug, model_name, inputs })
                .send()
                .await?,
            "POST run flow",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn resume_flow_run(
        &self,
        run_id: &str,
        handle: &str,
        data: Option<serde_json::Value>,
    ) -> anyhow::Result<RunFlowResult> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            handle: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            data: Option<serde_json::Value>,
        }
        let resp = ok_or_err(
            self.post(&format!("/api/v1/flow-runs/{run_id}/resume"))
                .json(&Body { handle, data })
                .send()
                .await?,
            "POST resume flow run",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn get_flow_run(&self, run_id: &str) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/flow-runs/{run_id}")).send().await?,
            "GET flow run",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn list_flow_runs(
        &self,
        flow_id: Option<&str>,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let path = match flow_id {
            Some(f) => format!("/api/v1/flow-runs?flow_id={f}"),
            None => "/api/v1/flow-runs".to_string(),
        };
        let resp = ok_or_err(self.get(&path).send().await?, "GET flow runs").await?;
        Ok(resp.json().await?)
    }

    async fn install_flow(&self, slug: &str) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(
            self.post("/api/v1/flows/install")
                .json(&serde_json::json!({ "slug": slug }))
                .send()
                .await?,
            "POST install flow",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn install_flow_dependencies(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(
            self.post(&format!("/api/v1/flows/{id}/install-dependencies"))
                .send()
                .await?,
            "POST install flow dependencies",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn list_agent_presets(&self) -> anyhow::Result<Vec<AgentPresetSummary>> {
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(default)]
            presets: Vec<AgentPresetSummary>,
        }
        let resp = self.get("/api/v1/agent-presets").send().await?;
        // An agent from before presets 404s. That is not an error — it means this pod
        // has no agents to pick from, and the UI should fall back to the persona
        // picker rather than show a failure.
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        let resp = ok_or_err(resp, "GET agent-presets").await?;
        let w: Wrapper = decode_json(resp, "GET agent-presets").await?;
        Ok(w.presets)
    }

    async fn get_agent_preset(&self, slug: &str) -> anyhow::Result<AgentPresetDetail> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/agent-presets/{}", urlencode(slug))).send().await?,
            "GET agent-preset",
        )
        .await?;
        decode_json(resp, "GET agent-preset").await
    }

    async fn save_agent_preset(&self, slug: &str, preset: &AgentPreset) -> anyhow::Result<()> {
        ok_or_err(
            self.put(&format!("/api/v1/agent-presets/{}", urlencode(slug)))
                .json(preset)
                .send()
                .await?,
            "PUT agent-preset",
        )
        .await?;
        Ok(())
    }

    async fn delete_agent_preset(&self, slug: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/agent-presets/{}", urlencode(slug))).send().await?,
            "DELETE agent-preset",
        )
        .await?;
        Ok(())
    }

    async fn list_agent_instances(&self) -> anyhow::Result<Vec<AgentInstance>> {
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(default)]
            instances: Vec<AgentInstance>,
        }
        let resp = self.get("/api/v1/agents/instances").send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        let resp = ok_or_err(resp, "GET agent instances").await?;
        let w: Wrapper = decode_json(resp, "GET agent instances").await?;
        Ok(w.instances)
    }

    async fn get_agent_instance(&self, id: &str) -> anyhow::Result<InstanceDetail> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/agents/instances/{}", urlencode(id))).send().await?,
            "GET agent instance",
        )
        .await?;
        decode_json(resp, "GET agent instance").await
    }

    async fn create_agent_instance(
        &self,
        agent_preset: Option<&str>,
        name: Option<&str>,
    ) -> anyhow::Result<AgentInstance> {
        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            agent_preset: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            name: Option<&'a str>,
        }
        let resp = ok_or_err(
            self.post("/api/v1/agents/instances")
                .json(&Body { agent_preset, name })
                .send()
                .await?,
            "POST agent instance",
        )
        .await?;
        decode_json(resp, "POST agent instance").await
    }

    async fn patch_agent_instance(
        &self,
        id: &str,
        patch: &InstancePatch,
    ) -> anyhow::Result<AgentInstance> {
        let resp = ok_or_err(
            self.patch(&format!("/api/v1/agents/instances/{}", urlencode(id)))
                .json(patch)
                .send()
                .await?,
            "PATCH agent instance",
        )
        .await?;
        decode_json(resp, "PATCH agent instance").await
    }

    async fn delete_agent_instance(&self, id: &str) -> anyhow::Result<usize> {
        #[derive(Deserialize)]
        struct Deleted {
            #[serde(default)]
            conversations_kept: usize,
        }
        let resp = ok_or_err(
            self.delete(&format!("/api/v1/agents/instances/{}", urlencode(id))).send().await?,
            "DELETE agent instance",
        )
        .await?;
        let d: Deleted = decode_json(resp, "DELETE agent instance").await?;
        Ok(d.conversations_kept)
    }

    async fn agent_instance_memory(
        &self,
        id: &str,
        limit: Option<usize>,
    ) -> anyhow::Result<InstanceMemory> {
        let path = match limit {
            Some(n) => format!("/api/v1/agents/instances/{}/memory?limit={n}", urlencode(id)),
            None => format!("/api/v1/agents/instances/{}/memory", urlencode(id)),
        };
        let resp = ok_or_err(self.get(&path).send().await?, "GET agent memory").await?;
        decode_json(resp, "GET agent memory").await
    }

    async fn flow_binding(&self, flow_id: &str) -> anyhow::Result<FlowBinding> {
        let path = format!("/api/v1/flows/{}/binding", urlencode(flow_id));
        let resp = ok_or_err(self.get(&path).send().await?, "GET flow binding").await?;
        decode_json(resp, "GET flow binding").await
    }

    async fn bind_flow_preset(
        &self,
        flow_id: &str,
        agent_preset: Option<&str>,
    ) -> anyhow::Result<FlowBinding> {
        let path = format!("/api/v1/flows/{}/binding", urlencode(flow_id));
        let resp = ok_or_err(
            self.put(&path).json(&serde_json::json!({ "agent_preset": agent_preset })).send().await?,
            "PUT flow binding",
        )
        .await?;
        decode_json(resp, "PUT flow binding").await
    }

    async fn arm_schedule(
        &self,
        flow_id: &str,
        schedule_id: &str,
        instance_id: Option<&str>,
    ) -> anyhow::Result<AgentInstance> {
        let path = format!(
            "/api/v1/flows/{}/schedules/{}/arm",
            urlencode(flow_id),
            urlencode(schedule_id)
        );
        let resp = ok_or_err(
            self.post(&path).json(&serde_json::json!({ "instance_id": instance_id })).send().await?,
            "POST arm schedule",
        )
        .await?;
        decode_json(resp, "POST arm schedule").await
    }

    async fn disarm_schedule(
        &self,
        flow_id: &str,
        schedule_id: &str,
    ) -> anyhow::Result<FlowBinding> {
        let path = format!(
            "/api/v1/flows/{}/schedules/{}/arm",
            urlencode(flow_id),
            urlencode(schedule_id)
        );
        let resp = ok_or_err(self.delete(&path).send().await?, "DELETE arm schedule").await?;
        decode_json(resp, "DELETE arm schedule").await
    }

    async fn list_agent_packs(&self) -> anyhow::Result<Vec<InstalledAgentPack>> {
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(default)]
            agent_packs: Vec<InstalledAgentPack>,
        }
        let resp = self.get("/api/v1/agent-packs").send().await?;
        // An agent from before agent packs 404s — no packs, not a failure.
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        let resp = ok_or_err(resp, "GET agent-packs").await?;
        let w: Wrapper = decode_json(resp, "GET agent-packs").await?;
        Ok(w.agent_packs)
    }

    async fn get_agent_pack(&self, id: &str) -> anyhow::Result<InstalledAgentPack> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/agent-packs/{}", urlencode(id))).send().await?,
            "GET agent-pack",
        )
        .await?;
        decode_json(resp, "GET agent-pack").await
    }

    async fn agent_pack_registries(&self) -> anyhow::Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(default)]
            origins: Vec<String>,
        }
        let resp = self.get("/api/v1/agent-packs/registries").send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        let resp = ok_or_err(resp, "GET agent-pack registries").await?;
        let w: Wrapper = decode_json(resp, "GET agent-pack registries").await?;
        Ok(w.origins)
    }

    async fn inspect_agent_pack(&self, source: &PackSource) -> anyhow::Result<AgentPackPreview> {
        let resp = ok_or_err(
            self.pack_request("/api/v1/agent-packs/inspect", source).send().await?,
            "POST agent-pack inspect",
        )
        .await?;
        decode_json(resp, "POST agent-pack inspect").await
    }

    async fn install_agent_pack(&self, source: &PackSource) -> anyhow::Result<InstallReport> {
        let resp = ok_or_err(
            self.pack_request("/api/v1/agent-packs/install", source).send().await?,
            "POST agent-pack install",
        )
        .await?;
        decode_json(resp, "POST agent-pack install").await
    }

    async fn uninstall_agent_pack(
        &self,
        id: &str,
        force: bool,
    ) -> anyhow::Result<UninstallReport> {
        let path = format!("/api/v1/agent-packs/{}?force={force}", urlencode(id));
        let resp = ok_or_err(self.delete(&path).send().await?, "DELETE agent-pack").await?;
        decode_json(resp, "DELETE agent-pack").await
    }

    async fn export_agent_pack(&self, preset: &str, version: &str) -> anyhow::Result<Vec<u8>> {
        #[derive(Serialize)]
        struct Body<'a> {
            preset: &'a str,
            version: &'a str,
        }
        let resp = ok_or_err(
            self.post("/api/v1/agent-packs/export")
                .json(&Body { preset, version })
                .send()
                .await?,
            "POST agent-pack export",
        )
        .await?;
        Ok(resp.bytes().await?.to_vec())
    }

    async fn list_chats(&self) -> anyhow::Result<Vec<ChatSummary>> {
        let resp = ok_or_err(self.get("/api/v1/chats").send().await?, "GET chats").await?;
        Ok(resp.json().await?)
    }
    async fn get_chat(&self, id: &str) -> anyhow::Result<ChatDetail> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/chats/{id}")).send().await?,
            "GET chat",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn create_chat(&self, req: &NewChat<'_>) -> anyhow::Result<ChatSummary> {
        let resp = ok_or_err(
            self.post("/api/v1/chats").json(req).send().await?,
            "POST chat",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn delete_chat(&self, id: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/chats/{id}")).send().await?,
            "DELETE chat",
        )
        .await?;
        Ok(())
    }

    async fn chat_turn(
        &self,
        id: &str,
        message: &str,
    ) -> anyhow::Result<Pin<Box<dyn Stream<Item = anyhow::Result<ChatEvent>> + Send>>> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            message: &'a str,
        }
        // NB: built inline rather than via `self.post()` on purpose — the
        // streaming turn must NOT carry the per-request timeout, or a turn that
        // runs longer than that deadline gets its SSE stream killed mid-flight.
        let resp = self
            .stream_client
            .post(self.url(&format!("/api/v1/chats/{id}/turn")))
            .bearer_auth(self.bearer())
            .json(&Body { message })
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let msg = resp.text().await.unwrap_or_default();
            anyhow::bail!("POST chat turn: HTTP {} {}", status, msg);
        }
        let byte_stream = resp.bytes_stream();
        let event_stream = sse_decode(byte_stream);
        Ok(Box::pin(event_stream))
    }

    async fn subscribe_chat_events(
        &self,
        id: &str,
    ) -> anyhow::Result<Pin<Box<dyn Stream<Item = anyhow::Result<ChatEvent>> + Send>>> {
        // Long-lived SSE like `chat_turn` — built inline WITHOUT the per-request
        // timeout so an idle subscription (waiting for a follow-up to fire) isn't
        // torn down mid-wait.
        let resp = self
            .stream_client
            .get(self.url(&format!("/api/v1/chats/{id}/events")))
            .bearer_auth(self.bearer())
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let msg = resp.text().await.unwrap_or_default();
            anyhow::bail!("GET chat events: HTTP {} {}", status, msg);
        }
        let event_stream = sse_decode(resp.bytes_stream());
        Ok(Box::pin(event_stream))
    }

    async fn list_scheduled_tasks(&self) -> anyhow::Result<Vec<ScheduledTask>> {
        let resp = ok_or_err(
            self.get("/api/v1/scheduled-tasks").send().await?,
            "GET scheduled-tasks",
        )
        .await?;
        decode_json(resp, "GET scheduled-tasks").await
    }

    async fn cancel_scheduled_task(&self, id: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/scheduled-tasks/{id}")).send().await?,
            "DELETE scheduled-task",
        )
        .await?;
        Ok(())
    }

    async fn list_integrations(&self) -> anyhow::Result<Vec<IntegrationSummary>> {
        let resp = ok_or_err(
            self.get("/api/v1/integrations").send().await?,
            "GET integrations",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn get_integration(&self, id: &str) -> anyhow::Result<IntegrationDetail> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/integrations/{id}")).send().await?,
            "GET integration-pack",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn set_pack_enabled(&self, id: &str, enabled: bool) -> anyhow::Result<()> {
        #[derive(serde::Serialize)]
        struct Body {
            enabled: bool,
        }
        ok_or_err(
            self.put(&format!("/api/v1/integrations/{id}/enabled"))
                .json(&Body { enabled })
                .send()
                .await?,
            "PUT pack enabled",
        )
        .await?;
        Ok(())
    }
    async fn install_pack(
        &self,
        slug: &str,
        version: Option<&str>,
        content_sha256: Option<&str>,
    ) -> anyhow::Result<IntegrationSummary> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            slug: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            version: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            content_sha256: Option<&'a str>,
        }
        let resp = ok_or_err(
            self.post("/api/v1/integrations/install")
                .json(&Body { slug, version, content_sha256 })
                .send()
                .await?,
            "POST install pack",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn uninstall_pack(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(
            self.delete(&format!("/api/v1/integrations/{id}")).send().await?,
            "DELETE integration-pack",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn get_lockfile(&self) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(self.get("/api/v1/lockfile").send().await?, "GET lockfile").await?;
        Ok(resp.json().await?)
    }
    async fn restore_lockfile(&self) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(
            self.post("/api/v1/lockfile/restore").send().await?,
            "POST lockfile restore",
        )
        .await?;
        Ok(resp.json().await?)
    }

    async fn list_gateway_activity(&self) -> anyhow::Result<Vec<GatewayEvent>> {
        let resp = ok_or_err(
            self.get("/api/v1/gateway/activity").send().await?,
            "GET gateway activity",
        )
        .await?;
        decode_json(resp, "GET gateway activity").await
    }
    async fn list_channels(&self) -> anyhow::Result<Vec<Channel>> {
        let resp = ok_or_err(self.get("/api/v1/channels").send().await?, "GET channels").await?;
        decode_json(resp, "GET channels").await
    }
    async fn channel_events(&self, slug: &str) -> anyhow::Result<Vec<GatewayEvent>> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/channels/{slug}/events")).send().await?,
            "GET channel events",
        )
        .await?;
        decode_json(resp, "GET channel events").await
    }
    async fn create_channel(&self, name: &str, url: &str, secret: &str) -> anyhow::Result<Channel> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            name: &'a str,
            url: &'a str,
            secret: &'a str,
        }
        let resp = ok_or_err(
            self.post("/api/v1/channels").json(&Body { name, url, secret }).send().await?,
            "POST channel",
        )
        .await?;
        decode_json(resp, "POST channel").await
    }
    async fn update_channel(
        &self,
        slug: &str,
        name: &str,
        url: &str,
        enabled: bool,
        secret: Option<&str>,
    ) -> anyhow::Result<Channel> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            name: &'a str,
            url: &'a str,
            enabled: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            secret: Option<&'a str>,
        }
        let resp = ok_or_err(
            self.put(&format!("/api/v1/channels/{slug}"))
                .json(&Body { name, url, enabled, secret })
                .send()
                .await?,
            "PUT channel",
        )
        .await?;
        decode_json(resp, "PUT channel").await
    }
    async fn delete_channel(&self, slug: &str) -> anyhow::Result<()> {
        ok_or_err(self.delete(&format!("/api/v1/channels/{slug}")).send().await?, "DELETE channel")
            .await?;
        Ok(())
    }
    async fn gateway_metalcraft_status(&self) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(
            self.get("/api/v1/gateway/metalcraft/status").send().await?,
            "GET metalcraft gateway status",
        )
        .await?;
        decode_json(resp, "GET metalcraft gateway status").await
    }
    async fn gateway_metalcraft_register(&self, phone_number: &str) -> anyhow::Result<serde_json::Value> {
        let resp = ok_or_err(
            self.post("/api/v1/gateway/metalcraft/register")
                .json(&serde_json::json!({ "phone_number": phone_number }))
                .send()
                .await?,
            "POST metalcraft gateway register",
        )
        .await?;
        decode_json(resp, "POST metalcraft gateway register").await
    }
    async fn gateway_metalcraft_connect(&self, webhook_base: Option<String>) -> anyhow::Result<serde_json::Value> {
        // Default to the very URL the workshop uses to reach this pod — authoritative
        // in remote mode, so Connect works even without POD_PUBLIC_URL in the pod env.
        let webhook_base = webhook_base
            .filter(|s| !s.trim().is_empty())
            .or_else(|| Some(self.base_url.clone()));
        let resp = ok_or_err(
            self.post("/api/v1/gateway/metalcraft/connect")
                .json(&serde_json::json!({ "webhook_base": webhook_base }))
                .send()
                .await?,
            "POST metalcraft gateway connect",
        )
        .await?;
        decode_json(resp, "POST metalcraft gateway connect").await
    }
}

// ─── SSE decoder ────────────────────────────────────────────────────────────

/// Flatten an error and its whole `source()` chain into one string. reqwest's
/// own `Display` collapses to terse, unhelpful phrases like "error decoding
/// response body" — the real cause (a timeout, a connection reset, an early
/// EOF) only appears further down the chain. Used so stream failures carry the
/// actual reason instead of the opaque top-level message.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut src = err.source();
    while let Some(e) = src {
        out.push_str(": ");
        out.push_str(&e.to_string());
        src = e.source();
    }
    out
}

/// Convert a stream of raw response bytes into a stream of decoded
/// [`ChatEvent`]s. We do the minimal SSE parsing needed for our wire
/// format: `data: <json>` followed by a blank line. Other SSE fields
/// (`event:`, `id:`, comments starting with `:`) are ignored.
fn sse_decode<S>(byte_stream: S) -> impl Stream<Item = anyhow::Result<ChatEvent>> + Send
where
    S: Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
{
    use futures_util::StreamExt;
    async_stream::try_stream! {
        let mut buf: Vec<u8> = Vec::new();
        let mut data_lines: Vec<String> = Vec::new();
        tokio::pin!(byte_stream);
        while let Some(chunk) = byte_stream.next().await {
            let chunk = chunk.map_err(|e| {
                anyhow::anyhow!("chat stream transport error: {}", error_chain(&e))
            })?;
            buf.extend_from_slice(&chunk);
            // Process complete lines (ending in \n; trailing partial line stays in buf).
            loop {
                let Some(pos) = buf.iter().position(|b| *b == b'\n') else { break };
                let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                let line = std::str::from_utf8(&line_bytes)
                    .unwrap_or("")
                    .trim_end_matches(|c| c == '\n' || c == '\r');
                if line.is_empty() {
                    // Dispatch one event.
                    if !data_lines.is_empty() {
                        let payload = data_lines.join("\n");
                        data_lines.clear();
                        let ev: ChatEvent = serde_json::from_str(&payload)
                            .map_err(|e| anyhow::anyhow!(
                                "sse decode failed: {e}; payload: {}",
                                payload.chars().take(400).collect::<String>()
                            ))?;
                        yield ev;
                    }
                } else if let Some(rest) = line.strip_prefix("data:") {
                    data_lines.push(rest.trim_start().to_string());
                }
                // Other SSE fields ignored.
            }
        }
        // Flush any final event if the server didn't end with a blank line.
        if !data_lines.is_empty() {
            let payload = data_lines.join("\n");
            let ev: ChatEvent = serde_json::from_str(&payload)
                .map_err(|e| anyhow::anyhow!(
                    "sse decode failed: {e}; payload: {}",
                    payload.chars().take(400).collect::<String>()
                ))?;
            yield ev;
        }
    }
}
