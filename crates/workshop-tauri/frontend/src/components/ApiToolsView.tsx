import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type { ApiToolConfig, ProjectSnapshot } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
}

const BLANK: ApiToolConfig = {
  name: "",
  description: "",
  method: "GET",
  url: "",
  headers: {},
  parameters: { type: "object", properties: {}, required: [] },
  body_mapping: "params",
  body_template: null,
  body_defaults: {},
};

export default function ApiToolsView({ snapshot, selectedName, onSelect }: Props) {
  const [config, setConfig] = useState<ApiToolConfig | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const reportError = useReportError();
  const isNew = selectedName === "__new__";
  const summary = selectedName && selectedName !== "__new__"
    ? snapshot.api_tools.find((t) => t.name === selectedName)
    : null;
  const isReadOnly = !!summary?.read_only;
  const packId = summary?.pack_id ?? null;

  useEffect(() => {
    setSavedAt(null);
    setParseError(null);
    if (!selectedName) {
      setConfig(null);
      return;
    }
    if (isNew) {
      setConfig({ ...BLANK });
      setNameDraft("");
      return;
    }
    setNameDraft(selectedName);
    invoke<ApiToolConfig>("get_api_tool", { name: selectedName })
      .then(setConfig)
      .catch((e) => reportError("get_api_tool", e));
  }, [selectedName, isNew, reportError]);

  if (!selectedName) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Select an API tool from the sidebar, or create a new one.
      </div>
    );
  }
  if (!config) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  const save = async () => {
    const name = isNew ? nameDraft.trim() : selectedName;
    if (!name) return;
    setSaving(true);
    try {
      await invoke("save_api_tool", { name, config: { ...config, name } });
      setSavedAt(Date.now());
      if (isNew) onSelect(name);
    } catch (e) {
      reportError("save_api_tool", e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (isNew || !confirm(`Delete API tool "${selectedName}"?`)) return;
    try {
      await invoke("delete_api_tool", { name: selectedName });
      onSelect(null);
    } catch (e) {
      reportError("delete_api_tool", e);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-4">
        {isNew && (
          <Field label="Name (filename without .json)">
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="my-api-tool"
              className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
            />
          </Field>
        )}
        <Field label="Description">
          <input
            type="text"
            value={config.description}
            onChange={(e) => setConfig({ ...config, description: e.target.value })}
            className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
          />
        </Field>

        <div className="flex gap-2">
          <Field label="Method">
            <select
              value={config.method}
              onChange={(e) => setConfig({ ...config, method: e.target.value })}
              className="px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <div className="flex-1">
            <Field label="URL">
              <input
                type="text"
                value={config.url}
                onChange={(e) => setConfig({ ...config, url: e.target.value })}
                placeholder="https://api.example.com/v1/resource/{id}"
                className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
              />
            </Field>
          </div>
        </div>

        <Field label="Headers (JSON map of string→string)">
          <JsonTextarea
            value={config.headers}
            onChange={(v) => setConfig({ ...config, headers: v as Record<string, string> })}
            onError={setParseError}
            rows={4}
          />
        </Field>

        <Field label="Parameters (JSON-Schema-style object)">
          <JsonTextarea
            value={config.parameters}
            onChange={(v) => setConfig({ ...config, parameters: v })}
            onError={setParseError}
            rows={10}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Body mapping">
            <select
              value={config.body_mapping}
              onChange={(e) => setConfig({ ...config, body_mapping: e.target.value })}
              className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
            >
              {["params", "template", "none"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Body template (optional)">
            <input
              type="text"
              value={config.body_template ?? ""}
              onChange={(e) =>
                setConfig({
                  ...config,
                  body_template: e.target.value === "" ? null : e.target.value,
                })
              }
              className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
              placeholder='e.g. {"q": "{{query}}"}'
            />
          </Field>
        </div>

        <Field label="Body defaults (JSON map)">
          <JsonTextarea
            value={config.body_defaults}
            onChange={(v) => setConfig({ ...config, body_defaults: v as Record<string, unknown> })}
            onError={setParseError}
            rows={4}
          />
        </Field>

        {parseError && (
          <div className="px-3 py-2 bg-red-900/30 border border-red-900/50 text-xs text-red-200 rounded">
            JSON parse error: {parseError}
          </div>
        )}

        {isReadOnly && (
          <div className="px-3 py-2 bg-accent/10 border border-accent/30 rounded text-xs text-accent-light">
            Read-only — provided by the{" "}
            <span className="font-mono">{packId}</span> integration pack.
          </div>
        )}
        <div className="flex items-center gap-3 pt-4 border-t border-surface-3">
          <button
            onClick={save}
            disabled={saving || isReadOnly || (isNew && !nameDraft.trim())}
            className="px-4 py-2 bg-accent hover:bg-accent-light text-white rounded text-sm font-medium disabled:opacity-40"
            title={isReadOnly ? "Pack-owned tools are read-only" : undefined}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {!isNew && (
            <button
              onClick={remove}
              disabled={isReadOnly}
              className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded text-sm disabled:opacity-40"
              title={isReadOnly ? "Pack-owned tools can't be deleted" : undefined}
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

function JsonTextarea({
  value,
  onChange,
  onError,
  rows,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  onError: (msg: string | null) => void;
  rows: number;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));

  // Keep the textarea in sync when the parent swaps configs (e.g. select a
  // different tool). Re-stringify only when the incoming value differs from
  // our last successful parse, to avoid stomping mid-edit.
  useEffect(() => {
    const incoming = JSON.stringify(value, null, 2);
    try {
      if (JSON.stringify(JSON.parse(draft)) !== JSON.stringify(value)) {
        setDraft(incoming);
      }
    } catch {
      // current draft is invalid JSON — leave it so the user can fix it
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <textarea
      value={draft}
      rows={rows}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        try {
          const parsed = JSON.parse(e.target.value);
          onChange(parsed);
          onError(null);
        } catch (err) {
          onError((err as Error).message);
        }
      }}
      className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-xs"
    />
  );
}
