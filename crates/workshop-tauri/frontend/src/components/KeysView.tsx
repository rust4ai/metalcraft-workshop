import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type { KeyEntry, ProjectSnapshot, RecommendedKey } from "../types";

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
  // Name to pre-fill when starting a new key from a recommendation.
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<RecommendedKey[]>([]);
  // Scope-aware key list (global + per-channel secrets). Fetched live rather
  // than read from the snapshot so channel secrets and their managed flags show.
  const [entries, setEntries] = useState<KeyEntry[]>([]);
  const reportError = useReportError();

  const isNew = selectedName === "__new__";
  const summary =
    selectedName && !isNew
      ? entries.find((k) => k.scope === "global" && k.name === selectedName)
      : null;

  const globalKeys = useMemo(
    () => entries.filter((e) => e.scope === "global"),
    [entries],
  );
  // Channel secrets grouped by their owning channel, for a segregated section.
  const channelGroups = useMemo(() => {
    const m = new Map<string, { id: string; name: string; keys: KeyEntry[] }>();
    for (const e of entries) {
      if (e.scope !== "channel" || !e.channel_id) continue;
      const id = e.channel_id;
      if (!m.has(id)) {
        m.set(id, { id, name: e.channel_name ?? `Channel ${id.slice(0, 8)}`, keys: [] });
      }
      m.get(id)!.keys.push(e);
    }
    return [...m.values()];
  }, [entries]);

  useEffect(() => {
    setSavedAt(null);
    setValueDraft("");
    setNameDraft(isNew ? (pendingName ?? "") : (selectedName ?? ""));
    if (isNew && pendingName) setPendingName(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedName, isNew]);

  // Refresh the key list + recommendations whenever the stored keys change (a
  // save flips a key's `configured` flag). Remote-only bits (channel secrets,
  // recommendations) are empty in local mode.
  useEffect(() => {
    invoke<KeyEntry[]>("list_keys")
      .then(setEntries)
      .catch((e) => reportError("list_keys", e));
    invoke<RecommendedKey[]>("list_recommended_keys")
      .then(setRecommended)
      .catch((e) => reportError("list_recommended_keys", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.keys, savedAt]);

  const startNewKey = (name: string) => {
    setPendingName(name);
    onSelect("__new__");
  };

  if (!selectedName) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="max-w-2xl space-y-6">
          <p className="text-sm text-gray-500">
            Select a key from the sidebar, or create a new one. Keys back the{" "}
            <span className="font-mono mx-1">$NAME</span> placeholders used by
            API tools.
          </p>
          <StoredKeys keys={globalKeys} onSelect={onSelect} />
          <ChannelSecrets groups={channelGroups} />
          <RecommendedKeys
            recommended={recommended}
            onAdd={startNewKey}
            onSelect={onSelect}
          />
        </div>
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
            type="text"
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

/// The keys actually stored in the agent's `keys.json` — the same list the
/// sidebar shows. Mirrors the sidebar so the empty-state pane doesn't look like
/// it's out of sync with it. Each row opens that key's editor for rotation.
function StoredKeys({
  keys,
  onSelect,
}: {
  keys: KeyEntry[];
  onSelect: (name: string | null) => void;
}) {
  if (keys.length === 0) return null;
  return (
    <div>
      <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        Your stored keys
      </h2>
      <ul className="space-y-1.5">
        {keys.map((k) => (
          <li key={k.name}>
            <button
              onClick={() => onSelect(k.name)}
              className="w-full flex items-center gap-3 px-3 py-2 bg-surface-1 border border-surface-3 rounded text-left hover:border-accent/50"
            >
              <span className="font-mono text-sm text-gray-200 truncate">
                {k.name}
              </span>
              <div className="flex-1" />
              <span className="font-mono text-xs text-gray-500 whitespace-nowrap">
                {k.masked}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/// Secrets that belong to a gateway channel, grouped by channel and shown
/// separately from account-wide keys. Managed secrets (written by the channel's
/// connection, e.g. the Metalcraft Gateway) are locked and read-only — reconnect
/// the channel to change them. Values are always masked.
function ChannelSecrets({
  groups,
}: {
  groups: { id: string; name: string; keys: KeyEntry[] }[];
}) {
  if (groups.length === 0) return null;
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.id}>
          <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            {g.name} · channel secrets
          </h2>
          <ul className="space-y-1.5">
            {g.keys.map((k) => (
              <SecretRow key={k.name} entry={k} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/// One channel-secret row: name, an optional managed lock, and a Reveal toggle
/// that fetches the raw value on demand (the list only ever carries the mask).
function SecretRow({ entry }: { entry: KeyEntry }) {
  const reportError = useReportError();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setBusy(true);
    try {
      const value = await invoke<string>("reveal_key", {
        name: entry.name,
        channelId: entry.channel_id ?? null,
      });
      setRevealed(value);
    } catch (e) {
      reportError("reveal_key", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-3 px-3 py-2 bg-surface-1 border border-surface-3 rounded">
      <span className="font-mono text-sm text-gray-200 truncate">{entry.name}</span>
      {entry.managed && (
        <span
          className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-surface-2 text-gray-400 rounded"
          title="Managed by this channel's connection — reconnect the channel to change it"
        >
          🔒 managed
        </span>
      )}
      <div className="flex-1" />
      <span
        className={`font-mono text-xs whitespace-nowrap ${
          revealed !== null ? "text-gray-300 select-all" : "text-gray-500"
        }`}
      >
        {revealed !== null ? revealed : entry.masked}
      </span>
      <button
        onClick={toggle}
        disabled={busy}
        className="shrink-0 text-xs text-accent-light hover:underline disabled:opacity-40"
      >
        {busy ? "…" : revealed !== null ? "Hide" : "Reveal"}
      </button>
    </li>
  );
}

/// "These enabled packs still need these keys." Configured keys link to their
/// editor (for rotation); unconfigured ones start a new-key form pre-filled
/// with the name. Hidden entirely when nothing is recommended (e.g. local mode
/// or no enabled packs).
function RecommendedKeys({
  recommended,
  onAdd,
  onSelect,
}: {
  recommended: RecommendedKey[];
  onAdd: (name: string) => void;
  onSelect: (name: string | null) => void;
}) {
  if (recommended.length === 0) return null;
  return (
    <div>
      <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        Recommended by enabled packs
      </h2>
      <ul className="space-y-1.5">
        {recommended.map((r) => (
          <li
            key={r.name}
            className="flex items-center gap-2 px-3 py-2 bg-surface-1 border border-surface-3 rounded"
          >
            <span className="font-mono text-sm text-gray-200 truncate">
              {r.name}
            </span>
            <div className="flex gap-1 flex-wrap">
              {r.packs.map((p) => (
                <span
                  key={p}
                  className="px-1 py-px text-[9px] uppercase tracking-wide bg-accent/20 text-accent-light rounded font-mono"
                  title={`required by the '${p}' integration pack`}
                >
                  {p}
                </span>
              ))}
            </div>
            <div className="flex-1" />
            {r.managed ? (
              <span
                className="text-xs text-gray-400 whitespace-nowrap"
                title="Provided by the platform (env-authoritative) — nothing to enter"
              >
                🔒 provided
              </span>
            ) : r.configured ? (
              <button
                onClick={() => onSelect(r.name)}
                className="text-xs text-green-400 hover:underline whitespace-nowrap"
                title="Configured — click to rotate the value"
              >
                ✓ configured
              </button>
            ) : (
              <button
                onClick={() => onAdd(r.name)}
                className="px-2 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded whitespace-nowrap"
              >
                + Add value
              </button>
            )}
          </li>
        ))}
      </ul>
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
