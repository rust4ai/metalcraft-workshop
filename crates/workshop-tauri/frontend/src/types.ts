// Mirrors the wire types produced by workshop-api. Keep in sync.

export type ConnectionMode = "local" | "remote";

export interface PersonaSummary {
  slug: string;
  name: string;
  description: string;
  pack_id?: string | null;
  read_only?: boolean;
}

export interface Persona {
  name: string;
  description: string;
  tools: string[];
  skills: string[];
  system_prompt: string;
}

export interface SkillSummary {
  slug: string;
  description: string;
  pack_id?: string | null;
  read_only?: boolean;
}

export interface Skill {
  slug: string;
  description: string;
  body: string;
  pack_id?: string | null;
  read_only?: boolean;
}

export interface FlowSummary {
  id: string;
  name: string;
  node_count: number;
  created_at: string;
  updated_at: string;
  enabled: boolean;
}

export interface FlowNode {
  id: string;
  node_type: string; // wire: "entry" | "prompt" | "branch" | "branch_tool" | "vendor:name"
  data: Record<string, unknown>;
  position: [number, number];
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  source_handle?: string;
  target_handle?: string;
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface SavedFlow {
  spec_version: string;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  enabled: boolean;
  flow: FlowDefinition;
}

export interface DiagnosticsSessionSummary {
  id: string;
  timestamp: string;
  persona_name: string | null;
  persona_slug: string | null;
  model_name: string | null;
  /** "session" for a normal run, "flow" for a flow run. */
  kind: string | null;
  /** Present (and kind === "flow") when this session came from a flow run. */
  flow_id: string | null;
  turn_count: number;
}

export interface SessionInfo {
  timestamp: string | null;
  persona_name: string | null;
  persona_slug: string | null;
  model_name: string | null;
  cwd: string | null;
  system_prompt: string | null;
  tools: string[];
  skills: string[];
  auto_approve: boolean;
  kind: string | null;
  flow_id: string | null;
}

export type TimelineEvent =
  | { kind: "turn"; turn: number; messages: ChatMessage[] }
  | { kind: "llm_request"; turn: number; snapshot: unknown }
  | { kind: "config_change"; event: string; after_turn: number; details: unknown }
  | { kind: "compaction"; after_turn: number; before_tokens: number; after_tokens: number }
  | { kind: "error"; after_turn: number; message: string };

export interface ChatTimeline {
  session: SessionInfo;
  events: TimelineEvent[];
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool_call"; id: string; call_id: string; name: string; args: unknown }
  | { role: "tool_result"; id: string; call_id: string; name: string; result: string; is_error?: boolean };

export interface ProjectLayout {
  has_personas: boolean;
  has_skills: boolean;
  has_flows: boolean;
  has_session_logs: boolean;
  has_api_tools: boolean;
}

export interface ApiToolSummary {
  name: string;
  description: string;
  pack_id?: string | null;
  read_only?: boolean;
}

export interface ApiToolConfig {
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  parameters: unknown;
  body_mapping: string;
  body_template?: string | null;
  body_defaults: Record<string, unknown>;
}

/// A stored API key/secret. The raw value is never sent to the UI — only a
/// masked preview (e.g. `sb_l…a9b2`).
export interface KeySummary {
  name: string;
  masked: string;
}

/// A key an enabled integration pack declares it needs (`requires_env`), with
/// whether it's already configured and which packs want it. Remote-only.
export interface RecommendedKey {
  name: string;
  configured: boolean;
  packs: string[];
}

export interface ProjectSnapshot {
  root: string;
  mode: ConnectionMode;
  personas: PersonaSummary[];
  skills: SkillSummary[];
  flows: FlowSummary[];
  sessions: DiagnosticsSessionSummary[];
  api_tools: ApiToolSummary[];
  keys: KeySummary[];
  layout: ProjectLayout;
}

export type FileKind =
  | "persona"
  | "skill"
  | "flow"
  | "diagnostics"
  | "api_tool"
  | "key"
  | "unknown";

export type WorkshopEvent =
  | ({ type: "project_opened" } & ProjectSnapshot)
  | { type: "project_closed" }
  | ({ type: "snapshot" } & ProjectSnapshot)
  | { type: "file_changed"; path: string; kind: FileKind }
  | { type: "save_ok"; kind: FileKind; id: string }
  | { type: "error"; message: string };

// Recents are persisted by the Tauri layer as a tagged union (RecentEntry in
// main.rs). Keep in sync.
export type RecentEntry =
  | { kind: "local"; path: string }
  | { kind: "remote"; base_url: string; api_key: string };

// ── Flow templates / Run flow / Chat ───────────────────────────────────────

export interface FlowTemplateSummary {
  slug: string;
  name: string;
  pack_id?: string | null;
}

export interface FlowTemplate {
  slug: string;
  name: string;
  pack_id?: string | null;
  flow: SavedFlow;
}

// ── Integration packs ──────────────────────────────────────────────────────

export interface PackSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  personas: number;
  skills: number;
  api_tools: number;
  flow_templates: number;
  requires_env: string[];
}

export interface PackDetail {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  requires_env: string[];
  personas: string[];
  skills: string[];
  api_tools: string[];
  flow_templates: string[];
}

export interface RunFlowPromptResult {
  prompt_index: number;
  status: string; // "completed" | "interrupted" | "failed"
  answer: string | null;
  error: string | null;
}

export interface RunFlowResult {
  flow_id: string;
  prompts: RunFlowPromptResult[];
}

export interface ChatSummary {
  id: string;
  persona_slug: string;
  model_name: string;
  created_at: string;
  turn_count: number;
}

export type ChatWireMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool_call"; id: string; call_id?: string | null; name: string; args: unknown }
  | { role: "tool_result"; id: string; call_id?: string | null; name: string; result: string };

export interface ChatDetail {
  id: string;
  persona_slug: string;
  model_name: string;
  created_at: string;
  messages: ChatWireMessage[];
}

export type ChatEvent =
  | {
      kind: "turn_started";
      turn_index: number;
      user_message: string;
      session_id?: string | null;
    }
  | { kind: "llm_started" }
  | { kind: "llm_completed"; messages: ChatWireMessage[]; duration_ms: number }
  | { kind: "tool_started"; tool_call_id: string; name: string; args: unknown }
  | {
      kind: "tool_completed";
      tool_call_id: string;
      name: string;
      duration_ms: number;
      result: ChatWireMessage;
    }
  | { kind: "done"; status: string; reason?: string | null };

/// Emitted on the Tauri event bus per streaming chat turn.
export type ChatStreamEvent = { chat_id: string } & ChatEvent;
