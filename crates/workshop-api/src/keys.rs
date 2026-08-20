//! API-key / secret store. Mirrors the **scoped** plaintext JSON store in
//! `metalcraft-agent/src/key_store.rs`: a v2 `{ version, global, channels }`
//! object in `<project>/keys.json`. A pre-v2 flat `name → value` file is read
//! transparently (its entries become `global`). The workshop only ever surfaces
//! **masked** values — raw secrets flow inward (on save) but never back out.
//!
//! This module backs **local** mode; remote mode talks to the agent's HTTP API.
//! Local projects have no gateway channels, so channel scope is rarely populated
//! here, but read/write support it for parity with the remote store.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeySummary {
    pub name: String,
    pub masked: String,
}

/// A stored key with its scope and whether it's managed (read-only in the UI).
/// Mirrors the agent's `KeyEntry`. `channel_id`/`channel_name` are set only for
/// channel scope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEntry {
    pub name: String,
    pub masked: String,
    /// `"global"` or `"channel"`.
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    #[serde(default)]
    pub managed: bool,
}

/// A key that an enabled integration declares it needs (via the pack's
/// `requires_env`), annotated with whether it's already configured and which
/// packs want it. Sourced from the agent's `GET /api/v1/keys/recommended` —
/// local mode has no packs, so the list is empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendedKey {
    pub name: String,
    pub configured: bool,
    pub packs: Vec<String>,
    /// Platform-managed (env-authoritative, e.g. a token injected into a
    /// provisioned pod): shown as provided/read-only rather than prompting for a
    /// value. The agent sends this on `GET /api/v1/keys/recommended`; this struct
    /// used to drop it. `#[serde(default)]` keeps local mode (empty list) working.
    #[serde(default)]
    pub managed: bool,
}

const CURRENT_VERSION: u32 = 2;

fn current_version() -> u32 {
    CURRENT_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeyStore {
    #[serde(default = "current_version")]
    version: u32,
    #[serde(default)]
    global: BTreeMap<String, String>,
    #[serde(default)]
    channels: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for KeyStore {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            global: BTreeMap::new(),
            channels: BTreeMap::new(),
        }
    }
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
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return KeyStore::default(),
    };
    // v2 files carry a numeric `version`; anything else is the legacy flat map.
    if value.get("version").and_then(|v| v.as_u64()).is_some() {
        serde_json::from_value(value).unwrap_or_default()
    } else {
        let mut global = BTreeMap::new();
        if let Some(obj) = value.as_object() {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    global.insert(k.clone(), s.to_string());
                }
            }
        }
        KeyStore { version: CURRENT_VERSION, global, channels: BTreeMap::new() }
    }
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

/// Sorted, masked **global** key summaries (for the load-time snapshot + sidebar).
pub fn list(project_root: &Path) -> Vec<KeySummary> {
    load(project_root)
        .global
        .iter()
        .map(|(name, value)| KeySummary { name: name.clone(), masked: mask(value) })
        .collect()
}

/// Sorted, masked keys with scope, for the scope-aware Keys page. Local projects
/// have no channel metadata, so channel entries carry no `channel_name` and are
/// never `managed`.
pub fn list_entries(project_root: &Path) -> Vec<KeyEntry> {
    let store = load(project_root);
    let mut out: Vec<KeyEntry> = store
        .global
        .iter()
        .map(|(name, value)| KeyEntry {
            name: name.clone(),
            masked: mask(value),
            scope: "global".to_string(),
            channel_id: None,
            channel_name: None,
            managed: false,
        })
        .collect();
    for (id, m) in &store.channels {
        for (name, value) in m {
            out.push(KeyEntry {
                name: name.clone(),
                masked: mask(value),
                scope: "channel".to_string(),
                channel_id: Some(id.clone()),
                channel_name: None,
                managed: false,
            });
        }
    }
    out
}

/// Upsert a key. `channel_id` targets a channel's secret scope; `None` is global.
pub fn save(
    project_root: &Path,
    name: &str,
    value: &str,
    channel_id: Option<&str>,
) -> anyhow::Result<()> {
    if name.trim().is_empty() {
        anyhow::bail!("key name must not be empty");
    }
    if value.is_empty() {
        anyhow::bail!("key value must not be empty");
    }
    let mut store = load(project_root);
    match channel_id {
        Some(cid) => {
            store.channels.entry(cid.to_string()).or_default().insert(name.to_string(), value.to_string());
        }
        None => {
            store.global.insert(name.to_string(), value.to_string());
        }
    }
    save_store(project_root, &store)
}

/// Reveal a key's **raw** stored value. `channel_id` targets a channel's secret
/// scope; `None` is global. Errors if there's no stored value for that scope.
pub fn reveal(project_root: &Path, name: &str, channel_id: Option<&str>) -> anyhow::Result<String> {
    let store = load(project_root);
    let value = match channel_id {
        Some(cid) => store.channels.get(cid).and_then(|m| m.get(name)),
        None => store.global.get(name),
    };
    value
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("key '{name}' has no stored value to reveal"))
}

/// Delete a key. `channel_id` targets a channel's secret scope; `None` is global.
pub fn delete(project_root: &Path, name: &str, channel_id: Option<&str>) -> anyhow::Result<()> {
    let mut store = load(project_root);
    let removed = match channel_id {
        Some(cid) => match store.channels.get_mut(cid) {
            Some(m) => {
                let r = m.remove(name).is_some();
                if m.is_empty() {
                    store.channels.remove(cid);
                }
                r
            }
            None => false,
        },
        None => store.global.remove(name).is_some(),
    };
    if !removed {
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
