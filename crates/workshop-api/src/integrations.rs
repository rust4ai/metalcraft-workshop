//! Integration wire types — mirror the agent's `IntegrationSummary`
//! and `IntegrationDetail`. Remote-only; LocalConnection returns
//! `NotSupportedInLocalMode` because pack state lives in the agent's
//! process-managed `<data>/integrations.json`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub enabled: bool,
    pub personas: usize,
    pub skills: usize,
    pub api_tools: usize,
    pub flow_templates: usize,
    #[serde(default)]
    pub requires_env: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub enabled: bool,
    #[serde(default)]
    pub requires_env: Vec<String>,
    pub personas: Vec<String>,
    pub skills: Vec<String>,
    pub api_tools: Vec<String>,
    pub flow_templates: Vec<String>,
}
