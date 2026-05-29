//! Chat / flow-run wire types shared between Local and Remote connections.
//!
//! Chats and flow runs are remote-only operations (they invoke the agent
//! runtime, which lives in metalcraft-agent). LocalConnection returns
//! `NotSupportedInLocalMode` for these so the UI can show a friendly
//! "connect to a remote agent" message.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSummary {
    pub id: String,
    pub persona_slug: String,
    pub model_name: String,
    pub created_at: String,
    pub turn_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatDetail {
    pub id: String,
    pub persona_slug: String,
    pub model_name: String,
    pub created_at: String,
    pub messages: Vec<ChatWireMessage>,
}

/// Mirrors the agent's `ChatMessageWire`. We accept any unknown role so a
/// future agent change doesn't immediately break the deserializer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum ChatWireMessage {
    User { content: String },
    Assistant { content: String },
    ToolCall {
        id: String,
        #[serde(default)]
        call_id: Option<String>,
        name: String,
        args: serde_json::Value,
    },
    ToolResult {
        id: String,
        #[serde(default)]
        call_id: Option<String>,
        name: String,
        result: String,
    },
}

/// Wire form for SSE events emitted by `POST /api/v1/chats/{id}/turn`.
/// Events form a lifecycle: `turn_started` → (`llm_started` →
/// `llm_completed` → `tool_started`* → `tool_completed`*)+ → `done`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatEvent {
    TurnStarted {
        turn_index: usize,
        user_message: String,
    },
    LlmStarted,
    LlmCompleted {
        messages: Vec<ChatWireMessage>,
        duration_ms: u64,
    },
    ToolStarted {
        tool_call_id: String,
        name: String,
        args: serde_json::Value,
    },
    ToolCompleted {
        tool_call_id: String,
        name: String,
        duration_ms: u64,
        result: ChatWireMessage,
    },
    Done {
        status: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFlowResult {
    pub flow_id: String,
    pub prompts: Vec<RunFlowPromptResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFlowPromptResult {
    pub prompt_index: usize,
    pub status: String,
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Error returned by LocalConnection for chat/run-flow methods.
pub fn not_supported_in_local_mode(action: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "{action} is only available when connected to a remote agent. \
         Open the agent with `metalcraft-daemon --api <KEY>` and connect \
         via the Remote tab in the project picker."
    )
}
