import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import { GatewayEventList } from "./GatewayEvents";
import type {
  GatewayChannel,
  GatewayEvent,
  GatewaySettingField,
  GatewayType,
  KeySummary,
  ProjectSnapshot,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  /// Base URL of the active remote connection, used to render the exact inbound
  /// webhook URL the user must paste into the upstream platform. Null in local
  /// mode (gateway channels aren't shown there anyway).
  remoteBaseUrl: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /// Jump to the Keys tab, optionally focused on a key name (to add/rotate it).
  onGoToKeys: (name: string) => void;
}

// Adapters that receive inbound traffic at `<agent>/webhook/<adapter>` and so
// need the user to register that URL upstream. Keep in sync with the daemon's
// inbound webhook routes (workshop_api.rs).
const INBOUND_WEBHOOK_ADAPTERS = new Set(["pipestreamr", "twilio"]);

export default function GatewayView({ snapshot, remoteBaseUrl, selectedId, onSelect, onGoToKeys }: Props) {
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
        remoteBaseUrl={remoteBaseUrl}
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
          remoteBaseUrl={remoteBaseUrl}
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

// Shows the exact URL the user must register on the upstream platform (e.g. a
// PipeStreamr project webhook) so inbound messages reach this agent. When the
// connection base URL is known we render the real URL; otherwise a template the
// user fills in with their public agent domain.
function InboundWebhookCallout({
  adapter,
  baseUrl,
}: {
  adapter: string;
  baseUrl: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const root = baseUrl?.replace(/\/+$/, "");
  const url = `${root ?? "https://<your-agent-domain>"}/webhook/${adapter}`;
  const copyable = !!root;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable; the URL is selectable as a fallback.
    }
  };

  return (
    <div className="rounded border border-accent/30 bg-accent/5 p-3 space-y-1.5">
      <p className="text-xs font-medium text-accent-light">Inbound webhook URL</p>
      <p className="text-[11px] text-gray-400">
        Register this URL on the upstream platform (e.g. your PipeStreamr project
        webhook, event <span className="font-mono">message.created</span>) so its
        messages reach this agent.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate px-2 py-1.5 bg-surface-1 border border-surface-3 rounded text-[11px] font-mono text-gray-200">
          {url}
        </code>
        {copyable && (
          <button
            onClick={copy}
            className="shrink-0 px-2 py-1.5 text-[11px] bg-surface-2 hover:bg-surface-3 text-gray-300 rounded"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {!copyable && (
        <p className="text-[11px] text-gray-500">
          Replace <span className="font-mono">&lt;your-agent-domain&gt;</span>{" "}
          with your agent's public domain.
        </p>
      )}
    </div>
  );
}

function ChannelForm({
  mode,
  types,
  channel,
  snapshot,
  remoteBaseUrl,
  configuredKeys,
  onGoToKeys,
  onSaved,
  onCancel,
}: {
  mode: "new" | "edit";
  types: GatewayType[];
  channel: GatewayChannel | null;
  snapshot: ProjectSnapshot;
  remoteBaseUrl: string | null;
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
  const [tab, setTab] = useState<"settings" | "events">("settings");

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

        {mode === "edit" && (
          <div className="flex gap-1 border-b border-surface-3 -mt-1">
            {(["settings", "events"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${
                  tab === t
                    ? "border-accent text-accent-light"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                {t === "settings" ? "Settings" : "Events"}
              </button>
            ))}
          </div>
        )}

        {mode === "edit" && tab === "events" && channel && (
          <ChannelEventsTab channelId={channel.id} />
        )}

        {(mode === "new" || tab === "settings") && (
          <>
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

        {type && INBOUND_WEBHOOK_ADAPTERS.has(type.adapter) && (
          <InboundWebhookCallout adapter={type.adapter} baseUrl={remoteBaseUrl} />
        )}

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
          </>
        )}
      </div>
    </div>
  );
}

/// The "Events" tab on a channel's show page: recent inbound/outbound traffic
/// that matched this channel. Fetched on mount and on demand via Refresh.
function ChannelEventsTab({ channelId }: { channelId: string }) {
  const reportError = useReportError();
  const [events, setEvents] = useState<GatewayEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await invoke<GatewayEvent[]>("list_gateway_channel_events", { id: channelId }));
    } catch (e) {
      reportError("list_gateway_channel_events", e);
    } finally {
      setLoading(false);
    }
  }, [channelId, reportError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          Inbound messages and outbound replies for this channel.
        </p>
        <button
          onClick={load}
          disabled={loading}
          className="px-2 py-1 text-xs bg-surface-2 hover:bg-surface-3 text-gray-300 rounded disabled:opacity-40"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      {events === null ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <GatewayEventList events={events} />
      )}
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
