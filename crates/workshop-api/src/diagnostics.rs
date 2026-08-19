//! Diagnostics-session viewer. Mirrors the writer in
//! `metalcraft-agent/src/diagnostics.rs`: each `<project>/logs/<timestamp>/`
//! directory is a session containing:
//!   - `session_info.json`             — persona/model/cwd/tools/skills
//!   - `turn_NNN.json`                 — agent message history after each turn
//!   - `llm_request_NNN.json`          — raw LLM call snapshot (request only)
//!   - `<event>_after_turn_NNN.json`   — config-change markers
//!   - `compaction_after_turn_NNN.json`— context-compaction markers
//!
//! For the workshop's "chats" view we stitch these back into a
//! [`ChatTimeline`] ordered by turn index.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsSessionSummary {
    pub id: String,
    pub timestamp: String,
    #[serde(default)]
    pub persona_name: Option<String>,
    #[serde(default)]
    pub persona_slug: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    /// "session" for a normal one-shot/diagnostics run, "flow" for a flow run.
    #[serde(default)]
    pub kind: Option<String>,
    /// Present (and `kind == "flow"`) when this session was produced by a flow run.
    #[serde(default)]
    pub flow_id: Option<String>,
    /// The agent this session ran as, so a list can say which one produced it —
    /// the question that matters most for a background agent, whose failures land
    /// here with nobody watching.
    #[serde(default)]
    pub instance_id: Option<String>,
    /// Local mode computes this from the session directory; remote mode leaves
    /// it 0 because the agent's snapshot doesn't include it.
    #[serde(default)]
    pub turn_count: usize,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub persona_name: Option<String>,
    #[serde(default)]
    pub persona_slug: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub auto_approve: bool,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub flow_id: Option<String>,
    /// The agent this session ran as. Absent on CLI runs and on sessions written
    /// before agents existed.
    #[serde(default)]
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineEvent {
    Turn {
        turn: usize,
        messages: Vec<Value>,
    },
    LlmRequest {
        turn: usize,
        snapshot: Value,
    },
    ConfigChange {
        event: String,
        after_turn: usize,
        details: Value,
    },
    Compaction {
        after_turn: usize,
        before_tokens: usize,
        after_tokens: usize,
    },
    /// A turn that failed. Written by the agent (`error_after_turn_NNN.json`)
    /// so the failure reason survives past the ephemeral SSE `done` event.
    Error {
        after_turn: usize,
        message: String,
    },
}

impl TimelineEvent {
    fn sort_key(&self) -> (usize, u8) {
        // u8 is a tiebreaker so multiple events at the same turn render in a
        // sensible order: turn body → llm_request → config_change → compaction.
        match self {
            TimelineEvent::Turn { turn, .. } => (*turn, 0),
            TimelineEvent::LlmRequest { turn, .. } => (*turn, 1),
            TimelineEvent::ConfigChange { after_turn, .. } => (*after_turn, 2),
            TimelineEvent::Compaction { after_turn, .. } => (*after_turn, 3),
            // Render the failure last in its turn group so it reads as the
            // terminal event.
            TimelineEvent::Error { after_turn, .. } => (*after_turn, 4),
        }
    }

    /// Public wrapper used by [`crate::connection::RemoteConnection`] to sort
    /// the events it reassembles from the agent's JSON envelopes.
    pub fn sort_key_pub(&self) -> (usize, u8) {
        self.sort_key()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTimeline {
    pub session: SessionInfo,
    pub events: Vec<TimelineEvent>,
}

pub fn logs_dir(project_root: &Path) -> PathBuf {
    project_root.join("logs")
}

pub fn list_sessions(project_root: &Path) -> Vec<DiagnosticsSessionSummary> {
    let dir = logs_dir(project_root);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<DiagnosticsSessionSummary> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let session_dir = e.path();
            let id = session_dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?")
                .to_string();
            let info_path = session_dir.join("session_info.json");
            let info: Option<SessionInfo> = std::fs::read_to_string(&info_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());
            let turn_count = count_turn_files(&session_dir);
            DiagnosticsSessionSummary {
                timestamp: info
                    .as_ref()
                    .and_then(|i| i.timestamp.clone())
                    .unwrap_or_else(|| id.clone()),
                persona_name: info.as_ref().and_then(|i| i.persona_name.clone()),
                persona_slug: info.as_ref().and_then(|i| i.persona_slug.clone()),
                model_name: info.as_ref().and_then(|i| i.model_name.clone()),
                kind: info.as_ref().and_then(|i| i.kind.clone()),
                flow_id: info.as_ref().and_then(|i| i.flow_id.clone()),
                instance_id: info.as_ref().and_then(|i| i.instance_id.clone()),
                turn_count,
                id,
            }
        })
        .collect();

