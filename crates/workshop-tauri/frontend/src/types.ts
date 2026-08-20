// Pod-surface DTOs are GENERATED from the agent's published OpenAPI document
// (`src/api-types.ts`, produced by `npm run gen:types` from `openapi.json`), so
// the shapes that are a straight pass-through of the pod's `/api/v1` response
// can't drift from what the pod serializes. Types that the Tauri Rust command
// layer *reshapes* (ProjectSnapshot/ProjectLayout/FlowSummary/ApiToolConfig,
// the v2 flow-run shapes, the chat message unions, …) stay hand-written below,
// since their contract is the Rust command, not the pod schema.
//
// Regenerate after the agent's API changes: in metalcraft-agent run
// `cargo run --example dump_openapi > openapi.json`, copy it here, `gen:types`.
import type { components } from "./api-types";

type S = components["schemas"];

export type ConnectionMode = "local" | "remote";

export type PersonaSummary = S["PersonaSummary"];

// ---- Agents ----------------------------------------------------------------
//
// A *preset* is what this pod can be; an *agent* (the pod calls it an instance) is
// one that actually exists, with its own memory and conversations. Say "agent" in
// the UI — "Amy — Sunday prep" is an agent, and the fact that it instantiates a
// preset is our vocabulary, not the user's.

export type AgentPresetSummary = S["PresetSummary"];
export type AgentPreset = S["AgentPreset"];
/// The list response carries a conversation count the stored record does not, so the
/// list item is the type a UI actually holds.
export type AgentInstance = S["InstanceListItem"];
export type InstanceOrigin = S["InstanceOrigin"];
/// Which agent a flow runs as, plus everything the arm dialog has to state.
export type FlowBinding = S["FlowBindingView"];
export type ArmConsent = S["ArmConsent"];
export type InstanceMemory = S["InstanceMemoryView"];
export type MemorySample = S["MemorySample"];
export type RosterPersona = S["RosterPersona"];
export type AgentPresetDetail = S["PresetDetail"];
export type ScheduledFlowRef = S["ScheduledFlowRef"];

// ---- Agent packs -----------------------------------------------------------
//
// The distribution unit: one preset plus every persona, skill and integration
// it needs. Installing one is where a person grants an agent reach into their
// accounts, so `AgentPackPreview` exists to make that a decision — it is what the
// pod would install, described, without installing it.

export type InstalledAgentPack = S["InstalledAgentPack"];
export type AgentPackManifest = S["AgentPackManifest"];
export type AgentPackPreview = S["AgentPackPreview"];
export type ConsentSummary = S["ConsentSummary"];
export type InstallReport = S["InstallReport"];
export type UninstallReport = S["UninstallReport"];

/// Where an archive comes from. Exactly one, tagged — inspecting and installing must
/// address the same thing, and "url and bytes both set" should not be expressible.
export type PackSource =
  /// A registry URL the *pod* downloads from.
  | { kind: "url"; url: string }
  /// A path on the *pod's* filesystem.
  | { kind: "path"; path: string }
  /// A file on **this** machine. The Rust side reads it and uploads the bytes,
  /// because the pod may be elsewhere and cannot open a path we hand it.
  | { kind: "local_file"; path: string };

/// The Tauri layer reshapes this one: the pod flattens the instance into the
/// response, while the command returns it nested so the two data sources (pod and
/// local directory) can share a type.
export interface InstanceDetail {
  instance: AgentInstance;
  conversations: ChatSummary[];
  scheduled: ScheduledFlowRef[];
}

export interface InstancePatch {
  name?: string;
  persistent?: boolean;
  /// Must be inside the preset's roster; the pod rejects anything else.
  persona?: string;
}

export type Persona = S["Persona"];

export type SkillSummary = S["SkillSummary"];

export type Skill = S["Skill"];

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

/** One integration-pack dependency declared in a flow's `requires` block. */
export interface PackRequirement {
  id: string;
  version?: string | null;
  content_sha256?: string | null;
  reason?: string | null;
  optional?: boolean;
  resolved_version?: string | null;
}

/** A flow's declared dependencies (`requires` block). */
export interface Requires {
  packs?: PackRequirement[];
  tools?: string[];
}

export interface SavedFlow {
  spec_version: string;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  enabled: boolean;
  schedules?: FlowScheduleSpec[];
  requires?: Requires | null;
  flow: FlowDefinition;
}

