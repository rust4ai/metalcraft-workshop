// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};

use workshop_api::commands::{FileKind, WorkshopEvent};
use workshop_api::{
    api_tools::{ApiToolConfig, ApiToolSummary},
    chat::{ChatDetail, ChatEvent, ChatSummary, RunFlowResult},
    connection::{LocalConnection, ProjectConnection, RemoteConnection, ScheduledTask},
    diagnostics,
    flow_templates::{FlowTemplate, FlowTemplateSummary},
    gateway::{GatewayChannel, GatewayEvent, GatewayType},
    integration_packs::{PackDetail, PackSummary},
    keys::{KeySummary, RecommendedKey},
    personas, project, skills,
    watcher::{self, ChangedPath, ProjectWatcher},
};

/// Shared app state: the currently-active connection (local dir or remote
/// agent), plus the filesystem watcher (only attached in local mode).
struct AppState {
    connection: Mutex<Option<Arc<dyn ProjectConnection>>>,
    watcher: Mutex<Option<ProjectWatcher>>,
    app_handle: tauri::AppHandle,
    /// Background task streaming a chat's agent-initiated events (scheduled
    /// follow-ups). At most one runs at a time — starting a new subscription or
    /// closing the chat aborts the previous.
    events_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AppState {
    fn emit(&self, event: WorkshopEvent) {
        if let Err(e) = self.app_handle.emit("workshop-event", &event) {
            log::error!("emit failed: {e}");
        }
    }
}

fn require_connection(
    state: &tauri::State<'_, Arc<AppState>>,
) -> Result<Arc<dyn ProjectConnection>, String> {
    state
        .connection
        .lock()
        .clone()
        .ok_or_else(|| "no project open".to_string())
}

// ---------- Connection commands ----------

#[tauri::command]
async fn open_project(
    path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    let conn: Arc<dyn ProjectConnection> = Arc::new(LocalConnection::new(path.clone()));
    let snapshot = conn.snapshot().await.map_err(|e| e.to_string())?;

    *state.connection.lock() = Some(conn);
    let st = state.inner().clone();
    let watcher = watcher::start_watching(&path, move |ChangedPath { path, kind }| {
        st.emit(WorkshopEvent::FileChanged { path, kind });
    })
    .map_err(|e| format!("watcher: {e}"))?;
    *state.watcher.lock() = Some(watcher);

    state.emit(WorkshopEvent::ProjectOpened(snapshot));
    persist_recent(RecentEntry::local(&path));
    Ok(())
}

#[tauri::command]
async fn open_remote(
    base_url: String,
    api_key: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if base_url.trim().is_empty() {
        return Err("base URL is required".into());
    }
    let conn = RemoteConnection::new(base_url.clone(), api_key.clone())
        .map_err(|e| format!("remote client: {e}"))?;
    let conn: Arc<dyn ProjectConnection> = Arc::new(conn);
    let snapshot = conn.snapshot().await.map_err(|e| e.to_string())?;

    *state.connection.lock() = Some(conn);
    *state.watcher.lock() = None; // remote mode has no local file watcher

    state.emit(WorkshopEvent::ProjectOpened(snapshot));
    persist_recent(RecentEntry::remote(&base_url, &api_key));
    Ok(())
}

#[tauri::command]
async fn close_project(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.connection.lock() = None;
    *state.watcher.lock() = None;
    state.emit(WorkshopEvent::ProjectClosed);
    Ok(())
}

#[tauri::command]
async fn refresh_snapshot(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let conn = require_connection(&state)?;
    let snapshot = conn.snapshot().await.map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::Snapshot(snapshot));
    Ok(())
}

