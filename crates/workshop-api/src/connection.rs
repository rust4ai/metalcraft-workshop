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
use crate::diagnostics::{self, ChatTimeline, DiagnosticsSessionSummary};
use crate::flows;
use crate::personas::{self, Persona};
use crate::project::{ConnectionMode, ProjectLayout, ProjectSnapshot};
use crate::skills::{self, Skill};
use metalcraft_flows::{SavedFlow, ValidationError};

#[async_trait]
pub trait ProjectConnection: Send + Sync {
    fn mode(&self) -> ConnectionMode;
    /// Filesystem root if this is a local connection. None for remote.
    fn local_root(&self) -> Option<&Path> {
        None
    }

    async fn snapshot(&self) -> anyhow::Result<ProjectSnapshot>;

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
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
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

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.get(self.url(path)).bearer_auth(&self.api_key)
    }
    fn put(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.put(self.url(path)).bearer_auth(&self.api_key)
    }
    fn delete(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.delete(self.url(path)).bearer_auth(&self.api_key)
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

/// Wire shape returned by `GET /api/v1/snapshot` on the agent. Mirrors
/// `ProjectSnapshot` in `metalcraft-agent/src/workshop_api.rs`.
#[derive(Deserialize)]
struct RemoteSnapshot {
    personas: Vec<personas::PersonaSummary>,
    skills: Vec<skills::SkillSummary>,
    flows: Vec<metalcraft_flows::FlowSummary>,
    sessions: Vec<diagnostics::DiagnosticsSessionSummary>,
    api_tools: Vec<ApiToolSummary>,
    layout: RemoteLayout,
}

#[derive(Deserialize)]
struct RemoteLayout {
    #[allow(dead_code)]
    data_dir: String,
    personas_dir: String,
    skills_dir: String,
    flows_dir: String,
    logs_dir: String,
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

#[async_trait]
impl ProjectConnection for RemoteConnection {
    fn mode(&self) -> ConnectionMode {
        ConnectionMode::Remote
    }

    async fn snapshot(&self) -> anyhow::Result<ProjectSnapshot> {
        let resp = ok_or_err(self.get("/api/v1/snapshot").send().await?, "GET /snapshot").await?;
        let snap: RemoteSnapshot = resp.json().await?;
        Ok(ProjectSnapshot {
            root: self.base_url.clone(),
            mode: ConnectionMode::Remote,
            personas: snap.personas,
            skills: snap.skills,
            flows: snap.flows,
            sessions: snap.sessions,
            api_tools: snap.api_tools,
            layout: ProjectLayout {
                has_personas: !snap.layout.personas_dir.is_empty(),
                has_skills: !snap.layout.skills_dir.is_empty(),
                has_flows: !snap.layout.flows_dir.is_empty(),
                has_logs: !snap.layout.logs_dir.is_empty(),
                has_api_tools: !snap.layout.api_tools_dir.is_empty(),
            },
        })
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
}
