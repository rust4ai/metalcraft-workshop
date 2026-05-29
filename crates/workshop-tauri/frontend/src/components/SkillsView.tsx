import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useReportError } from "../hooks/useReportError";
import type { ProjectSnapshot, Skill } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}

export default function SkillsView({ snapshot, selectedSlug, onSelect }: Props) {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const reportError = useReportError();
  const isNew = selectedSlug === "__new__";
  const summary = selectedSlug && selectedSlug !== "__new__"
    ? snapshot.skills.find((s) => s.slug === selectedSlug)
    : null;
  const isReadOnly = !!summary?.read_only;
  const packId = summary?.pack_id ?? null;

  useEffect(() => {
    setSavedAt(null);
    if (!selectedSlug) {
      setSkill(null);
      return;
    }
    if (isNew) {
      setSkill({ slug: "", description: "", body: "" });
      setSlugDraft("");
      return;
    }
    setSlugDraft(selectedSlug);
    invoke<Skill>("get_skill", { slug: selectedSlug })
      .then(setSkill)
      .catch((e) => reportError("get_skill", e));
  }, [selectedSlug, isNew, reportError]);

  if (!selectedSlug) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Select a skill from the sidebar.
      </div>
    );
  }
  if (!skill) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  const save = async () => {
    const slug = isNew ? slugDraft.trim() : selectedSlug;
    if (!slug) return;
    setSaving(true);
    try {
      await invoke("save_skill", {
        slug,
        description: skill.description,
        body: skill.body,
      });
      setSavedAt(Date.now());
      if (isNew) onSelect(slug);
    } catch (e) {
      reportError("save_skill", e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isNew || !confirm(`Delete skill "${selectedSlug}"?`)) return;
    try {
      await invoke("delete_skill", { slug: selectedSlug });
      onSelect(null);
    } catch (e) {
      reportError("delete_skill", e);
    }
  };

  return (
    <div className="h-full flex flex-col p-6 gap-3">
      {isNew && (
        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Slug (filename without .md)
          </label>
          <input
            type="text"
            value={slugDraft}
            onChange={(e) => setSlugDraft(e.target.value)}
            placeholder="my-skill"
            className="w-full max-w-md px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
          />
        </div>
      )}
      <div>
        <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
          Description (YAML frontmatter)
        </label>
        <input
          type="text"
          value={skill.description}
          onChange={(e) => setSkill({ ...skill, description: e.target.value })}
          className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
        />
      </div>

      <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
        <div className="flex flex-col min-h-0">
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Markdown body
          </label>
          <textarea
            value={skill.body}
            onChange={(e) => setSkill({ ...skill, body: e.target.value })}
            className="flex-1 px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-xs resize-none"
          />
        </div>
        <div className="flex flex-col min-h-0">
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Preview
          </label>
          <div className="flex-1 overflow-y-auto px-4 py-3 bg-surface-1 border border-surface-3 rounded prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.body}</ReactMarkdown>
          </div>
        </div>
      </div>

      {isReadOnly && (
        <div className="px-3 py-2 bg-accent/10 border border-accent/30 rounded text-xs text-accent-light">
          Read-only — provided by the{" "}
          <span className="font-mono">{packId}</span> integration pack.
        </div>
      )}
      <div className="flex items-center gap-3 pt-3 border-t border-surface-3">
        <button
          onClick={save}
          disabled={saving || isReadOnly || (isNew && !slugDraft.trim())}
          className="px-4 py-2 bg-accent hover:bg-accent-light text-white rounded text-sm font-medium disabled:opacity-40"
          title={isReadOnly ? "Pack-owned skills are read-only" : undefined}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {!isNew && (
          <button
            onClick={remove}
            disabled={isReadOnly}
            className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded text-sm disabled:opacity-40"
            title={isReadOnly ? "Pack-owned skills can't be deleted" : undefined}
          >
            Delete
          </button>
        )}
        {savedAt && (
          <span className="text-xs text-green-400">Saved.</span>
        )}
      </div>
    </div>
  );
}
