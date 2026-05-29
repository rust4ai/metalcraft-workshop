//! Debounced filesystem watcher for an open project directory.
//!
//! Classifies each changed path into a [`FileKind`] so the frontend can
//! cheaply decide which section needs refreshing.

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebouncedEvent, Debouncer};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crate::commands::FileKind;

pub struct ProjectWatcher {
    _debouncer: Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>,
    _join: thread::JoinHandle<()>,
}

pub struct ChangedPath {
    pub path: PathBuf,
    pub kind: FileKind,
}

/// Start watching `root` recursively. The callback is invoked on a dedicated
/// thread, once per debounced batch element.
pub fn start_watching<F>(root: &Path, mut on_change: F) -> anyhow::Result<ProjectWatcher>
where
    F: FnMut(ChangedPath) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Result<Vec<DebouncedEvent>, _>>();
    let mut debouncer = new_debouncer(Duration::from_millis(300), tx)?;
    debouncer
        .watcher()
        .watch(root, RecursiveMode::Recursive)?;

    let root = root.to_path_buf();
    let join = thread::spawn(move || {
        while let Ok(batch) = rx.recv() {
            let Ok(events) = batch else { continue };
            for ev in events {
                let kind = classify(&root, &ev.path);
                on_change(ChangedPath {
                    path: ev.path,
                    kind,
                });
            }
        }
    });

    Ok(ProjectWatcher {
        _debouncer: debouncer,
        _join: join,
    })
}

fn classify(root: &Path, path: &Path) -> FileKind {
    let Ok(rel) = path.strip_prefix(root) else {
        return FileKind::Unknown;
    };
    let first = rel.iter().next().and_then(|s| s.to_str()).unwrap_or("");
    match first {
        "personas" => FileKind::Persona,
        "skills" => FileKind::Skill,
        "flows" => FileKind::Flow,
        "logs" => FileKind::Diagnostics,
        "api-tools" => FileKind::ApiTool,
        _ => FileKind::Unknown,
    }
}
