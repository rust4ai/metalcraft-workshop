//! Persona file I/O. Mirrors the on-disk format used by
//! `metalcraft-agent/src/persona.rs` — a JSON file per persona under
//! `<project>/personas/<slug>.json`.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Persona {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaSummary {
    pub slug: String,
    pub name: String,
    pub description: String,
}

pub fn personas_dir(project_root: &Path) -> std::path::PathBuf {
    project_root.join("personas")
}

pub fn list(project_root: &Path) -> Vec<PersonaSummary> {
    let dir = personas_dir(project_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<PersonaSummary> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let slug = path.file_stem().and_then(|s| s.to_str())?.to_string();
            let content = std::fs::read_to_string(&path).ok()?;
            let persona: Persona = serde_json::from_str(&content).ok()?;
            Some(PersonaSummary {
                slug,
                name: persona.name,
                description: persona.description,
            })
        })
        .collect();

    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

pub fn load(project_root: &Path, slug: &str) -> anyhow::Result<Persona> {
    let file = personas_dir(project_root).join(format!("{}.json", slug));
    let content = std::fs::read_to_string(&file)?;
    Ok(serde_json::from_str(&content)?)
}

pub fn save(project_root: &Path, slug: &str, persona: &Persona) -> anyhow::Result<()> {
    let dir = personas_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.json", slug));
    let json = serde_json::to_string_pretty(persona)?;
    std::fs::write(&file, json)?;
    Ok(())
}

pub fn delete(project_root: &Path, slug: &str) -> anyhow::Result<()> {
    let file = personas_dir(project_root).join(format!("{}.json", slug));
    if file.exists() {
        std::fs::remove_file(&file)?;
    }
    Ok(())
}

pub fn is_safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
