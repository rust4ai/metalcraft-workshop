import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatSummary, DiagnosticsSessionSummary, InstallResult, ProjectSnapshot } from "../types";
import type { Section } from "../App";

interface Props {
  snapshot: ProjectSnapshot;
  section: Section;
  selectedId: string | null;
  onSection: (s: Section) => void;
  onSelect: (id: string | null) => void;
  /// Live chat list, fetched from the agent on tab entry (not from snapshot).
  chats: ChatSummary[];
  /// Live diagnostics-session list, fetched from the agent on tab entry.
  sessions: DiagnosticsSessionSummary[];
}

const SECTIONS: { id: Section; label: string }[] = [
  // Agents lead: picking one is how work starts now. Personas stay — authoring them
  // is still a real task, it is just no longer the entry point.
  { id: "agents", label: "Agents" },
  { id: "personas", label: "Personas" },
  { id: "skills", label: "Skills" },
  { id: "flows", label: "Flows" },
  { id: "chats", label: "Chats" },
  { id: "sessions", label: "Sessions" },
  { id: "api_tools", label: "API tools" },
  { id: "keys", label: "Keys" },
  { id: "packs", label: "Packs" },
  { id: "gateway", label: "Gateway" },
  { id: "network", label: "Network" },
  { id: "settings", label: "Settings" },
];

