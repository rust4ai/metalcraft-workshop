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
    connection::{LocalConnection, ProjectConnection, RemoteConnection},
    diagnostics,
    flow_templates::{FlowTemplate, FlowTemplateSummary},
    personas, project, skills,
    watcher::{self, ChangedPath, ProjectWatcher},
};

/// Shared app state: the currently-active connection (local dir or remote
/// agent), plus the filesystem watcher (only attached in local mode).
struct AppState {
    connection: Mutex<Option<Arc<dyn ProjectConnection>>>,
    watcher: Mutex<Option<ProjectWatcher>>,
    app_handle: tauri::AppHandle,
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
    conn.delete_persona(&slug).await.map_err(|e| e.to_string())
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
    conn.delete_skill(&slug).await.map_err(|e| e.to_string())
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
    conn.delete_flow(&id).await.map_err(|e| e.to_string())
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
    conn.delete_api_tool(&name).await.map_err(|e| e.to_string())
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
                // Surface decode errors as a synthetic 'done failed' event so
                // the UI doesn't sit waiting forever.
                let payload = ChatStreamEvent {
                    chat_id: id.clone(),
                    event: ChatEvent::Done {
                        status: "failed".into(),
                        reason: Some(e.to_string()),
                    },
                };
                let _ = app_handle.emit("chat-stream", &payload);
                return Err(e.to_string());
            }
        }
    }
    Ok(())
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
            list_flow_templates,
            get_flow_template,
            run_flow,
            list_chats,
            get_chat,
            create_chat,
            delete_chat,
            chat_turn,
        ])
        .run(tauri::generate_context!("tauri.conf.json"))
        .expect("error while running tauri application");
}
