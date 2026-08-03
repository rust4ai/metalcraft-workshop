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
  // Not edited by the workshop form, but carried through so save() doesn't
  // drop them (packs = pack-scoped tools; version = agent force-upgrade tag).
  packs?: string[];
  skills: string[];
  version?: string | null;
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

/// Returned by the `agent_info` Tauri command (from the agent's `/api/v1/info`).
export interface AgentInfo {
  name?: string | null;
  version?: string | null;
  /** Persona the New Chat modal defaults to; null in local mode / older agent. */
  default_persona?: string | null;
}

/// Returned by the `settings_info` Tauri command. Mirrors `SettingsInfo` in
/// workshop-tauri/src/main.rs.
export interface SettingsInfo {
  /** Version of this Workshop desktop app. */
  workshop_version: string;
  /** Connected agent's version; null in local mode / unreachable / older agent. */
  agent_version: string | null;
  /** Whether the agent's info endpoint was reached (always false in local mode). */
  agent_reachable: boolean;
}

/// A scheduled follow-up, from the agent's `/api/v1/scheduled-tasks`. Mirrors
/// `ScheduledTask` in workshop-api. Timestamps are RFC3339 strings.
export interface ScheduledTask {
  id: string;
  chat_id?: string | null;
  run_at: string;
  created_at: string;
  task: string;
  persona?: string | null;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
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

// ── Metalcraft login (metalcraft-id + pod picker) ──────────────────────────

/// Returned by `metalcraft_login_start` — the pending device-login request.
export interface MetalcraftLoginStart {
  device_code: string;
  user_code: string;
  verify_url: string;
  interval_secs: number;
  expires_at: string;
}

/// Result of a `metalcraft_login_poll` call.
export type MetalcraftPollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "signed_in"; email: string; premium: boolean };

/// The persisted metalcraft-id session surfaced to the UI (email only).
export interface MetalcraftSession {
  email: string;
}

/// One agent pod from the control plane's `GET /api/pods`.
export interface MetalcraftPod {
  id: string;
  slug: string;
  status: string; // "pending" | "active" | "suspended"
  has_token: boolean;
  url: string;
}

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

// ── Gateway channels ───────────────────────────────────────────────────────

export interface GatewaySettingField {
  key: string;
  label: string;
  input_type: string; // "text" | "tel" | "password" | "number" | "persona" | "model"
  required: boolean;
  placeholder?: string | null;
  help?: string | null;
}

export interface GatewayType {
  id: string;
  name: string;
  description: string;
  version: string;
  adapter: string;
  requires_env: string[];
  settings: GatewaySettingField[];
  /** When set, the workshop renders that provider's Connect panel instead of a
   * manual settings form (e.g. "metalcraft-gateway" auto-syncs its config). */
  provisioner?: string | null;
}

/** Registration/verification/connection state for the Metalcraft Gateway Connect panel. */
export interface MetalcraftGatewayStatus {
  configured: boolean;
  registered: boolean;
  verified: boolean;
  connected: boolean;
  active_number?: string | null;
  channel?: string | null;
  has_public_url: boolean;
  error?: string | null;
}

export interface GatewayChannel {
  id: string;
  type_id: string;
  name: string;
  enabled: boolean;
  settings: Record<string, string>;
  created_at?: string | null;
}

export type GatewayDirection = "inbound" | "outbound";

export type GatewayOutcome =
  | "routed"
  | "no_matching_channel"
  | "no_persona"
  | "signature_rejected"
  | "sent"
  | "send_failed"
  | string;

export interface GatewayEvent {
  ts: string;
  direction: GatewayDirection;
  platform: string;
  from?: string | null;
  from_name?: string | null;
  to?: string | null;
  body: string;
  source_id?: string | null;
  channel_id?: string | null;
  channel_name?: string | null;
  outcome: GatewayOutcome;
  detail?: string | null;
}

export interface RunFlowPromptResult {
  prompt_index: number;
  status: string; // "completed" | "interrupted" | "failed"
  answer: string | null;
  error: string | null;
}

export interface FlowStep {
  node_id: string;
  node_type: string;
  outcome: string; // advanced | routed:<h> | completed | failed | paused:<reason>
  detail?: string | null;
}

// Carries both the legacy v1 shape (`prompts`) and the v2 state-machine shape
// (`run_id`/`status`/`steps`/`variables`). A v2 run with status "paused" can be
// continued via the `resume_flow_run` command.
export interface RunFlowResult {
  flow_id: string;
  prompts?: RunFlowPromptResult[];
  run_id?: string;
  status?: string; // "completed" | "failed" | "paused"
  steps?: FlowStep[];
  variables?: Record<string, unknown>;
}

export interface FlowRunPause {
  reason: string; // "approval" | "wait"
  resume_handles: string[];
  message?: string | null;
  wake_at?: string | null;
}

// A persisted flow run (from get_flow_run / list_flow_runs).
export interface FlowRun {
  id: string;
  flow_id: string;
  status: string;
  current_node_id: string;
  variables: Record<string, unknown>;
  pause?: FlowRunPause | null;
  steps: FlowStep[];
  created_at: string;
  updated_at: string;
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
  | { kind: "reply"; content: string }
  | { kind: "done"; status: string; reason?: string | null };

/// Emitted on the Tauri event bus per streaming chat turn.
export type ChatStreamEvent = { chat_id: string } & ChatEvent;
