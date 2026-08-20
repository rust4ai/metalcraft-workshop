import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type {
  AgentInstance,
  AgentPresetDetail,
  AgentPresetSummary,
  ChatSummary,
  InstanceDetail,
  InstanceMemory,
  ProjectSnapshot,
} from "../types";

/**
 * Agents.
 *
 * Two panes, because there are genuinely two things:
 *
 *   **Presets** — what this pod *can be*. A template: a default persona, the roster
 *   it may call, the packs those personas need. Authoring surface, so "preset" is
 *   the right word here.
 *
 *   **Agents** — the instances that actually exist, each with its own memory and its
 *   own conversations. Never called "instances" in the UI: "Amy — Sunday prep" is an
 *   agent, and the fact that it instantiates a preset is our vocabulary.
 *
 * Ephemeral agents are hidden by default. Every chat mints one, so an unfiltered list
 * is one row per chat ever started — noise that buries the handful of agents someone
 * actually named.
 */
export default function AgentsView({
  snapshot,
  selectedId,
  onSelect,
  onChanged,
}: {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged?: () => void;
}) {
  const reportError = useReportError();
  const [instances, setInstances] = useState<AgentInstance[]>([]);
  const [showEphemeral, setShowEphemeral] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setInstances(await invoke<AgentInstance[]>("list_agent_instances"));
      setLoadFailed(false);
    } catch {
      // A local directory with no `agent_instances/` genuinely has none, so this is
      // not worth a toast every time the tab is opened. But swallowing it outright
      // rendered "No named agents yet" on a pod that has dozens and simply failed to
      // answer — so the empty state says which it is.
      setInstances([]);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const presets = snapshot.agent_presets ?? [];
  const visible = showEphemeral ? instances : instances.filter((i) => i.persistent);
  const hidden = instances.length - visible.length;

  // A selection is either a preset slug or an agent id. Ids are prefixed `inst_`,
  // which is what makes one list of ids unambiguous across both panes.
  const selectedInstance = instances.find((i) => i.id === selectedId);
  const selectedPreset = presets.find((p) => p.slug === selectedId);

  if (selectedInstance) {
    return (
      <AgentDetail
        instance={selectedInstance}
        onBack={() => onSelect(null)}
        onChanged={() => {
          refresh();
          onChanged?.();
        }}
        onGone={() => {
          onSelect(null);
          refresh();
          onChanged?.();
        }}
        reportError={reportError}
      />
    );
  }
  if (selectedPreset) {
    return <PresetDetailPane slug={selectedPreset.slug} onBack={() => onSelect(null)} />;
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-accent">Agents</h2>
          <NewAgentButton
            presets={presets}
            onCreated={() => {
              refresh();
              onChanged?.();
            }}
            reportError={reportError}
          />
        </div>

        {visible.length === 0 ? (
          <p className="text-xs text-gray-500">
            {loadFailed
              ? "Could not read this pod's agents — switch tabs to try again."
              : "No named agents yet. Starting a chat creates one; naming it keeps it."}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => onSelect(a.id)}
                  className="w-full text-left px-3 py-2 bg-surface-1 border border-surface-3 rounded hover:border-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-100 truncate">{a.name}</span>
                    <OriginBadge instance={a} />
                    {!a.persistent && (
                      <span className="px-1 py-px text-[9px] uppercase tracking-wide bg-surface-3 text-gray-400 rounded">
                        ephemeral
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {[
                      a.agent_preset,
                      a.persona,
                      a.conversation_count != null
                        ? `${a.conversation_count} conversation${a.conversation_count === 1 ? "" : "s"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        {hidden > 0 && (
          <button
            onClick={() => setShowEphemeral(true)}
            className="mt-3 text-xs text-accent-light/80 hover:text-accent-light underline"
          >
            Show {hidden} unnamed agent{hidden === 1 ? "" : "s"}
          </button>
        )}
        {showEphemeral && instances.some((i) => !i.persistent) && (
          <button
            onClick={() => setShowEphemeral(false)}
            className="mt-3 text-xs text-gray-500 hover:text-gray-300 underline"
          >
            Hide unnamed agents
          </button>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-accent mb-1">Presets</h2>
        <p className="text-xs text-gray-500 mb-3">
          What this pod can be. Each preset is a template an agent is made from.
        </p>
        {presets.length === 0 ? (
          <p className="text-xs text-gray-500">
            This agent predates agent presets, so there is nothing to list here.
          </p>
        ) : (
          <ul className="space-y-2">
            {presets.map((p) => (
              <li key={p.slug}>
                <button
                  onClick={() => onSelect(p.slug)}
                  className="w-full text-left px-3 py-2 bg-surface-1 border border-surface-3 rounded hover:border-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-100 truncate">{p.name}</span>
                    {p.slug === snapshot.default_agent_preset && (
                      <span className="px-1 py-px text-[9px] uppercase tracking-wide bg-accent/20 text-accent-light rounded">
                        default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {p.tagline ?? p.description}
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    {p.persona_count} persona{p.persona_count === 1 ? "" : "s"} • default:{" "}
                    {p.default_persona}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/// A gateway-bound agent acts without anyone watching — messages arrive from a
/// channel and it answers. That is worth saying on the row, not burying in a detail
/// pane. A flow-bound one runs on a timer, which is the same kind of fact.
function OriginBadge({ instance }: { instance: AgentInstance }) {
  const origin = instance.origin as { kind?: string; channel?: string; flow_id?: string };
  if (origin?.kind === "gateway") {
    return (
      <span
        className="px-1 py-px text-[9px] uppercase tracking-wide bg-amber-500/20 text-amber-300 rounded"
        title={`Answers messages from '${origin.channel}' on its own`}
      >
        channel
      </span>
    );
  }
  if (origin?.kind === "flow") {
    return (
      <span
        className="px-1 py-px text-[9px] uppercase tracking-wide bg-sky-500/20 text-sky-300 rounded"
        title={`Runs the '${origin.flow_id}' flow on a schedule`}
      >
        scheduled
      </span>
    );
  }
  return null;
}

function NewAgentButton({
  presets,
  onCreated,
  reportError,
}: {
  presets: AgentPresetSummary[];
  onCreated: () => void;
  reportError: (ctx: string, e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState(presets[0]?.slug ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (presets.length === 0) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-2 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded"
      >
        + New agent
      </button>
    );
  }

  const create = async () => {
    setBusy(true);
    try {
      await invoke<AgentInstance>("create_agent_instance", {
        agentPreset: preset,
        name: name.trim() || undefined,
      });
      setOpen(false);
      setName("");
      onCreated();
    } catch (e) {
      reportError("create_agent_instance", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-1 items-center">
      <select
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
        className="px-2 py-1 bg-surface-2 border border-surface-3 rounded text-xs"
      >
        {presets.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder="Name"
        className="w-32 px-2 py-1 bg-surface-2 border border-surface-3 rounded text-xs"
      />
      <button
        onClick={create}
        disabled={busy}
        className="px-2 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded disabled:opacity-40"
      >
        {busy ? "…" : "Create"}
      </button>
      <button
        onClick={() => setOpen(false)}
        className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300"
      >
        Cancel
      </button>
    </div>
  );
}

function AgentDetail({
  instance,
  onBack,
  onChanged,
  onGone,
  reportError,
}: {
  instance: AgentInstance;
  onBack: () => void;
  onChanged: () => void;
  onGone: () => void;
  reportError: (ctx: string, e: unknown) => void;
}) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  /// True when the agent's detail could not be read. Distinct from "it has none":
  /// the delete dialog says what survives, and an unread list rendering as zero told
  /// the user their transcripts would be lost when they would not have been.
  const [detailFailed, setDetailFailed] = useState(false);
  const [memory, setMemory] = useState<InstanceMemory | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [name, setName] = useState(instance.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(instance.name);
    setDetailFailed(false);
    invoke<InstanceDetail>("get_agent_instance", { id: instance.id })
      .then(setDetail)
      .catch(() => {
        setDetail(null);
        setDetailFailed(true);
      });
    // Local mode has no recall index, so this is expected to fail there. Say why
    // rather than showing a permanently empty panel.
    invoke<InstanceMemory>("agent_instance_memory", { id: instance.id, limit: 8 })
      .then((m) => {
        setMemory(m);
        setMemoryError(null);
      })
      .catch((e) => {
        setMemory(null);
        setMemoryError(String(e));
      });
  }, [instance.id, instance.name]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === instance.name) return;
    setSaving(true);
    try {
      // Naming an agent is also what promotes it: the pod sets `persistent` when a
      // name is set, so this is the one-click "keep this".
      await invoke<AgentInstance>("patch_agent_instance", {
        id: instance.id,
        patch: { name: next },
      });
      onChanged();
    } catch (e) {
      reportError("patch_agent_instance", e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      const kept = await invoke<number>("delete_agent_instance", { id: instance.id });
      console.info(`deleted agent ${instance.id}; kept ${kept} conversations`);
      onGone();
    } catch (e) {
      reportError("delete_agent_instance", e);
      setConfirmDelete(false);
    }
  };

  const conversations = detail?.conversations ?? [];
  const scheduled = detail?.scheduled ?? [];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-300">
        ← All agents
      </button>

      <header className="space-y-2">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && rename()}
            className="flex-1 px-3 py-2 bg-surface-2 border border-surface-3 rounded text-sm"
          />
          <button
            onClick={rename}
            disabled={saving || !name.trim() || name.trim() === instance.name}
            className="px-3 py-2 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded disabled:opacity-40"
          >
            {saving ? "…" : "Rename"}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          {instance.agent_preset} • {instance.persona} •{" "}
          {instance.persistent ? "kept" : "unnamed — will be reaped"}
        </p>
        {!instance.persistent && (
          <p className="text-xs text-gray-500">Naming this agent keeps it.</p>
        )}
      </header>

      {/* What it knows — base vs learned, which is the distinction the copy-on-write
          memory model exists to draw. */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Knows</h3>
        {memoryError ? (
          <p className="text-xs text-gray-500">
            Memory is a runtime index, so it is only readable through a connected
            agent.
          </p>
        ) : !memory ? (
          <p className="text-xs text-gray-500">Loading…</p>
        ) : (
          <>
            <p className="text-xs text-gray-400">
              {memory.shipped} shipped
              {memory.base ? ` (from ${memory.base})` : ""} • {memory.learned} learned
              {memory.forgotten > 0 ? ` • ${memory.forgotten} forgotten` : ""}
            </p>
            <ul className="mt-2 space-y-1">
              {memory.sample.map((m) => (
                <li
                  key={m.id}
                  className="px-3 py-2 bg-surface-1 border border-surface-3 rounded text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-1 py-px text-[9px] uppercase tracking-wide rounded ${
                        m.origin === "learned"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-surface-3 text-gray-400"
                      }`}
                    >
                      {m.origin}
                    </span>
                    <span className="text-gray-500">{m.kind}</span>
                  </div>
                  <div className="mt-1 text-gray-300">{m.text}</div>
                </li>
              ))}
            </ul>
            {memory.sample.length === 0 && (
              <p className="mt-2 text-xs text-gray-500">Nothing yet.</p>
            )}
          </>
        )}
      </section>

      {scheduled.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            Runs on a schedule
          </h3>
          <ul className="space-y-1">
            {scheduled.map((f) => (
              <li key={f.flow_id} className="text-xs text-gray-400">
                {f.flow_name ?? f.flow_id}
                <span className="text-gray-600"> — {f.schedule_ids.join(", ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
          Conversations ({conversations.length})
        </h3>
        {conversations.length === 0 ? (
          <p className="text-xs text-gray-500">None yet.</p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c: ChatSummary) => (
              <li key={c.id} className="text-xs text-gray-400">
                {c.persona_slug}
                <span className="text-gray-600">
                  {" "}
                  — {c.turn_count} turns • {c.created_at.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        {confirmDelete ? (
          <div className="px-3 py-2 bg-surface-1 border border-red-500/40 rounded space-y-2">
            {/* Say what survives. Deleting an agent deliberately keeps its
                transcripts, and making the user guess about that is unkind. */}
            <p className="text-xs text-gray-300">
              {detailFailed
                ? `Delete “${instance.name}”? Its conversations are kept — they always are — but this agent’s list could not be loaded, so I cannot say how many. Its memory is lost.`
                : conversations.length === 0
                  ? `Delete “${instance.name}”? Its memory is lost.`
                  : `Delete “${instance.name}”? Its ${conversations.length} conversation${conversations.length === 1 ? "" : "s"} are kept; its memory is lost.`}
            </p>
            <div className="flex gap-2">
              <button
                onClick={remove}
                className="px-3 py-1 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-red-400/70 hover:text-red-400 underline"
          >
            Delete this agent
          </button>
        )}
      </section>
    </div>
  );
}

function PresetDetailPane({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AgentPresetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AgentPresetDetail>("get_agent_preset", { slug })
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [slug]);

  if (error) return <div className="p-6 text-xs text-gray-500">{error}</div>;
  if (!detail) return <div className="p-6 text-xs text-gray-500">Loading…</div>;

  const missing = detail.personas.filter((p) => !p.installed);

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-300">
        ← All agents
      </button>

      <header>
        <h2 className="text-sm font-semibold text-accent">{detail.preset.name}</h2>
        <p className="text-xs text-gray-500">{detail.preset.slug}</p>
        {detail.preset.tagline && (
          <p className="mt-2 text-sm text-gray-300">{detail.preset.tagline}</p>
        )}
        <p className="mt-1 text-xs text-gray-500">{detail.preset.description}</p>
      </header>

      {missing.length > 0 && (
        <p className="px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-300">
          This preset names {missing.length} persona
          {missing.length === 1 ? "" : "s"} this pod does not have. An agent made from
          it cannot delegate to {missing.length === 1 ? "it" : "them"}.
        </p>
      )}

      <section>
        <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Roster</h3>
        <ul className="space-y-2">
          {detail.personas.map((p) => (
            <li
              key={p.slug}
              className={`px-3 py-2 bg-surface-1 border rounded ${
                p.installed ? "border-surface-3" : "border-amber-500/40 opacity-70"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-100">{p.name || p.slug}</span>
                {p.slug === detail.preset.default_persona && (
                  <span className="px-1 py-px text-[9px] uppercase tracking-wide bg-accent/20 text-accent-light rounded">
                    default
                  </span>
                )}
                {!p.installed && (
                  <span className="px-1 py-px text-[9px] uppercase tracking-wide bg-amber-500/20 text-amber-300 rounded">
                    not installed
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500">{p.description || p.error}</div>
              {p.installed && (
                <div className="text-xs text-gray-600 mt-1">
                  {(p.tools ?? []).length} tools
                  {(p.skills ?? []).length > 0
                    ? ` • skills: ${(p.skills ?? []).join(", ")}`
                    : ""}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {(detail.preset.integrations ?? []).length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            Integrations
          </h3>
          <p className="text-xs text-gray-400">
            {(detail.preset.integrations ?? []).join(", ")}
          </p>
        </section>
      )}
    </div>
  );
}
