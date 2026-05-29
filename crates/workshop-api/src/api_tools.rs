//! HTTP-API tool configs. Mirrors the JSON-on-disk format used by
//! `metalcraft-agent/src/tools/http_api.rs` (`HttpApiToolConfig`). One file
//! per tool under `<project>/api-tools/<name>.json`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToolConfig {
    pub name: String,
    pub description: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub parameters: serde_json::Value,
    #[serde(default = "default_body_mapping")]
    pub body_mapping: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_template: Option<String>,
    #[serde(default)]
    pub body_defaults: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToolSummary {
    pub name: String,
    pub description: String,
}

fn default_body_mapping() -> String {
    "params".to_string()
}

pub fn api_tools_dir(project_root: &Path) -> std::path::PathBuf {
    project_root.join("api-tools")
}

pub fn list(project_root: &Path) -> Vec<ApiToolSummary> {
    let dir = api_tools_dir(project_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<ApiToolSummary> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let content = std::fs::read_to_string(&path).ok()?;
            let config: ApiToolConfig = serde_json::from_str(&content).ok()?;
            Some(ApiToolSummary {
                name: config.name,
                description: config.description,
            })
        })
        .collect();

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn load(project_root: &Path, name: &str) -> anyhow::Result<ApiToolConfig> {
    let file = api_tools_dir(project_root).join(format!("{}.json", name));
    let content = std::fs::read_to_string(&file)?;
    Ok(serde_json::from_str(&content)?)
}

pub fn save(project_root: &Path, name: &str, config: &ApiToolConfig) -> anyhow::Result<()> {
    let dir = api_tools_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&file, json)?;
    Ok(())
}

pub fn delete(project_root: &Path, name: &str) -> anyhow::Result<()> {
    let file = api_tools_dir(project_root).join(format!("{}.json", name));
    if file.exists() {
        std::fs::remove_file(&file)?;
    }
    Ok(())
}
