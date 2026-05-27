// Mirrors the wire types produced by workshop-api. Keep in sync.

export interface PersonaSummary {
  slug: string;
  name: string;
  description: string;
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
}

export interface Skill {
  slug: string;
  description: string;
  body: string;
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
}

export type TimelineEvent =
  | { kind: "turn"; turn: number; messages: ChatMessage[] }
  | { kind: "llm_request"; turn: number; snapshot: unknown }
  | { kind: "config_change"; event: string; after_turn: number; details: unknown }
  | { kind: "compaction"; after_turn: number; before_tokens: number; after_tokens: number };

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
  has_personas_dir: boolean;
  has_skills_dir: boolean;
  has_flows_dir: boolean;
  has_logs_dir: boolean;
}

export interface ProjectSnapshot {
  root: string;
  personas: PersonaSummary[];
  skills: SkillSummary[];
  flows: FlowSummary[];
  sessions: DiagnosticsSessionSummary[];
  layout: ProjectLayout;
}

export type FileKind = "persona" | "skill" | "flow" | "diagnostics" | "unknown";

export type WorkshopEvent =
  | { type: "project_opened"; root: string; personas: PersonaSummary[]; skills: SkillSummary[]; flows: FlowSummary[]; sessions: DiagnosticsSessionSummary[]; layout: ProjectLayout }
  | { type: "project_closed" }
  | ({ type: "snapshot" } & ProjectSnapshot)
  | { type: "file_changed"; path: string; kind: FileKind }
  | { type: "save_ok"; kind: FileKind; id: string }
  | { type: "error"; message: string };
