//! Integration wire types — mirror the agent's `IntegrationSummary`
//! and `IntegrationDetail`. Remote-only; LocalConnection returns
//! `NotSupportedInLocalMode` because pack state lives in the agent's
//! process-managed `<data>/integrations.json`.
//!
//! An integration is the API tools behind one service, vendored by whichever agent
//! pack needed them. The personas and skills the agent still reports on these
//! records belong to that pack, not to the integration, so they are dropped on the
//! way in rather than mirrored into a type that would imply otherwise.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub enabled: bool,
    pub api_tools: usize,
    pub flow_templates: usize,
    #[serde(default)]
    pub requires_env: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub enabled: bool,
    #[serde(default)]
    pub requires_env: Vec<String>,
    pub api_tools: Vec<String>,
    pub flow_templates: Vec<String>,
}
