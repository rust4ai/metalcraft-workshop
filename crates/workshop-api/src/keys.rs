//! API-key / secret store. Mirrors the plaintext JSON store in
//! `metalcraft-agent/src/key_store.rs`: a flat `name → value` map in
//! `<project>/keys.json`. The workshop only ever surfaces **masked** values —
//! raw secrets flow inward (on save) but never back out.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeySummary {
    pub name: String,
    pub masked: String,
}

/// A key that an enabled integration pack declares it needs (via the pack's
/// `requires_env`), annotated with whether it's already configured and which
/// packs want it. Sourced from the agent's `GET /api/v1/keys/recommended` —
/// local mode has no packs, so the list is empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendedKey {
    pub name: String,
    pub configured: bool,
    pub packs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct KeyStore {
    #[serde(flatten)]
    keys: HashMap<String, String>,
}

pub fn keys_file(project_root: &Path) -> PathBuf {
    project_root.join("keys.json")
}

fn load(project_root: &Path) -> KeyStore {
    let content = match std::fs::read_to_string(keys_file(project_root)) {
        Ok(c) => c,
        Err(_) => return KeyStore::default(),
    };
    if content.trim().is_empty() {
        return KeyStore::default();
    }
    serde_json::from_str(&content).unwrap_or_default()
}

fn save_store(project_root: &Path, store: &KeyStore) -> anyhow::Result<()> {
    let path = keys_file(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(store)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Sorted, masked key summaries. Never exposes raw values.
pub fn list(project_root: &Path) -> Vec<KeySummary> {
    let store = load(project_root);
    let mut out: Vec<KeySummary> = store
        .keys
        .iter()
        .map(|(name, value)| KeySummary {
            name: name.clone(),
            masked: mask(value),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn save(project_root: &Path, name: &str, value: &str) -> anyhow::Result<()> {
    if name.trim().is_empty() {
        anyhow::bail!("key name must not be empty");
    }
    if value.is_empty() {
        anyhow::bail!("key value must not be empty");
    }
    let mut store = load(project_root);
    store.keys.insert(name.to_string(), value.to_string());
    save_store(project_root, &store)
}

pub fn delete(project_root: &Path, name: &str) -> anyhow::Result<()> {
    let mut store = load(project_root);
    if store.keys.remove(name).is_none() {
        anyhow::bail!("key '{name}' not found");
    }
    save_store(project_root, &store)
}

/// Mask a secret for display: short values are fully redacted; longer ones
/// keep the first and last 4 characters (`sb_l…a9b2`).
pub fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let n = chars.len();
    if n <= 8 {
        return "••••".to_string();
    }
    let first: String = chars[..4].iter().collect();
    let last: String = chars[n - 4..].iter().collect();
    format!("{first}…{last}")
}
