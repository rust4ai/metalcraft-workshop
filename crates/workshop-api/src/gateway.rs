//! Gateway wire types — the channels connection model + the activity feed,
//! mirroring the agent. Remote-only: LocalConnection returns
//! `NotSupportedInLocalMode` because gateway state is managed by the agent
//! process, the same as integrations.

use serde::{Deserialize, Serialize};

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