export default function Sidebar({ snapshot, section, selectedId, onSection, onSelect, chats, sessions }: Props) {
  const items = listItems(snapshot, section, chats, sessions);

  return (
    <aside className="w-64 flex flex-col bg-surface-1 border-r border-surface-3">
      <nav className="flex flex-wrap border-b border-surface-3">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => onSection(s.id)}
            className={`flex-1 min-w-[60px] px-2 py-2 text-[10px] font-medium uppercase tracking-wide transition-colors ${
              section === s.id
                ? "bg-surface-2 text-accent border-b-2 border-accent"
                : "text-gray-500 hover:text-gray-200 hover:bg-surface-2"
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-gray-500">
            {emptyMessage(snapshot, section)}
          </p>
        ) : (
          <ul>
            {items.map((it) => (
              <li key={it.id}>
                <button
                  onClick={() => onSelect(it.id)}
                  className={`w-full text-left px-3 py-2 border-b border-surface-2 transition-colors ${
                    selectedId === it.id
                      ? "bg-accent/20 text-accent-light"
                      : "hover:bg-surface-2 text-gray-300"
                  }`}
                >
                  <div className="text-sm font-medium truncate flex items-center gap-1.5">
                    <span className="truncate">{it.label}</span>
                    {it.packId && (
                      <span
                        className="px-1 py-px text-[9px] uppercase tracking-wide bg-accent/20 text-accent-light rounded font-mono"
                        title={`from '${it.packId}' integration pack — read-only`}
                      >
                        {it.packId}
                      </span>
                    )}
                  </div>
                  {it.sub && (
                    <div className="text-xs text-gray-500 truncate">{it.sub}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {section === "flows" && (
        <div className="flex flex-col">
          <NewButton onClick={() => onSelect("__new__")} label="+ New Flow" />
          <InstallFromRegistry
            label="Install flow from registry…"
            onInstall={(slug) => invoke<InstallResult>("install_flow", { slug })}
          />
        </div>
      )}
      {section === "personas" && (
        <NewButton onClick={() => onSelect("__new__")} label="+ New Persona" />
      )}
      {section === "skills" && (
        <NewButton onClick={() => onSelect("__new__")} label="+ New Skill" />
      )}
      {section === "api_tools" && (
        <NewButton onClick={() => onSelect("__new__")} label="+ New API Tool" />
      )}
      {section === "keys" && (
        <NewButton onClick={() => onSelect("__new__")} label="+ New Key" />
      )}
      {section === "chats" && (
        <NewButton onClick={() => onSelect("__new__")} label="+ New Chat" />
      )}
      {section === "gateway" && (
        <NewButton onClick={() => onSelect("__new__")} label="+ New Channel" />
      )}
    </aside>
  );
}

function NewButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="mx-3 my-2 px-3 py-1.5 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded"
    >
      {label}
    </button>
  );
}

/** Install a flow (or pack) from the registry by slug. The install command emits
 *  a `save_ok` workshop-event, so the sidebar list refreshes on its own. */
function InstallFromRegistry({
  label,
  onInstall,
}: {
  label: string;
  onInstall: (slug: string) => Promise<unknown>;
}) {
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const s = slug.trim();
    if (!s || busy) return;
    setBusy(true);
    try {
      await onInstall(s);
      setSlug("");
    } catch (e) {
      console.error("install from registry", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-3 mb-2 flex gap-1">
      <input
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && run()}
        placeholder={label}
        className="flex-1 min-w-0 px-2 py-1 bg-surface-2 border border-surface-3 rounded text-xs"
      />
      <button
        onClick={run}
        disabled={busy || !slug.trim()}
        className="px-2 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded disabled:opacity-40"
      >
        {busy ? "…" : "Install"}
      </button>
    </div>
  );
}

interface SidebarItem {
  id: string;
  label: string;
  sub?: string;
  /// If set, the item is provided by an enabled integration pack and renders
  /// with a small "pack" chip + slightly dimmed text.
  packId?: string | null;
}

function listItems(
  snap: ProjectSnapshot,
  s: Section,
  chats: ChatSummary[],
  sessions: DiagnosticsSessionSummary[],
): SidebarItem[] {
  switch (s) {
    case "agents":
      // The Agents panel renders both its lists in the main pane — a preset and an
      // agent are different enough that one flat sidebar list would lie about it.
      return [];
    case "personas":
      return snap.personas.map((p) => ({
        id: p.slug,
        label: p.name,
        sub: p.slug,
        packId: p.pack_id ?? null,
      }));
    case "skills":
      return snap.skills.map((sk) => ({
        id: sk.slug,
        label: sk.slug,
        sub: sk.description,
        packId: sk.pack_id ?? null,
      }));
    case "flows":
      return snap.flows.map((f) => ({
        id: f.id,
        label: f.name,
        sub: `${f.node_count} nodes${f.enabled ? " • enabled" : ""}`,
      }));
    case "chats":
      // Label by the agent the conversation belongs to, falling back to the persona
      // for chats that predate agents. Which agent said a thing is the question
      // someone scanning this list is actually asking.
      return chats.map((c) => ({
        id: c.id,
        label: agentName(snap, c.instance_id) ?? c.persona_slug,
        sub: [
          c.instance_id ? c.persona_slug : null,
          c.model_name,
          `${c.turn_count} turns`,
        ]
          .filter(Boolean)
          .join(" • "),
      }));
    case "sessions":
      return sessions.map((s) => ({
        id: s.id,
        label: s.kind === "flow" && s.flow_id ? `⚙ ${s.flow_id}` : s.timestamp,
        sub: [
          s.kind === "flow"
            ? s.timestamp
            : (agentName(snap, s.instance_id) ?? s.persona_slug),
          s.model_name,
          `${s.turn_count} turns`,
        ]
          .filter(Boolean)
          .join(" • "),
      }));
    case "api_tools":
      return snap.api_tools.map((t) => ({
        id: t.name,
        label: t.name,
        sub: t.description,
        packId: t.pack_id ?? null,
      }));
    case "keys":
      return snap.keys.map((k) => ({
        id: k.name,
        label: k.name,
        sub: k.masked,
      }));
    case "packs":
      return [];
    case "gateway":
      // The Gateway panel fetches and lists its own channels (like Packs).
      return [];
    case "network":
      // The Network panel fetches its own activity log.
      return [];
    case "settings":
      // The Settings panel renders its own content in the main pane.
      return [];
  }
}

/// The display name of the agent a conversation belongs to.
///
/// Only persistent agents are in the snapshot, so an ephemeral one falls through to
/// `undefined` and the caller shows the persona instead — which is right: an unnamed
/// agent has no name worth showing.
function agentName(snap: ProjectSnapshot, instanceId?: string | null): string | undefined {
  if (!instanceId) return undefined;
  return (snap.agent_instances ?? []).find((a) => a.id === instanceId)?.name;
}

function emptyMessage(snap: ProjectSnapshot, s: Section): string {
  switch (s) {
    case "agents":
      return "Agents and presets are listed in the main panel.";
    case "personas":
      return snap.layout.has_personas ? "No personas yet." : "personas/ directory not found.";
    case "skills":
      return snap.layout.has_skills ? "No skills yet." : "skills/ directory not found.";
    case "flows":
      return snap.layout.has_flows ? "No flows yet." : "flows/ directory not found.";
    case "chats":
      return snap.mode === "remote"
        ? "Click + New Chat to start an ad-hoc chat with the agent."
        : "Live chats require a remote connection to a running agent.";
    case "sessions":
      return snap.layout.has_session_logs
        ? "No diagnostics sessions yet. Sessions appear here after a chat or flow run."
        : "sessions/ directory not found on the agent.";
    case "api_tools":
      return snap.layout.has_api_tools
        ? "No API tools yet."
        : "api-tools/ directory not found.";
    case "keys":
      return "No API keys stored yet. Click + New Key to add one.";
    case "packs":
      return snap.mode === "remote"
        ? "Packs panel loads its own list."
        : "Integration packs require a remote connection.";
    case "gateway":
      return snap.mode === "remote"
        ? "Click + New Channel to configure a gateway channel."
        : "Gateway channels require a remote connection.";
    case "network":
      return snap.mode === "remote"
        ? "Network activity loads in the main panel."
        : "Network activity requires a remote connection.";
    case "settings":
      return "Settings load in the main panel.";
  }
}
