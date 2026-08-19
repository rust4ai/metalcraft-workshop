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
    /// The agent this conversation belongs to. Absent on chats started before
    /// agents existed — the agent backfills those at startup, but a client should
    /// not fall over if it meets one first.
    #[serde(default)]
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatDetail {
    pub id: String,
    pub persona_slug: String,
    pub model_name: String,
    pub created_at: String,
    #[serde(default)]
    pub instance_id: Option<String>,
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
        /// Diagnostics session id (directory name) this turn logs to, so the UI
        /// can deep-link a turn error to its session logs. `None` when the agent
        /// has no active logger for the chat.
        #[serde(default)]
        session_id: Option<String>,
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
    /// The agent's user-facing reply, produced by a `say_to_user` tool call. In
    /// tool-only mode this — not `LlmCompleted` — carries the assistant's
    /// message; the workshop renders it as the reply bubble.
    Reply { content: String },
    /// A classified, user-safe turn failure (e.g. out of inference credits),
    /// emitted just before the trailing `Done`. Newer agents (>=0.13.0) send
    /// this so the desktop can render `message` instead of the raw provider
    /// error chain; `code` is the machine-readable identifier and `retryable`
    /// hints whether trying again is worthwhile.
    Error {
        code: String,
        message: String,
        #[serde(default)]
        retryable: bool,
    },
    Done {
        status: String,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Any event kind this build doesn't recognize. Forward-compat guard: a
    /// newer agent may emit frames added after this client shipped, and an
    /// internally-tagged enum otherwise fails to deserialize an unknown tag —
    /// which the SSE decoder would surface as a spurious transport error. The
    /// UI ignores this variant.
    #[serde(other)]
    Unknown,
}

/// Result of running a flow. Carries both the legacy v1 shape (`prompts`) and
/// the v2 state-machine shape (`run_id`/`status`/`steps`/`variables`); which set
/// is populated depends on the flow's `spec_version`. A `status == "paused"`
/// v2 run can be continued with `resume_flow_run`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFlowResult {
    pub flow_id: String,
    // v1 (legacy linear runner)
    #[serde(default)]
    pub prompts: Vec<RunFlowPromptResult>,
    // v2 (state-machine executor)
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub steps: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub variables: Option<serde_json::Value>,
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
