//! Flow file I/O. Thin wrappers over `metalcraft_flows::store::*` and
//! `metalcraft_flows::validate` so the Tauri layer doesn't need a direct
//! dependency on `metalcraft-flows`.

use metalcraft_flows::{
    delete_flow, list_flows, load_flow, save_flow, validate, FlowSummary, SavedFlow,
    ValidationError,
};
use std::path::Path;

pub use metalcraft_flows::{FlowDefinition, FlowEdge, FlowNode, FlowNodeType, CoreNodeType};

pub fn flows_dir(project_root: &Path) -> std::path::PathBuf {
    project_root.join("flows")
}

pub fn list(project_root: &Path) -> Vec<FlowSummary> {
    list_flows(&flows_dir(project_root))
}

pub fn load(project_root: &Path, id: &str) -> anyhow::Result<SavedFlow> {
    load_flow(&flows_dir(project_root), id)
        .ok_or_else(|| anyhow::anyhow!("flow '{}' not found or unparseable", id))
}

pub fn save(project_root: &Path, flow: &SavedFlow) -> anyhow::Result<Vec<ValidationError>> {
    let errors = validate(flow);
    if !errors.is_empty() {
        return Ok(errors);
    }
    save_flow(&flows_dir(project_root), flow)?;
    Ok(Vec::new())
}

pub fn delete(project_root: &Path, id: &str) -> bool {
    delete_flow(&flows_dir(project_root), id)
}

pub fn validate_only(flow: &SavedFlow) -> Vec<ValidationError> {
    validate(flow)
}
