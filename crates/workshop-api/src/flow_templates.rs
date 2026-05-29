//! Flow templates. A template is a `SavedFlow` document stored under
//! `<project>/flow_templates/<slug>.json` that the workshop offers as a
//! starting point for new flows. Identical on-disk format to a regular flow.

use serde::{Deserialize, Serialize};
use std::path::Path;

use metalcraft_flows::SavedFlow;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowTemplateSummary {
    pub slug: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowTemplate {
    pub slug: String,
    pub name: String,
    /// Full `SavedFlow` document — caller clones, mutates the id/name/timestamps,
    /// and saves as a regular flow.
    pub flow: SavedFlow,
}

pub fn templates_dir(project_root: &Path) -> std::path::PathBuf {
    project_root.join("flow_templates")
}

pub fn list(project_root: &Path) -> Vec<FlowTemplateSummary> {
    let dir = templates_dir(project_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<FlowTemplateSummary> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let slug = path.file_stem().and_then(|s| s.to_str())?.to_string();
            let content = std::fs::read_to_string(&path).ok()?;
            // Use Value rather than full SavedFlow so a slightly off template
            // still shows up in the picker — only the full load needs to parse.
            let value: serde_json::Value = serde_json::from_str(&content).ok()?;
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&slug)
                .to_string();
            Some(FlowTemplateSummary { slug, name })
        })
        .collect();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

pub fn load(project_root: &Path, slug: &str) -> anyhow::Result<FlowTemplate> {
    let path = templates_dir(project_root).join(format!("{slug}.json"));
    let content = std::fs::read_to_string(&path)?;
    let flow: SavedFlow = serde_json::from_str(&content)?;
    Ok(FlowTemplate {
        slug: slug.to_string(),
        name: flow.name.clone(),
        flow,
    })
}
