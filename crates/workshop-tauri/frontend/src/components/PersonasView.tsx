import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type { AgentPresetDetail, Persona, ProjectSnapshot } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}

const BLANK: Persona = {
  name: "",
  description: "",
  tools: [],
  packs: [],
  skills: [],
  system_prompt: "",
};

export default function PersonasView({ snapshot, selectedSlug, onSelect }: Props) {
  // Look up the snapshot summary to detect pack-owned (read-only) personas.
  const summary = selectedSlug && selectedSlug !== "__new__"
    ? snapshot.personas.find((p) => p.slug === selectedSlug)
    : null;
  const isReadOnly = !!summary?.read_only;
  const packId = summary?.pack_id ?? null;
  const [persona, setPersona] = useState<Persona | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const reportError = useReportError();
  const isNew = selectedSlug === "__new__";

  useEffect(() => {
    setSavedAt(null);
    if (!selectedSlug) {
      setPersona(null);
      return;
    }
    if (isNew) {
      setPersona({ ...BLANK });
      setSlugDraft("");
      return;
    }
    // Blank first. Without this the previous persona's body stayed on screen while
    // the next one loaded — and `save` writes `persona` under `selectedSlug`, so
    // pressing Save in that window wrote A's prompt and tools into B.json. A failed
    // load left the same state indefinitely.
    setPersona(null);
    setSlugDraft(selectedSlug);
    let cancelled = false;
    invoke<Persona>("get_persona", { slug: selectedSlug })
      .then((p) => {
        // A slower earlier request must not land on top of a newer selection.
        if (!cancelled) setPersona(p);
      })
      .catch((e) => {
        if (!cancelled) reportError("get_persona", e);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug, isNew, reportError]);

  if (!selectedSlug) {
    return <Empty label="persona" />;
  }
  if (!persona) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  const save = async () => {
    const slug = isNew ? slugDraft.trim() : selectedSlug;
    if (!slug) return;
    setSaving(true);
    try {
      await invoke("save_persona", { slug, persona });
      setSavedAt(Date.now());
      if (isNew) onSelect(slug);
    } catch (e) {
      reportError("save_persona", e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isNew || !confirm(`Delete persona "${selectedSlug}"?`)) return;
    try {
      await invoke("delete_persona", { slug: selectedSlug });
      onSelect(null);
    } catch (e) {
      reportError("delete_persona", e);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-4">
        {!isNew && <UsedByAgents snapshot={snapshot} slug={selectedSlug} />}
        {isNew && (
          <Field label="Slug (filename without .json)">
            <input
              type="text"
              value={slugDraft}
              onChange={(e) => setSlugDraft(e.target.value)}
              placeholder="my-agent"
              className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
            />
          </Field>
        )}
        <Field label="Name">
          <input
            type="text"
            value={persona.name}
            onChange={(e) => setPersona({ ...persona, name: e.target.value })}
            className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
          />
        </Field>
        <Field label="Description">
          <input
            type="text"
            value={persona.description}
            onChange={(e) => setPersona({ ...persona, description: e.target.value })}
            className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
          />
        </Field>
        <Field label="Tools (comma-separated)">
          <input
            type="text"
            value={persona.tools.join(", ")}
            onChange={(e) =>
              setPersona({
                ...persona,
                tools: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
              })
            }
            className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
          />
        </Field>
        <Field label="Skills">
          <SkillSelector
            available={snapshot.skills.map((s) => s.slug)}
            selected={persona.skills ?? []}
            onChange={(skills) => setPersona({ ...persona, skills })}
          />
        </Field>
        <Field label="System prompt">
          <textarea
            value={persona.system_prompt}
            onChange={(e) => setPersona({ ...persona, system_prompt: e.target.value })}
            rows={14}
            className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
          />
        </Field>

        {isReadOnly && (
          <div className="px-3 py-2 bg-accent/10 border border-accent/30 rounded text-xs text-accent-light">
            Read-only — this persona is provided by the{" "}
            <span className="font-mono">{packId}</span> integration pack.
            Create a new persona with a different slug to make a variant.
          </div>
        )}
        <div className="flex items-center gap-3 pt-4 border-t border-surface-3">
          <button
            onClick={save}
            disabled={saving || isReadOnly || (isNew && !slugDraft.trim())}
            className="px-4 py-2 bg-accent hover:bg-accent-light text-white rounded text-sm font-medium disabled:opacity-40"
            title={isReadOnly ? "Pack-owned personas are read-only" : undefined}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {!isNew && (
            <button
              onClick={remove}
              disabled={isReadOnly}
              className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded text-sm disabled:opacity-40"
              title={isReadOnly ? "Pack-owned personas can't be deleted" : undefined}
            >
              Delete
            </button>
          )}
          {savedAt && (
            <span className="text-xs text-green-400">Saved {ago(savedAt)}.</span>
          )}
        </div>
      </div>
    </div>
  );
}

/// Which agents reach this persona.
///
/// Deleting a persona used to be a guess: nothing told you whether an agent's roster
/// named it, and finding out meant opening every preset. It matters more now than it
/// used to — a preset naming a missing persona is a broken agent, not a cosmetic
/// gap, so the reverse lookup is the difference between an informed delete and a
/// hopeful one.
function UsedByAgents({
  snapshot,
  slug,
}: {
  snapshot: ProjectSnapshot;
  slug: string;
}) {
  const [users, setUsers] = useState<UserRef[] | null>(null);

  useEffect(() => {
    const presets = snapshot.agent_presets ?? [];
    if (presets.length === 0) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    setUsers(null);
    Promise.all(
      presets.map((p) =>
        invoke<AgentPresetDetail>("get_agent_preset", { slug: p.slug })
          .then((d) =>
            d.personas.some((rp) => rp.slug === slug)
              ? { name: p.name, known: true }
              : null,
          )
          // A preset we could not read might well use this persona. Counting it as a
          // "no" would tell someone nothing references it, which is the one answer
          // that makes deleting look safe.
          .catch(() => ({ name: p.name, known: false })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setUsers(results.filter((r): r is UserRef => !!r));
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot.agent_presets, slug]);

  if (users === null || users.length === 0) return null;

  const confirmed = users.filter((u) => u.known);
  const unchecked = users.filter((u) => !u.known);

  return (
    <p className="px-3 py-2 bg-surface-1 border border-surface-3 rounded text-xs text-gray-400">
      {confirmed.length > 0 && (
        <>
          Used by {confirmed.length} agent{confirmed.length === 1 ? "" : "s"}:{" "}
          <span className="text-gray-300">
            {confirmed.map((u) => u.name).join(", ")}
          </span>
          . Deleting this persona leaves {confirmed.length === 1 ? "it" : "them"}{" "}
          naming something that is not there.{" "}
        </>
      )}
      {unchecked.length > 0 && (
        <span className="text-amber-400">
          {unchecked.length} agent{unchecked.length === 1 ? "" : "s"} could not be
          checked ({unchecked.map((u) => u.name).join(", ")}), so this may be used
          elsewhere.
        </span>
      )}
    </p>
  );
}

/// A preset that references this persona — or one we could not read, which is not the
/// same as one that does not.
interface UserRef {
  name: string;
  known: boolean;
}

function Empty({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center text-gray-500 text-sm">
      Select a {label} from the sidebar.
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

function SkillSelector({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const sel = new Set(selected);
  return (
    <div className="flex flex-wrap gap-1.5 p-2 bg-surface-1 border border-surface-3 rounded min-h-[40px]">
      {available.length === 0 && (
        <span className="text-xs text-gray-600">No skills available in this project.</span>
      )}
      {available.map((s) => {
        const on = sel.has(s);
        return (
          <button
            key={s}
            type="button"
            onClick={() =>
              onChange(on ? selected.filter((x) => x !== s) : [...selected, s])
            }
            className={`px-2 py-1 text-xs rounded ${
              on
                ? "bg-accent text-white"
                : "bg-surface-2 text-gray-400 hover:text-gray-200"
            }`}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
