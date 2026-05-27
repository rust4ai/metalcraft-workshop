import type { ProjectSnapshot } from "../types";
import type { Section } from "../App";

interface Props {
  snapshot: ProjectSnapshot;
  section: Section;
  selectedId: string | null;
  onSection: (s: Section) => void;
  onSelect: (id: string | null) => void;
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: "personas", label: "Personas" },
  { id: "skills", label: "Skills" },
  { id: "flows", label: "Flows" },
  { id: "chats", label: "Chats" },
];

export default function Sidebar({ snapshot, section, selectedId, onSection, onSelect }: Props) {
  const items = listItems(snapshot, section);

  return (
    <aside className="w-64 flex flex-col bg-surface-1 border-r border-surface-3">
      <nav className="flex border-b border-surface-3">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => onSection(s.id)}
            className={`flex-1 px-2 py-2 text-xs font-medium uppercase tracking-wide transition-colors ${
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
                  <div className="text-sm font-medium truncate">{it.label}</div>
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
        <button
          onClick={() => onSelect("__new__")}
          className="mx-3 my-2 px-3 py-1.5 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded"
        >
          + New Flow
        </button>
      )}
      {section === "personas" && (
        <button
          onClick={() => onSelect("__new__")}
          className="mx-3 my-2 px-3 py-1.5 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded"
        >
          + New Persona
        </button>
      )}
      {section === "skills" && (
        <button
          onClick={() => onSelect("__new__")}
          className="mx-3 my-2 px-3 py-1.5 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded"
        >
          + New Skill
        </button>
      )}
    </aside>
  );
}

function listItems(snap: ProjectSnapshot, s: Section): { id: string; label: string; sub?: string }[] {
  switch (s) {
    case "personas":
      return snap.personas.map((p) => ({ id: p.slug, label: p.name, sub: p.slug }));
    case "skills":
      return snap.skills.map((sk) => ({ id: sk.slug, label: sk.slug, sub: sk.description }));
    case "flows":
      return snap.flows.map((f) => ({
        id: f.id,
        label: f.name,
        sub: `${f.node_count} nodes${f.enabled ? " • enabled" : ""}`,
      }));
    case "chats":
      return snap.sessions.map((s) => ({
        id: s.id,
        label: s.timestamp,
        sub: [s.persona_slug, s.model_name, `${s.turn_count} turns`].filter(Boolean).join(" • "),
      }));
  }
}

function emptyMessage(snap: ProjectSnapshot, s: Section): string {
  switch (s) {
    case "personas":
      return snap.layout.has_personas_dir ? "No personas yet." : "personas/ directory not found.";
    case "skills":
      return snap.layout.has_skills_dir ? "No skills yet." : "skills/ directory not found.";
    case "flows":
      return snap.layout.has_flows_dir ? "No flows yet." : "flows/ directory not found.";
    case "chats":
      return snap.layout.has_logs_dir
        ? "No diagnostics sessions yet."
        : "logs/ directory not found. Run the agent with --diagnostics to generate sessions.";
  }
}
