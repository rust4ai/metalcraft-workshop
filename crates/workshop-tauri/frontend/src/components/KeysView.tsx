import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type { ProjectSnapshot } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
}

/// Manage the agent's API-key / secret store. Values are write-only from the
/// UI's perspective — we only ever see a masked preview, so editing an existing
/// key means entering a new value to replace it (rotation). These keys back the
/// `$NAME` placeholders used by HTTP-API tools (e.g. the Solarabase pack).
export default function KeysView({ snapshot, selectedName, onSelect }: Props) {
  const [nameDraft, setNameDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const reportError = useReportError();

  const isNew = selectedName === "__new__";
  const summary =
    selectedName && !isNew
      ? snapshot.keys.find((k) => k.name === selectedName)
      : null;

  useEffect(() => {
    setSavedAt(null);
    setValueDraft("");
    setNameDraft(isNew ? "" : (selectedName ?? ""));
  }, [selectedName, isNew]);

  if (!selectedName) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm px-6 text-center">
        Select a key from the sidebar, or create a new one. Keys back the{" "}
        <span className="font-mono mx-1">$NAME</span> placeholders used by API
        tools.
      </div>
    );
  }

  const name = isNew ? nameDraft.trim() : selectedName;

  const save = async () => {
    if (!name || !valueDraft) return;
    setSaving(true);
    try {
      await invoke("save_key", { name, value: valueDraft });
      setSavedAt(Date.now());
      setValueDraft("");
      if (isNew) onSelect(name);
    } catch (e) {
      reportError("save_key", e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isNew || !confirm(`Delete key "${selectedName}"?`)) return;
    try {
      await invoke("delete_key", { name: selectedName });
      onSelect(null);
    } catch (e) {
      reportError("delete_key", e);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl space-y-4">
        {isNew ? (
          <Field label="Name (e.g. SOLARABASE_API_KEY)">
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="SOLARABASE_API_KEY"
              className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
            />
          </Field>
        ) : (
          <div>
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Name
            </span>
            <div className="font-mono text-sm text-gray-200">{selectedName}</div>
            {summary && (
              <div className="text-xs text-gray-500 mt-1">
                Stored value:{" "}
                <span className="font-mono text-gray-400">{summary.masked}</span>
              </div>
            )}
          </div>
        )}

        <Field
          label={isNew ? "Value" : "New value (replaces the stored secret)"}
        >
          <input
            type="password"
            value={valueDraft}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValueDraft(e.target.value)}
            placeholder={isNew ? "sb_live_…" : "Enter a value to rotate this key"}
            className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
          />
        </Field>

        <p className="text-[11px] text-gray-500">
          Values are stored in plaintext in the agent's <span className="font-mono">keys.json</span>{" "}
          and never sent back to the workshop — only this masked preview is.
        </p>

        <div className="flex items-center gap-3 pt-4 border-t border-surface-3">
          <button
            onClick={save}
            disabled={saving || !name || !valueDraft}
            className="px-4 py-2 bg-accent hover:bg-accent-light text-white rounded text-sm font-medium disabled:opacity-40"
          >
            {saving ? "Saving…" : isNew ? "Save" : "Update value"}
          </button>
          {!isNew && (
            <button
              onClick={remove}
              className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded text-sm"
            >
              Delete
            </button>
          )}
          {savedAt && <span className="text-xs text-green-400">Saved.</span>}
        </div>
      </div>
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