    // Newest-first; the timestamp directory names sort lexicographically by
    // time since they're written as YYYY-MM-DDTHH-MM-SS.
    out.sort_by(|a, b| b.id.cmp(&a.id));
    out
}

pub fn load_session(project_root: &Path, session_id: &str) -> anyhow::Result<ChatTimeline> {
    let session_dir = logs_dir(project_root).join(session_id);
    if !session_dir.is_dir() {
        anyhow::bail!("session '{}' not found", session_id);
    }

    let info: SessionInfo = std::fs::read_to_string(session_dir.join("session_info.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        // Every field is `#[serde(default)]`, so the empty value *is* the default —
        // spelling it out by hand meant every new field broke two call sites.
        .unwrap_or_default();

    let mut events = Vec::new();
    for entry in std::fs::read_dir(&session_dir)?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == "session_info.json" {
            continue;
        }
        if let Some(ev) = parse_event_file(&path, name) {
            events.push(ev);
        }
    }
    events.sort_by_key(|e| e.sort_key());

    Ok(ChatTimeline {
        session: info,
        events,
    })
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    /// Agent (`workshop_api.rs`) only emits `id, timestamp, persona_slug?,
    /// model_name?`. Workshop adds `persona_name` and `turn_count` for the
    /// richer local view, so its struct must tolerate the agent's sparser
    /// payload without erroring.
    #[test]
    fn diagnostics_summary_accepts_agent_payload() {
        let agent_json = r#"{"id":"2026-05-28T17-46-48","timestamp":"2026-05-28T17-46-48","persona_slug":"reporter","model_name":"opus-4-7"}"#;
        let parsed: DiagnosticsSessionSummary = serde_json::from_str(agent_json).unwrap();
        assert_eq!(parsed.id, "2026-05-28T17-46-48");
        assert_eq!(parsed.persona_name, None);
        assert_eq!(parsed.turn_count, 0);
    }

    /// Same survival check for `SessionInfo`, which the agent may emit with
    /// any subset of fields.
    #[test]
    fn session_info_accepts_empty_payload() {
        let parsed: SessionInfo = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.timestamp, None);
        assert!(parsed.tools.is_empty());
        assert!(!parsed.auto_approve);
    }
}

/// Parse one timeline entry from its filename + already-decoded JSON value.
/// Used by both the local file walker (after reading the file from disk) and
/// the remote client (after receiving the agent's `{file, data}` envelope).
pub fn parse_timeline_entry(name: &str, value: Value) -> Option<TimelineEvent> {
    if let Some(turn) = name
        .strip_prefix("turn_")
        .and_then(|s| s.strip_suffix(".json"))
        .and_then(|s| s.parse::<usize>().ok())
    {
        let messages = value
            .get("messages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        return Some(TimelineEvent::Turn { turn, messages });
    }

    if let Some(turn) = name
        .strip_prefix("llm_request_")
        .and_then(|s| s.strip_suffix(".json"))
        .and_then(|s| s.parse::<usize>().ok())
    {
        return Some(TimelineEvent::LlmRequest {
            turn,
            snapshot: value,
        });
    }

    // Must precede the generic `_after_turn_` config-change branch below,
    // which would otherwise swallow this as an "error" config change.
    if name.starts_with("error_after_turn_") {
        let after_turn = value.get("after_turn").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let message = value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("(no message)")
            .to_string();
        return Some(TimelineEvent::Error {
            after_turn,
            message,
        });
    }

    if name.starts_with("compaction_after_turn_") {
        let after_turn = value.get("after_turn").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let before_tokens = value
            .get("before_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let after_tokens = value
            .get("after_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        return Some(TimelineEvent::Compaction {
            after_turn,
            before_tokens,
            after_tokens,
        });
    }

    if let Some(rest) = name.strip_suffix(".json") {
        if let Some((event, turn_str)) = rest.split_once("_after_turn_") {
            if let Ok(after_turn) = turn_str.parse::<usize>() {
                let details = value.get("details").cloned().unwrap_or(Value::Null);
                return Some(TimelineEvent::ConfigChange {
                    event: event.to_string(),
                    after_turn,
                    details,
                });
            }
        }
    }

    None
}

fn count_turn_files(session_dir: &Path) -> usize {
    let Ok(rd) = std::fs::read_dir(session_dir) else {
        return 0;
    };
    rd.flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with("turn_") && n.ends_with(".json"))
                .unwrap_or(false)
        })
        .count()
}

fn parse_event_file(path: &Path, name: &str) -> Option<TimelineEvent> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    parse_timeline_entry(name, value)
}