/** A flow-level schedule — when the flow runs. Mirrors
 *  `metalcraft_flows::FlowScheduleSpec`; trigger fields are flattened via `type`. */
export type ScheduleType = "manual" | "minutes" | "hours" | "cron";
export interface FlowScheduleSpec {
  id: string;
  enabled?: boolean;
  type: ScheduleType;
  interval?: number;
  cron?: string;
  name?: string | null;
  timezone?: string | null;
  inputs?: unknown;
  persona?: string | null;
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
  /** The agent this session ran as. Absent on CLI runs and pre-agent sessions. */
  instance_id?: string | null;
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
  /// The agent this session ran as. Absent on CLI runs and on sessions written
  /// before agents existed.
  instance_id?: string | null;
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
  has_agent_presets: boolean;
  has_agent_instances: boolean;
}

export type ApiToolSummary = S["ApiToolSummary"];

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
export type KeySummary = S["KeySummary"];

/// A stored key with its scope, returned by the `list_keys` command. `global`
/// keys are account-wide; `channel` keys are secrets owned by one gateway
/// channel (with `channel_id`/`channel_name` set). `managed` keys are written by
/// a connection/the platform and are read-only in the UI.
export type KeyEntry = S["KeyEntry"];

/// A key an enabled integration declares it needs (`requires_env`), with
/// whether it's already configured, which packs want it, and whether it's
/// platform-managed. Remote-only.
export type RecommendedKey = S["RecommendedKey"];

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
  /// What this pod can be. Empty against an agent old enough to predate presets,
  /// which is the signal to fall back to the persona picker.
  agent_presets: AgentPresetSummary[];
  /// Agents that exist. Persistent ones only from a pod — every chat mints an
  /// ephemeral instance, so an unfiltered list is one row per chat and pure noise.
  agent_instances: AgentInstance[];
  default_agent_preset: string | null;
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
  | { type: "error"; message: string }
  // A `metalcraft-workshop://install?url=…` deep link, from a registry page.
  // Carries the archive URL only — the app still inspects and asks, because
  // arriving from a web page is not consent.
  | { type: "install_requested"; url: string };

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

export type FlowTemplateSummary = S["FlowTemplateSummary"];

export interface FlowTemplate {
  slug: string;
  name: string;
  pack_id?: string | null;
  flow: SavedFlow;
}

// ── Integrations ──────────────────────────────────────────────────────

export type PackSummary = S["IntegrationSummary"];

export type PackDetail = S["IntegrationDetail"];

// ── Gateway ────────────────────────────────────────────────────────────────

/** Registration/verification/connection state for the Metalcraft Gateway Connect panel. */
export type MetalcraftGatewayStatus = S["GatewayStatus"];

/** A channel/connection in the simple model — `{ slug, name, url, enabled, managed }`. */
export type Channel = S["Channel"];

export type GatewayDirection = "inbound" | "outbound";

export type GatewayOutcome =
  | "routed"
  | "no_matching_channel"
  | "no_persona"
  | "signature_rejected"
  | "sent"
  | "send_failed"
  | string;

export type GatewayEvent = S["GatewayEvent"];

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
  warnings?: string[];
}

// ── Flow install + pack/lockfile shapes — aliased from the generated schemas ──
// The agent publishes `ToSchema` for all of these, so they track the pod. (The
// pre-existing `RunFlowResult`/`FlowRun`/`FlowStep` above stay hand-typed: the
// editor reads v1 and v2 fields off one merged value, which a `oneOf` union
// wouldn't allow without extra narrowing.)
export type DependencyReport = S["DependencyReport"];
export type InstalledFlow = S["InstalledFlow"];
export type InstallResult = S["InstallResult"];
export type PackInstallOutcome = S["PackInstallOutcome"];
export type InstallFlowDependenciesResult = S["InstallDependenciesResponse"];
export type UninstallPackResult = S["UninstallPackResult"];
export type LockEntry = S["LockEntry"];
export type Lock = S["Lock"];
export type RestoreOutcome = S["RestoreOutcome"];
export type RestoreLockfileResult = S["RestoreResult"];

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
  warnings?: string[];
  created_at: string;
  updated_at: string;
}

export type ChatSummary = S["ChatSummary"];

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
  | { kind: "error"; code: string; message: string; retryable: boolean }
  | { kind: "done"; status: string; reason?: string | null };

/// Emitted on the Tauri event bus per streaming chat turn.
export type ChatStreamEvent = { chat_id: string } & ChatEvent;