#[tauri::command]
async fn get_snapshot(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<project::ProjectSnapshot>, String> {
    let conn = state.connection.lock().clone();
    match conn {
        Some(c) => Ok(Some(c.snapshot().await.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

#[tauri::command]
async fn list_recents() -> Result<Vec<RecentEntry>, String> {
    Ok(load_recents())
}

/// Everything the Settings tab needs in one round trip: this app's own version
/// and, for a remote connection, the connected agent's version (so you can
/// confirm a deploy actually landed). The frontend already has the connection
/// mode + root from the snapshot, so those aren't repeated here.
#[derive(serde::Serialize)]
struct SettingsInfo {
    /// Version of this Workshop desktop app (from its Cargo package).
    workshop_version: String,
    /// Connected agent's version. `None` in local mode, when the agent is
    /// unreachable, or when it predates the `/api/v1/info` endpoint.
    agent_version: Option<String>,
    /// Whether we successfully reached the agent's info endpoint. Always false
    /// in local mode (there is no agent process).
    agent_reachable: bool,
}

/// Identity/version + config of the connected agent (from `/api/v1/info`).
/// Used by the New Chat modal to read the agent-configured default persona.
#[tauri::command]
async fn agent_info(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<workshop_api::connection::AgentInfo, String> {
    let conn = require_connection(&state)?;
    conn.agent_info().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn settings_info(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SettingsInfo, String> {
    let workshop_version = env!("CARGO_PKG_VERSION").to_string();
    let conn = require_connection(&state)?;

    // Local connections have no agent process to interrogate.
    if !matches!(conn.mode(), project::ConnectionMode::Remote) {
        return Ok(SettingsInfo {
            workshop_version,
            agent_version: None,
            agent_reachable: false,
        });
    }

    // Reaching the agent but getting no version back (an older agent) still
    // counts as reachable — the tab distinguishes "unknown version" from
    // "couldn't connect".
    let (agent_version, agent_reachable) = match conn.agent_info().await {
        Ok(info) => (info.version, true),
        Err(_) => (None, false),
    };

    Ok(SettingsInfo {
        workshop_version,
        agent_version,
        agent_reachable,
    })
}

// ---- Personas ----

#[tauri::command]
async fn get_persona(
    slug: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<personas::Persona, String> {
    let conn = require_connection(&state)?;
    conn.get_persona(&slug).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_persona(
    slug: String,
    persona: personas::Persona,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !personas::is_safe_slug(&slug) {
        return Err(format!("unsafe slug: {slug}"));
    }
    let conn = require_connection(&state)?;
    conn.save_persona(&slug, &persona)
        .await
        .map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Persona,
        id: slug,
    });
    Ok(())
}

#[tauri::command]
async fn delete_persona(
    slug: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.delete_persona(&slug).await.map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Persona,
        id: slug,
    });
    Ok(())
}

// ---- Skills ----

#[tauri::command]
async fn get_skill(
    slug: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<skills::Skill, String> {
    let conn = require_connection(&state)?;
    conn.get_skill(&slug).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_skill(
    slug: String,
    description: String,
    body: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.save_skill(&slug, &description, &body)
        .await
        .map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Skill,
        id: slug,
    });
    Ok(())
}

#[tauri::command]
async fn delete_skill(
    slug: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.delete_skill(&slug).await.map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Skill,
        id: slug,
    });
    Ok(())
}

// ---- Flows ----

#[tauri::command]
async fn get_flow(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<metalcraft_flows::SavedFlow, String> {
    let conn = require_connection(&state)?;
    conn.get_flow(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_flow(
    flow: metalcraft_flows::SavedFlow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let conn = require_connection(&state)?;
    let id = flow.id.clone();
    let errors = conn.save_flow(&flow).await.map_err(|e| e.to_string())?;
    if errors.is_empty() {
        state.emit(WorkshopEvent::SaveOk {
            kind: FileKind::Flow,
            id,
        });
    }
    Ok(errors.into_iter().map(|e| e.to_string()).collect())
}

#[tauri::command]
async fn delete_flow(id: String, state: tauri::State<'_, Arc<AppState>>) -> Result<bool, String> {
    let conn = require_connection(&state)?;
    let deleted = conn.delete_flow(&id).await.map_err(|e| e.to_string())?;
    if deleted {
        state.emit(WorkshopEvent::SaveOk {
            kind: FileKind::Flow,
            id,
        });
    }
    Ok(deleted)
}

// ---- Diagnostics ----

#[tauri::command]
async fn list_diagnostics_sessions(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<diagnostics::DiagnosticsSessionSummary>, String> {
    let conn = require_connection(&state)?;
    conn.list_diagnostics().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_diagnostics_session(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<diagnostics::ChatTimeline, String> {
    let conn = require_connection(&state)?;
    conn.load_diagnostics(&id).await.map_err(|e| e.to_string())
}

// ---- API tools ----

#[tauri::command]
async fn list_api_tools(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ApiToolSummary>, String> {
    let conn = require_connection(&state)?;
    conn.list_api_tools().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_api_tool(
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ApiToolConfig, String> {
    let conn = require_connection(&state)?;
    conn.get_api_tool(&name).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_api_tool(
    name: String,
    config: ApiToolConfig,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.save_api_tool(&name, &config)
        .await
        .map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::ApiTool,
        id: name,
    });
    Ok(())
}

#[tauri::command]
async fn delete_api_tool(
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.delete_api_tool(&name)
        .await
        .map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::ApiTool,
        id: name,
    });
    Ok(())
}

// ---- API keys ----

#[tauri::command]
async fn list_keys(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<KeySummary>, String> {
    let conn = require_connection(&state)?;
    conn.list_keys().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_key(
    name: String,
    value: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.save_key(&name, &value)
        .await
        .map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Key,
        id: name,
    });
    Ok(())
}

#[tauri::command]
async fn delete_key(
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.delete_key(&name).await.map_err(|e| e.to_string())?;
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Key,
        id: name,
    });
    Ok(())
}

#[tauri::command]
async fn list_recommended_keys(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<RecommendedKey>, String> {
    let conn = require_connection(&state)?;
    conn.list_recommended_keys()
        .await
        .map_err(|e| e.to_string())
}

// ---- Flow templates ----

#[tauri::command]
async fn list_flow_templates(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<FlowTemplateSummary>, String> {
    let conn = require_connection(&state)?;
    conn.list_flow_templates().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_flow_template(
    slug: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<FlowTemplate, String> {
    let conn = require_connection(&state)?;
    conn.get_flow_template(&slug).await.map_err(|e| e.to_string())
}

// ---- Run flow ----

#[tauri::command]
async fn run_flow(
    id: String,
    persona_slug: Option<String>,
    model_name: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<RunFlowResult, String> {
    let conn = require_connection(&state)?;
    conn.run_flow(&id, persona_slug.as_deref(), model_name.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ---- Chats ----

#[tauri::command]
async fn list_chats(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ChatSummary>, String> {
    let conn = require_connection(&state)?;
    conn.list_chats().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_chat(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ChatDetail, String> {
    let conn = require_connection(&state)?;
    conn.get_chat(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_chat(
    persona_slug: String,
    model_name: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ChatSummary, String> {
    let conn = require_connection(&state)?;
    conn.create_chat(&persona_slug, model_name.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_chat(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.delete_chat(&id).await.map_err(|e| e.to_string())
}

/// Event emitted to the frontend during a streaming chat turn. The frontend
/// subscribes via `listen("chat-stream", ...)` and filters by `chat_id`.
#[derive(serde::Serialize, Clone)]
struct ChatStreamEvent {
    chat_id: String,
    #[serde(flatten)]
    event: ChatEvent,
}

/// Start a streaming chat turn. Each agent step is emitted as a
/// `chat-stream` event on the frontend's event bus. The command itself
/// returns when the agent reports its terminal event so the UI can
/// re-enable the input.
#[tauri::command]
async fn chat_turn(
    id: String,
    message: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    let conn = require_connection(&state)?;
    let mut stream = conn
        .chat_turn(&id, &message)
        .await
        .map_err(|e| e.to_string())?;
    let app_handle = state.app_handle.clone();
    while let Some(ev) = stream.next().await {
        match ev {
            Ok(event) => {
                let payload = ChatStreamEvent {
                    chat_id: id.clone(),
                    event,
                };
                if let Err(e) = app_handle.emit("chat-stream", &payload) {
                    log::error!("chat-stream emit failed: {e}");
                }
            }
            Err(e) => {
                // A mid-stream error here is a *transport* failure on the live
                // SSE feed (a dropped/idle-timed-out connection), NOT proof the
                // turn failed — the agent runs and persists the turn
                // independently. Reporting reqwest's opaque "error decoding
                // response body" as a failed turn is exactly what made a
                // completed turn look broken until the user reloaded. Instead
                // emit an `interrupted` terminal: the frontend reconciles the
                // transcript from the persisted chat on any terminal, so the
                // real result still appears. Return Ok so no error banner fires.
                log::warn!(
                    "chat-stream transport error (reconciling from persisted state): {e}"
                );
                let payload = ChatStreamEvent {
                    chat_id: id.clone(),
                    event: ChatEvent::Done {
                        status: "interrupted".into(),
                        reason: Some(
                            "live connection lost — restored from saved state".into(),
                        ),
                    },
                };
                let _ = app_handle.emit("chat-stream", &payload);
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Subscribe to a chat's agent-initiated turns (scheduled follow-ups) and relay
/// them onto the same `chat-stream` bus the UI already consumes, so a follow-up
/// that fires while the chat is open renders live. At most one subscription
/// runs; starting a new one (or `stop_chat_events`) aborts the previous.
#[tauri::command]
async fn subscribe_chat_events(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    let conn = require_connection(&state)?;
    let app_handle = state.app_handle.clone();

    // Abort any prior subscription before starting the new one.
    if let Some(prev) = state.events_task.lock().take() {
        prev.abort();
    }

    let handle = tokio::spawn(async move {
        let mut stream = match conn.subscribe_chat_events(&id).await {
            Ok(s) => s,
            Err(e) => {
                log::warn!("subscribe_chat_events({id}) failed: {e}");
                return;
            }
        };
        while let Some(ev) = stream.next().await {
            match ev {
                Ok(event) => {
                    let payload = ChatStreamEvent { chat_id: id.clone(), event };
                    if let Err(e) = app_handle.emit("chat-stream", &payload) {
                        log::error!("chat-stream (events) emit failed: {e}");
                    }
                }
                // Transport hiccup on the idle subscription — stop quietly; the
                // frontend reconciles from the persisted chat on reopen.
                Err(e) => {
                    log::warn!("chat events stream for {id} ended: {e}");
                    break;
                }
            }
        }
    });
    *state.events_task.lock() = Some(handle);
    Ok(())
}

/// Stop the active chat-events subscription (called when the chat closes).
#[tauri::command]
async fn stop_chat_events(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(prev) = state.events_task.lock().take() {
        prev.abort();
    }
    Ok(())
}

#[tauri::command]
async fn list_scheduled_tasks(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ScheduledTask>, String> {
    let conn = require_connection(&state)?;
    conn.list_scheduled_tasks().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_scheduled_task(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.cancel_scheduled_task(&id).await.map_err(|e| e.to_string())
}

// ---- Integration packs ----

#[tauri::command]
async fn list_integration_packs(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<PackSummary>, String> {
    let conn = require_connection(&state)?;
    conn.list_integration_packs().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_integration_pack(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<PackDetail, String> {
    let conn = require_connection(&state)?;
    conn.get_integration_pack(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_pack_enabled(
    id: String,
    enabled: bool,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.set_pack_enabled(&id, enabled)
        .await
        .map_err(|e| e.to_string())?;
    // Trigger a snapshot refresh so the sidebar/listings update to reflect
    // newly-available (or newly-hidden) pack content.
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Unknown,
        id: id.clone(),
    });
    Ok(())
}

// ---------- Gateway channel commands ----------

#[tauri::command]
async fn list_gateway_types(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<GatewayType>, String> {
    let conn = require_connection(&state)?;
    conn.list_gateway_types().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_gateway_channels(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<GatewayChannel>, String> {
    let conn = require_connection(&state)?;
    conn.list_gateway_channels().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_gateway_channel_events(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<GatewayEvent>, String> {
    let conn = require_connection(&state)?;
    conn.list_gateway_channel_events(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_gateway_activity(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<GatewayEvent>, String> {
    let conn = require_connection(&state)?;
    conn.list_gateway_activity().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_gateway_channel(
    type_id: String,
    name: String,
    settings: std::collections::HashMap<String, String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<GatewayChannel, String> {
    let conn = require_connection(&state)?;
    conn.create_gateway_channel(&type_id, &name, settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_gateway_channel(
    id: String,
    name: String,
    enabled: bool,
    settings: std::collections::HashMap<String, String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<GatewayChannel, String> {
    let conn = require_connection(&state)?;
    conn.update_gateway_channel(&id, &name, enabled, settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_gateway_channel_enabled(
    id: String,
    enabled: bool,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.set_gateway_channel_enabled(&id, enabled)
        .await
        .map_err(|e| e.to_string())?;
    // Enabling a channel changes which keys are recommended (its type's
    // requires_env), so nudge the UI to refresh.
    state.emit(WorkshopEvent::SaveOk {
        kind: FileKind::Unknown,
        id,
    });
    Ok(())
}

#[tauri::command]
async fn delete_gateway_channel(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = require_connection(&state)?;
    conn.delete_gateway_channel(&id).await.map_err(|e| e.to_string())
}

// ---- Recents ----

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RecentEntry {
    Local { path: String },
    Remote { base_url: String, api_key: String },
}

impl RecentEntry {
    fn local(path: &std::path::Path) -> Self {
        Self::Local {
            path: path.to_string_lossy().to_string(),
        }
    }
    fn remote(base_url: &str, api_key: &str) -> Self {
        Self::Remote {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        }
    }

    /// Key used to dedupe — for remote mode we ignore the api_key so rotating
    /// the key doesn't create a duplicate entry.
    fn dedupe_key(&self) -> String {
        match self {
            Self::Local { path } => format!("local:{path}"),
            Self::Remote { base_url, .. } => format!("remote:{base_url}"),
        }
    }
}

fn recents_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(base.join("metalcraft-workshop").join("recents.json"))
}

fn load_recents() -> Vec<RecentEntry> {
    let Some(p) = recents_path() else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(&p) else {
        return Vec::new();
    };
    // Tolerate the v1 schema (plain list of strings) by falling back to
    // parsing each entry as a Local path. Drop anything unreadable.
    if let Ok(list) = serde_json::from_str::<Vec<RecentEntry>>(&raw) {
        return list;
    }
    if let Ok(legacy) = serde_json::from_str::<Vec<String>>(&raw) {
        return legacy
            .into_iter()
            .map(|p| RecentEntry::Local { path: p })
            .collect();
    }
    Vec::new()
}

fn persist_recent(entry: RecentEntry) {
    let Some(p) = recents_path() else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let key = entry.dedupe_key();
    let mut recents = load_recents();
    recents.retain(|r| r.dedupe_key() != key);
    recents.insert(0, entry);
    recents.truncate(10);
    if let Ok(json) = serde_json::to_string_pretty(&recents) {
        let _ = std::fs::write(&p, json);
    }
}

fn setup_logging() {
    use env_logger::Builder;
    use log::LevelFilter;
    use std::io::Write;

    let log_path = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("metalcraft-workshop")
        .join("debug.log");
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = std::fs::File::create(&log_path).ok();
    let log_file = std::sync::Arc::new(std::sync::Mutex::new(log_file));

    Builder::new()
        .filter_module("workshop", LevelFilter::Info)
        .filter_level(LevelFilter::Warn)
        .format({
            let log_file = log_file.clone();
            move |buf, record| {
                let line = format!(
                    "[{} {} {}] {}\n",
                    chrono::Local::now().format("%H:%M:%S%.3f"),
                    record.level(),
                    record.module_path().unwrap_or("?"),
                    record.args()
                );
                let _ = buf.write_all(line.as_bytes());
                if let Ok(mut guard) = log_file.lock() {
                    if let Some(ref mut f) = *guard {
                        let _ = f.write_all(line.as_bytes());
                        let _ = f.flush();
                    }
                }
                Ok(())
            }
        })
        .init();
    log::info!("Logging initialized: {}", log_path.display());
}

fn main() {
    setup_logging();

    let cli_open = std::env::args().nth(1).map(PathBuf::from);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = Arc::new(AppState {
                connection: Mutex::new(None),
                watcher: Mutex::new(None),
                events_task: Mutex::new(None),
                app_handle: handle.clone(),
            });
            handle.manage(state.clone());

            if let Some(path) = cli_open.clone() {
                if path.is_dir() {
                    let st = state.clone();
                    let path_for_open = path.clone();
                    tauri::async_runtime::spawn(async move {
                        let conn: Arc<dyn ProjectConnection> =
                            Arc::new(LocalConnection::new(path_for_open.clone()));
                        match conn.snapshot().await {
                            Ok(snapshot) => {
                                *st.connection.lock() = Some(conn);
                                let st_watch = st.clone();
                                if let Ok(w) = watcher::start_watching(
                                    &path_for_open,
                                    move |ChangedPath { path, kind }| {
                                        st_watch
                                            .emit(WorkshopEvent::FileChanged { path, kind });
                                    },
                                ) {
                                    *st.watcher.lock() = Some(w);
                                }
                                st.emit(WorkshopEvent::ProjectOpened(snapshot));
                                persist_recent(RecentEntry::local(&path_for_open));
                            }
                            Err(e) => log::error!("cli open failed: {e}"),
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
            open_remote,
            close_project,
            refresh_snapshot,
            get_snapshot,
            list_recents,
            settings_info,
            agent_info,
            get_persona,
            save_persona,
            delete_persona,
            get_skill,
            save_skill,
            delete_skill,
            get_flow,
            save_flow,
            delete_flow,
            list_diagnostics_sessions,
            load_diagnostics_session,
            list_api_tools,
            get_api_tool,
            save_api_tool,
            delete_api_tool,
            list_keys,
            save_key,
            delete_key,
            list_recommended_keys,
            list_flow_templates,
            get_flow_template,
            run_flow,
            list_chats,
            get_chat,
            create_chat,
            delete_chat,
            chat_turn,
            subscribe_chat_events,
            stop_chat_events,
            list_scheduled_tasks,
            cancel_scheduled_task,
            list_integration_packs,
            get_integration_pack,
            set_pack_enabled,
            list_gateway_types,
            list_gateway_channels,
            list_gateway_channel_events,
            list_gateway_activity,
            create_gateway_channel,
            update_gateway_channel,
            set_gateway_channel_enabled,
            delete_gateway_channel,
        ])
        .run(tauri::generate_context!("tauri.conf.json"))
        .expect("error while running tauri application");
}
