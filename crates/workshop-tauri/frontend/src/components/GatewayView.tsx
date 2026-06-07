import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type {
  GatewayChannel,
  GatewaySettingField,
  GatewayType,
  KeySummary,
  ProjectSnapshot,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /// Jump to the Keys tab, optionally focused on a key name (to add/rotate it).
  onGoToKeys: (name: string) => void;
}

export default function GatewayView({ snapshot, selectedId, onSelect, onGoToKeys }: Props) {
  const reportError = useReportError();
  const [types, setTypes] = useState<GatewayType[] | null>(null);
  const [channels, setChannels] = useState<GatewayChannel[] | null>(null);
  // Live set of configured key names — fetched here (not read from the load-time
  // snapshot) so a key added in the Keys tab reflects as ✓ on next tab entry.
  const [keyNames, setKeyNames] = useState<Set<string>>(new Set());

  // Gateway state lives on the agent — local mode has nothing to show.
  if (snapshot.mode !== "remote") {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md text-sm text-gray-400">
          <p className="mb-2">
            Gateway channels are managed by the agent process and are only
            visible when connected to a remote agent.
          </p>
          <p className="text-xs text-gray-500">
            Start the agent with{" "}
            <code className="text-accent-light">
              metalcraft-daemon --api &lt;KEY&gt;
            </code>{" "}
            and connect via the Remote tab.
          </p>
        </div>
      </div>
    );
  }

  const refresh = async () => {
    try {
      const [t, c, k] = await Promise.all([
        invoke<GatewayType[]>("list_gateway_types"),
        invoke<GatewayChannel[]>("list_gateway_channels"),
        invoke<KeySummary[]>("list_keys"),
      ]);
      setTypes(t);
      setChannels(c);
      setKeyNames(new Set(k.map((key) => key.name)));
    } catch (e) {
      reportError("list_gateway_channels", e);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!types || !channels) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  // Create form.
  if (selectedId === "__new__") {
    return (
      <ChannelForm
        mode="new"
        types={types}
        channel={null}
        snapshot={snapshot}
        configuredKeys={keyNames}
        onGoToKeys={onGoToKeys}
        onSaved={() => {
          refresh();
          onSelect(null);
        }}
        onCancel={() => onSelect(null)}
      />
    );
  }

  // Edit form for an existing channel.
  if (selectedId) {
    const channel = channels.find((c) => c.id === selectedId);
    if (channel) {
      return (
        <ChannelForm
          mode="edit"
          types={types}
          channel={channel}
          snapshot={snapshot}
          configuredKeys={keyNames}
          onGoToKeys={onGoToKeys}
          onSaved={() => {
            refresh();
          }}
          onCancel={() => onSelect(null)}
        />
      );
    }
  }

  // List view.
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-accent">Gateway channels</h2>
          <button
            onClick={() => onSelect("__new__")}
            className="px-2 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded"
          >
            + New channel
          </button>
        </div>
        <p className="text-xs text-gray-500">
          A channel connects a messaging platform (WhatsApp via Twilio today) to
          a persona. Inbound messages run the channel's persona; replies are sent
          back over the same platform. Secrets live in the Keys tab.
        </p>
        {channels.length === 0 ? (
          <div className="text-sm text-gray-500 italic">
            No channels configured. Click “+ New channel” to add one.
          </div>
        ) : (
          <ul className="space-y-2">
            {channels.map((c) => {
              const type = types.find((t) => t.id === c.type_id);
              return (
                <li
                  key={c.id}
                  className="bg-surface-1 border border-surface-3 rounded p-4 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onSelect(c.id)}
                        className="text-sm font-medium text-gray-200 hover:text-accent-light text-left"
                      >
                        {c.name}
                      </button>
                      <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-surface-2 text-gray-400 rounded font-mono">
                        {type?.name ?? c.type_id}
                      </span>
                      {c.enabled && (
                        <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-green-900/40 text-green-300 rounded">
                          Enabled
                        </span>
                      )}
                    </div>
                    {c.settings.from && (
                      <p className="text-xs text-gray-500 mt-1 font-mono">
                        {c.settings.from}
                        {c.settings.persona ? ` · ${c.settings.persona}` : ""}
                      </p>
                    )}
                  </div>
                  <ChannelToggle
                    channelId={c.id}
                    enabled={c.enabled}
                    onChanged={refresh}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ChannelToggle({
  channelId,
  enabled,
  onChanged,
}: {
  channelId: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const reportError = useReportError();
  const [pending, setPending] = useState(false);
  const toggle = async () => {
    setPending(true);
    try {
      await invoke("set_gateway_channel_enabled", { id: channelId, enabled: !enabled });
      onChanged();
    } catch (e) {
      reportError("set_gateway_channel_enabled", e);
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`px-3 py-1.5 text-xs rounded font-medium disabled:opacity-40 ${
        enabled
          ? "bg-red-900/40 hover:bg-red-900/60 text-red-200"
          : "bg-accent hover:bg-accent-light text-white"
      }`}
    >
      {pending ? "…" : enabled ? "Disable" : "Enable"}
    </button>
  );
}

function ChannelForm({
  mode,
  types,
  channel,
  snapshot,
  configuredKeys,
  onGoToKeys,
  onSaved,
  onCancel,
}: {
  mode: "new" | "edit";
  types: GatewayType[];
  channel: GatewayChannel | null;
  snapshot: ProjectSnapshot;
  configuredKeys: Set<string>;
  onGoToKeys: (name: string) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const reportError = useReportError();
  const [typeId, setTypeId] = useState(channel?.type_id ?? types[0]?.id ?? "");
  const [name, setName] = useState(channel?.name ?? "");
  const [settings, setSettings] = useState<Record<string, string>>(
    channel?.settings ?? {},
  );
  const [enabled, setEnabled] = useState(channel?.enabled ?? false);
  const [saving, setSaving] = useState(false);

  const type = useMemo(() => types.find((t) => t.id === typeId), [types, typeId]);

  const setField = (key: string, value: string) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const save = async () => {
    if (!name.trim() || !typeId) return;
    setSaving(true);
    try {
      if (mode === "new") {
        await invoke("create_gateway_channel", { typeId, name: name.trim(), settings });
      } else if (channel) {
        await invoke("update_gateway_channel", {
          id: channel.id,
          name: name.trim(),
          enabled,
          settings,
        });
      }
      onSaved();
    } catch (e) {
      reportError(mode === "new" ? "create_gateway_channel" : "update_gateway_channel", e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!channel || !confirm(`Delete channel "${channel.name}"?`)) return;
    try {
      await invoke("delete_gateway_channel", { id: channel.id });
      onCancel();
    } catch (e) {
      reportError("delete_gateway_channel", e);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl space-y-4">
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300">
          ← back to channels
        </button>
        <h2 className="text-lg font-semibold text-accent">
          {mode === "new" ? "New gateway channel" : channel?.name}
        </h2>

        {mode === "new" ? (
          <Field label="Channel type">
            <select
              value={typeId}
              onChange={(e) => {
                setTypeId(e.target.value);
                setSettings({});
              }}
              className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="text-xs text-gray-500">
            Type: <span className="font-mono text-gray-300">{type?.name ?? typeId}</span>
          </div>
        )}

        {type && <p className="text-xs text-gray-500">{type.description}</p>}

        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Support line"
            className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
          />
        </Field>

        {type?.settings.map((field) => (
          <SettingInput
            key={field.key}
            field={field}
            value={settings[field.key] ?? ""}
            personas={snapshot.personas.map((p) => p.slug)}
            onChange={(v) => setField(field.key, v)}
          />
        ))}

        {type && type.requires_env.length > 0 && (
          <RequiredKeys
            keys={type.requires_env}
            configured={configuredKeys}
            onGoToKeys={onGoToKeys}
            clickable={mode === "edit"}
          />
        )}

        <div className="flex items-center gap-3 pt-4 border-t border-surface-3">
          <button
            onClick={save}
            disabled={saving || !name.trim() || !typeId}
            className="px-4 py-2 bg-accent hover:bg-accent-light text-white rounded text-sm font-medium disabled:opacity-40"
          >
            {saving ? "Saving…" : mode === "new" ? "Create channel" : "Save"}
          </button>
          {mode === "edit" && (
            <>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Enabled
              </label>
              <div className="flex-1" />
              <button
                onClick={remove}
                className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded text-sm"
              >
                Delete
              </button>
            </>
          )}
        </div>
        {mode === "new" && (
          <p className="text-[11px] text-gray-500">
            New channels start disabled. Configure its keys, then enable it from
            the channel list (or the toggle here after saving).
          </p>
        )}
      </div>
    </div>
  );
}

function SettingInput({
  field,
  value,
  personas,
  onChange,
}: {
  field: GatewaySettingField;
  value: string;
  personas: string[];
  onChange: (v: string) => void;
}) {
  const label = field.required ? `${field.label} *` : field.label;
  return (
    <Field label={label}>
      {field.input_type === "persona" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
        >
          <option value="">{field.placeholder ?? "Select a persona…"}</option>
          {personas.map((slug) => (
            <option key={slug} value={slug}>
              {slug}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.input_type === "password" ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? ""}
          autoComplete="off"
          spellCheck={false}
          className="w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded font-mono text-sm"
        />
      )}
      {field.help && <p className="text-[11px] text-gray-500 mt-1">{field.help}</p>}
    </Field>
  );
}

/// The API keys this channel type needs, with configured status pulled from the
/// stored-keys snapshot. Once the channel exists (`clickable`), unconfigured keys
/// deep-link to the Keys tab. Before the channel is created the keys are shown but
/// not clickable — navigating away would wipe the in-progress form.
function RequiredKeys({
  keys,
  configured,
  onGoToKeys,
  clickable,
}: {
  keys: string[];
  configured: Set<string>;
  onGoToKeys: (name: string) => void;
  clickable: boolean;
}) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        Required API keys
      </h3>
      <ul className="space-y-1.5">
        {keys.map((k) => {
          const isSet = configured.has(k);
          return (
            <li
              key={k}
              className="flex items-center gap-2 px-3 py-2 bg-surface-1 border border-surface-3 rounded"
            >
              <span className="font-mono text-sm text-gray-200 truncate">{k}</span>
              <div className="flex-1" />
              {isSet ? (
                clickable ? (
                  <button
                    onClick={() => onGoToKeys(k)}
                    className="text-xs text-green-400 hover:underline whitespace-nowrap"
                    title="Configured — click to rotate the value"
                  >
                    ✓ configured
                  </button>
                ) : (
                  <span className="text-xs text-green-400 whitespace-nowrap">
                    ✓ configured
                  </span>
                )
              ) : clickable ? (
                <button
                  onClick={() => onGoToKeys(k)}
                  className="px-2 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded whitespace-nowrap"
                >
                  + Add in Keys
                </button>
              ) : (
                <span className="text-xs text-gray-500 whitespace-nowrap">
                  not configured
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {!clickable && (
        <p className="text-[11px] text-gray-500 mt-2">
          Save this channel first, then add its keys from the Keys tab.
        </p>
      )}
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
