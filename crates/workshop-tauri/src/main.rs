// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};

use workshop_api::commands::{FileKind, WorkshopEvent};
use workshop_api::{
    diagnostics, flows, personas, project, skills,
    watcher::{self, ChangedPath, ProjectWatcher},
};

/// Shared app state: the currently-open project root (if any) and its
/// filesystem watcher.
struct AppState {
    project_root: Mutex<Option<PathBuf>>,
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

// ---------- Tauri commands ----------

#[tauri::command]
async fn open_project(
    path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    let snapshot = project::scan_project(&path);

    // Replace current project + watcher.
    *state.project_root.lock() = Some(path.clone());
    let st = state.inner().clone();
    let watcher = watcher::start_watching(&path, move |ChangedPath { path, kind }| {
        st.emit(WorkshopEvent::FileChanged { path, kind });
    })
    .map_err(|e| format!("watcher: {e}"))?;
    *state.watcher.lock() = Some(watcher);

    state.emit(WorkshopEvent::ProjectOpened(snapshot));
    persist_recent(&path);
    Ok(())
}

#[tauri::command]
async fn close_project(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.project_root.lock() = None;
    *state.watcher.lock() = None;
    state.emit(WorkshopEvent::ProjectClosed);
    Ok(())
}

#[tauri::command]
async fn refresh_snapshot(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let Some(root) = state.project_root.lock().clone() else {
        return Err("no project open".into());
    };
    let snapshot = project::scan_project(&root);
    state.emit(WorkshopEvent::Snapshot(snapshot));
    Ok(())
}

#[tauri::command]
async fn get_snapshot(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<project::ProjectSnapshot>, String> {
    let root = state.project_root.lock().clone();
    Ok(root.map(|r| project::scan_project(&r)))
}

#[tauri::command]
async fn list_recents() -> Result<Vec<String>, String> {
    Ok(load_recents()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

// ---- Personas ----

#[tauri::command]
async fn get_persona(
    slug: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<personas::Persona, String> {
    let root = require_root(&state)?;
    personas::load(&root, &slug).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_persona(
    slug: String,
    persona: personas::Persona,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let root = require_root(&state)?;
    if !personas::is_safe_slug(&slug) {
        return Err(format!("unsafe slug: {slug}"));
    }
    personas::save(&root, &slug, &persona).map_err(|e| e.to_string())?;
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
    let root = require_root(&state)?;
    personas::delete(&root, &slug).map_err(|e| e.to_string())
}

// ---- Skills ----

#[tauri::command]
async fn get_skill(
    slug: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<skills::Skill, String> {
    let root = require_root(&state)?;
    skills::load(&root, &slug).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_skill(
    slug: String,
    description: String,
    body: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let root = require_root(&state)?;
    skills::save(&root, &slug, &description, &body).map_err(|e| e.to_string())?;
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
    let root = require_root(&state)?;
    skills::delete(&root, &slug).map_err(|e| e.to_string())
}

// ---- Flows ----

#[tauri::command]
async fn get_flow(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<metalcraft_flows::SavedFlow, String> {
    let root = require_root(&state)?;
    flows::load(&root, &id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_flow(
    flow: metalcraft_flows::SavedFlow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let root = require_root(&state)?;
    let id = flow.id.clone();
    let errors = flows::save(&root, &flow).map_err(|e| e.to_string())?;
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
    let root = require_root(&state)?;
    Ok(flows::delete(&root, &id))
}

// ---- Diagnostics ----

#[tauri::command]
async fn list_diagnostics_sessions(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<diagnostics::DiagnosticsSessionSummary>, String> {
    let root = require_root(&state)?;
    Ok(diagnostics::list_sessions(&root))
}

#[tauri::command]
async fn load_diagnostics_session(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<diagnostics::ChatTimeline, String> {
    let root = require_root(&state)?;
    diagnostics::load_session(&root, &id).map_err(|e| e.to_string())
}

// ---- Helpers ----

fn require_root(state: &tauri::State<'_, Arc<AppState>>) -> Result<PathBuf, String> {
    state
        .project_root
        .lock()
        .clone()
        .ok_or_else(|| "no project open".to_string())
}

fn recents_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    Some(base.join("metalcraft-workshop").join("recents.json"))
}

fn load_recents() -> Vec<PathBuf> {
    let Some(p) = recents_path() else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(&p) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn persist_recent(path: &std::path::Path) {
    let Some(p) = recents_path() else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut recents = load_recents();
    recents.retain(|r| r != path);
    recents.insert(0, path.to_path_buf());
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
                project_root: Mutex::new(None),
                watcher: Mutex::new(None),
                app_handle: handle.clone(),
            });
            handle.manage(state.clone());

            if let Some(path) = cli_open.clone() {
                if path.is_dir() {
                    let snapshot = project::scan_project(&path);
                    *state.project_root.lock() = Some(path.clone());
                    let st = state.clone();
                    if let Ok(w) = watcher::start_watching(&path, move |ChangedPath { path, kind }| {
                        st.emit(WorkshopEvent::FileChanged { path, kind });
                    }) {
                        *state.watcher.lock() = Some(w);
                    }
                    state.emit(WorkshopEvent::ProjectOpened(snapshot));
                    persist_recent(&path);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
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
        ])
        .run(tauri::generate_context!("tauri.conf.json"))
        .expect("error while running tauri application");
}
