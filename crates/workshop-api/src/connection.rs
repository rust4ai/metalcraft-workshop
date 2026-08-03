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

use crate::api_tools::{self, ApiToolConfig, ApiToolSummary};
use crate::chat::{self, ChatDetail, ChatEvent, ChatSummary, RunFlowResult};
use crate::diagnostics::{self, ChatTimeline, DiagnosticsSessionSummary};
use crate::flow_templates::{self, FlowTemplate, FlowTemplateSummary};
use crate::flows;
use crate::gateway::{GatewayChannel, GatewayEvent, GatewayType};
use crate::integration_packs::{PackDetail, PackSummary};
use std::collections::HashMap;
use crate::keys::{self, KeySummary, RecommendedKey};
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

    async fn list_keys(&self) -> anyhow::Result<Vec<KeySummary>>;
    async fn save_key(&self, name: &str, value: &str) -> anyhow::Result<()>;
    async fn delete_key(&self, name: &str) -> anyhow::Result<()>;

    /// Keys that enabled integration packs declare they need. Remote-only —
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

    async fn list_chats(&self) -> anyhow::Result<Vec<ChatSummary>>;
    async fn get_chat(&self, id: &str) -> anyhow::Result<ChatDetail>;
    async fn create_chat(
        &self,
        persona_slug: &str,
        model_name: Option<&str>,
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

    // Integration packs — remote-only. Pack state is managed by the agent
    // process (lives in `<data>/integration_packs.json`), not the workshop.
    async fn list_integration_packs(&self) -> anyhow::Result<Vec<PackSummary>>;
    async fn get_integration_pack(&self, id: &str) -> anyhow::Result<PackDetail>;
    async fn set_pack_enabled(&self, id: &str, enabled: bool) -> anyhow::Result<()>;

    // Gateway channels — remote-only, like integration packs. Types are
    // declarative manifests on the agent; instances live in the agent's
    // `<data>/gateway_channels.json`.
    async fn list_gateway_types(&self) -> anyhow::Result<Vec<GatewayType>>;
    async fn list_gateway_channels(&self) -> anyhow::Result<Vec<GatewayChannel>>;
    /// Recent inbound/outbound activity for one channel (newest first).
    async fn list_gateway_channel_events(&self, id: &str) -> anyhow::Result<Vec<GatewayEvent>>;
    /// Recent gateway activity across all channels, incl. unrouted inbound.
    async fn list_gateway_activity(&self) -> anyhow::Result<Vec<GatewayEvent>>;
    async fn create_gateway_channel(
        &self,
        type_id: &str,
        name: &str,
        settings: HashMap<String, String>,
    ) -> anyhow::Result<GatewayChannel>;
    async fn update_gateway_channel(
        &self,
        id: &str,
        name: &str,
        enabled: bool,
        settings: HashMap<String, String>,
    ) -> anyhow::Result<GatewayChannel>;
    async fn set_gateway_channel_enabled(&self, id: &str, enabled: bool) -> anyhow::Result<()>;
    async fn delete_gateway_channel(&self, id: &str) -> anyhow::Result<()>;

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

    async fn list_keys(&self) -> anyhow::Result<Vec<KeySummary>> {
        Ok(keys::list(&self.root))
    }
    async fn save_key(&self, name: &str, value: &str) -> anyhow::Result<()> {
        keys::save(&self.root, name, value)
    }
    async fn delete_key(&self, name: &str) -> anyhow::Result<()> {
        keys::delete(&self.root, name)
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
    async fn list_chats(&self) -> anyhow::Result<Vec<ChatSummary>> {
        Err(chat::not_supported_in_local_mode("Chat"))
    }
    async fn get_chat(&self, _id: &str) -> anyhow::Result<ChatDetail> {
        Err(chat::not_supported_in_local_mode("Chat"))
    }
    async fn create_chat(
        &self,
        _persona_slug: &str,
        _model_name: Option<&str>,
    ) -> anyhow::Result<ChatSummary> {
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

    async fn list_integration_packs(&self) -> anyhow::Result<Vec<PackSummary>> {
        Err(chat::not_supported_in_local_mode("Integration packs"))
    }
    async fn get_integration_pack(&self, _id: &str) -> anyhow::Result<PackDetail> {
        Err(chat::not_supported_in_local_mode("Integration packs"))
    }
    async fn set_pack_enabled(&self, _id: &str, _enabled: bool) -> anyhow::Result<()> {
        Err(chat::not_supported_in_local_mode("Integration packs"))
    }

    async fn list_gateway_types(&self) -> anyhow::Result<Vec<GatewayType>> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn list_gateway_channels(&self) -> anyhow::Result<Vec<GatewayChannel>> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn list_gateway_channel_events(&self, _id: &str) -> anyhow::Result<Vec<GatewayEvent>> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn list_gateway_activity(&self) -> anyhow::Result<Vec<GatewayEvent>> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn create_gateway_channel(
        &self,
        _type_id: &str,
        _name: &str,
        _settings: HashMap<String, String>,
    ) -> anyhow::Result<GatewayChannel> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn update_gateway_channel(
        &self,
        _id: &str,
        _name: &str,
        _enabled: bool,
        _settings: HashMap<String, String>,
    ) -> anyhow::Result<GatewayChannel> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn set_gateway_channel_enabled(&self, _id: &str, _enabled: bool) -> anyhow::Result<()> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
    }
    async fn delete_gateway_channel(&self, _id: &str) -> anyhow::Result<()> {
        Err(chat::not_supported_in_local_mode("Gateway channels"))
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
    api_key: String,
    client: reqwest::Client,
}

impl RemoteConnection {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> anyhow::Result<Self> {
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
        Ok(Self {
            base_url: trimmed.to_string(),
            api_key: api_key.into(),
            client,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Hard cap for the non-streaming CRUD calls. The streaming `chat_turn`
    /// request deliberately does NOT go through these helpers (see its note).
    const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .get(self.url(path))
            .bearer_auth(&self.api_key)
            .timeout(Self::REQUEST_TIMEOUT)
    }
    fn put(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .put(self.url(path))
            .bearer_auth(&self.api_key)
            .timeout(Self::REQUEST_TIMEOUT)
    }
    fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .delete(self.url(path))
            .bearer_auth(&self.api_key)
            .timeout(Self::REQUEST_TIMEOUT)
    }
    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(self.url(path))
            .bearer_auth(&self.api_key)
            .timeout(Self::REQUEST_TIMEOUT)
    }
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
            layout: ProjectLayout {
                has_personas: !snap.layout.personas_dir.is_empty(),
                has_skills: !snap.layout.skills_dir.is_empty(),
                has_flows: !snap.layout.flows_dir.is_empty(),
                has_session_logs: !snap.layout.sessions_dir.is_empty(),
                has_api_tools: !snap.layout.api_tools_dir.is_empty(),
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
        let session = raw.session_info.unwrap_or(diagnostics::SessionInfo {
            timestamp: None,
            persona_name: None,
            persona_slug: None,
            model_name: None,
            cwd: None,
            system_prompt: None,
            tools: Vec::new(),
            skills: Vec::new(),
            auto_approve: false,
            kind: None,
            flow_id: None,
        });
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

    async fn list_keys(&self) -> anyhow::Result<Vec<KeySummary>> {
        let resp = ok_or_err(self.get("/api/v1/keys").send().await?, "GET keys").await?;
        Ok(resp.json().await?)
    }
    async fn save_key(&self, name: &str, value: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.put(&format!("/api/v1/keys/{name}"))
                .json(&PutKeyBody { value })
                .send()
                .await?,
            "PUT key",
        )
        .await?;
        Ok(())
    }
    async fn delete_key(&self, name: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/keys/{name}")).send().await?,
            "DELETE key",
        )
        .await?;
        Ok(())
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
    async fn create_chat(
        &self,
        persona_slug: &str,
        model_name: Option<&str>,
    ) -> anyhow::Result<ChatSummary> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            persona_slug: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            model_name: Option<&'a str>,
        }
        let resp = ok_or_err(
            self.post("/api/v1/chats")
                .json(&Body { persona_slug, model_name })
                .send()
                .await?,
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
            .client
            .post(self.url(&format!("/api/v1/chats/{id}/turn")))
            .bearer_auth(&self.api_key)
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
            .client
            .get(self.url(&format!("/api/v1/chats/{id}/events")))
            .bearer_auth(&self.api_key)
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

    async fn list_integration_packs(&self) -> anyhow::Result<Vec<PackSummary>> {
        let resp = ok_or_err(
            self.get("/api/v1/integration-packs").send().await?,
            "GET integration-packs",
        )
        .await?;
        Ok(resp.json().await?)
    }
    async fn get_integration_pack(&self, id: &str) -> anyhow::Result<PackDetail> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/integration-packs/{id}")).send().await?,
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
            self.put(&format!("/api/v1/integration-packs/{id}/enabled"))
                .json(&Body { enabled })
                .send()
                .await?,
            "PUT pack enabled",
        )
        .await?;
        Ok(())
    }

    async fn list_gateway_types(&self) -> anyhow::Result<Vec<GatewayType>> {
        let resp = ok_or_err(
            self.get("/api/v1/gateway/types").send().await?,
            "GET gateway types",
        )
        .await?;
        decode_json(resp, "GET gateway types").await
    }
    async fn list_gateway_channels(&self) -> anyhow::Result<Vec<GatewayChannel>> {
        let resp = ok_or_err(
            self.get("/api/v1/gateway/channels").send().await?,
            "GET gateway channels",
        )
        .await?;
        decode_json(resp, "GET gateway channels").await
    }
    async fn list_gateway_channel_events(&self, id: &str) -> anyhow::Result<Vec<GatewayEvent>> {
        let resp = ok_or_err(
            self.get(&format!("/api/v1/gateway/channels/{id}/events")).send().await?,
            "GET gateway channel events",
        )
        .await?;
        decode_json(resp, "GET gateway channel events").await
    }
    async fn list_gateway_activity(&self) -> anyhow::Result<Vec<GatewayEvent>> {
        let resp = ok_or_err(
            self.get("/api/v1/gateway/activity").send().await?,
            "GET gateway activity",
        )
        .await?;
        decode_json(resp, "GET gateway activity").await
    }
    async fn create_gateway_channel(
        &self,
        type_id: &str,
        name: &str,
        settings: HashMap<String, String>,
    ) -> anyhow::Result<GatewayChannel> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            type_id: &'a str,
            name: &'a str,
            settings: HashMap<String, String>,
        }
        let resp = ok_or_err(
            self.post("/api/v1/gateway/channels")
                .json(&Body { type_id, name, settings })
                .send()
                .await?,
            "POST gateway channel",
        )
        .await?;
        decode_json(resp, "POST gateway channel").await
    }
    async fn update_gateway_channel(
        &self,
        id: &str,
        name: &str,
        enabled: bool,
        settings: HashMap<String, String>,
    ) -> anyhow::Result<GatewayChannel> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            name: &'a str,
            enabled: bool,
            settings: HashMap<String, String>,
        }
        let resp = ok_or_err(
            self.put(&format!("/api/v1/gateway/channels/{id}"))
                .json(&Body { name, enabled, settings })
                .send()
                .await?,
            "PUT gateway channel",
        )
        .await?;
        decode_json(resp, "PUT gateway channel").await
    }
    async fn set_gateway_channel_enabled(&self, id: &str, enabled: bool) -> anyhow::Result<()> {
        #[derive(serde::Serialize)]
        struct Body {
            enabled: bool,
        }
        ok_or_err(
            self.put(&format!("/api/v1/gateway/channels/{id}/enabled"))
                .json(&Body { enabled })
                .send()
                .await?,
            "PUT gateway channel enabled",
        )
        .await?;
        Ok(())
    }
    async fn delete_gateway_channel(&self, id: &str) -> anyhow::Result<()> {
        ok_or_err(
            self.delete(&format!("/api/v1/gateway/channels/{id}")).send().await?,
            "DELETE gateway channel",
        )
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
