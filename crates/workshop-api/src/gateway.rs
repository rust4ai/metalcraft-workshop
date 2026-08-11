//! Gateway channel wire types — mirror the agent's `gateway_channels` module
//! (`ChannelType`, `SettingField`, `ChannelInstance`). Remote-only:
//! LocalConnection returns `NotSupportedInLocalMode` because gateway state is
//! managed by the agent process (`<data>/gateway_channels{,.json}`), the same as
//! integration packs.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One configurable field in a channel type's per-instance settings schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewaySettingField {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub input_type: String,
    #[serde(default)]
    pub required: bool,
    /// When true the value is a channel-scoped secret (saved to the key store
    /// under this channel), not a plaintext setting. Passed through to the
    /// workshop UI, which renders it masked/write-only.
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub help: Option<String>,
}

/// An installed gateway channel type (declarative manifest).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayType {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub adapter: String,
    #[serde(default)]
    pub requires_env: Vec<String>,
    #[serde(default)]
    pub settings: Vec<GatewaySettingField>,
    /// When set, the workshop renders this provider's Connect panel instead of a
    /// manual settings form (e.g. `"metalcraft-gateway"` auto-syncs its config).
    #[serde(default)]
    pub provisioner: Option<String>,
}

/// A user-created configuration of a gateway channel type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayChannel {
    pub id: String,
    pub type_id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub settings: HashMap<String, String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// A channel/connection in the simple model — a named gateway connection
/// `{ slug, name, url }`. Mirrors the agent's `channels::Channel`. `managed`
/// marks the built-in `metalcraft` channel (read-only; secret is the pod token).
/// The secret value is never included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub slug: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub managed: bool,
}

/// One inbound/outbound gateway traffic record, mirroring the agent's
/// `gateway_activity::GatewayEvent`. Used by the per-channel Events view and the
/// global Network view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayEvent {
    pub ts: String,
    pub direction: String,
    pub platform: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub from_name: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub channel_name: Option<String>,
    pub outcome: String,
    #[serde(default)]
    pub detail: Option<String>,
}
