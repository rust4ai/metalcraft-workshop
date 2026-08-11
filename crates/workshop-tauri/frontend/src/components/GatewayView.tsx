import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import { GatewayEventList } from "./GatewayEvents";
import type {
  Channel,
  GatewayEvent,
  MetalcraftGatewayStatus,
  ProjectSnapshot,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  /// Base URL of the active remote connection (unused by the channels view;
  /// kept for the tab's prop contract).
  remoteBaseUrl: string | null;
  /// The expanded channel slug (drives the activity panel), via the app's shared
  /// selection state.
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onGoToKeys: (name: string) => void;
}

/// The Gateway tab. A **channel is a connection** to a gateway
/// (`{ slug, name, url }`). The built-in `metalcraft` channel is always present
/// and read-only (its secret is the pod token); users add custom channels with
/// their own url + secret. Expanding a channel shows its recent activity,
/// labelled by delivery kind — no transport/protocol names.
export default function GatewayView({ snapshot, selectedId, onSelect }: Props) {
  const reportError = useReportError();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [mg, setMg] = useState<MetalcraftGatewayStatus | null>(null);
  const [adding, setAdding] = useState(false);

  // Gateway state lives on the agent — local mode has nothing to show.
  if (snapshot.mode !== "remote") {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md text-sm text-gray-400">
          <p className="mb-2">
            Channels are managed by the agent process and are only visible when
            connected to a remote agent.
          </p>
          <p className="text-xs text-gray-500">
            Start the agent with{" "}
            <code className="text-accent-light">metalcraft-daemon --api &lt;KEY&gt;</code>{" "}
            and connect via the Remote tab.
          </p>
        </div>
      </div>
    );
  }

  const refresh = useCallback(async () => {
    try {
      const c = await invoke<Channel[]>("list_channels");
      setChannels(c);
      invoke<MetalcraftGatewayStatus>("gateway_metalcraft_status")
        .then(setMg)
        .catch(() => setMg(null));
    } catch (e) {
      reportError("list_channels", e);
    }
  }, [reportError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (channels === null) {
    return <div className="p-6 text-sm text-gray-500">Loading gateway…</div>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400">Channels</h3>
        {!adding && (
          <button
            className="px-2.5 py-1 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded"
            onClick={() => setAdding(true)}
          >
            + Add channel
          </button>
        )}
      </div>

      {adding && (
        <ChannelForm
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}

      <div className="space-y-2">
        {channels.map((c) => (
          <ChannelRow
            key={c.slug}
            channel={c}
            mg={mg}
            expanded={selectedId === c.slug}
            onToggle={() => onSelect(selectedId === c.slug ? null : c.slug)}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  );
}

/// One channel: name/url + status, expandable to its activity. `metalcraft` is
/// read-only (built-in) and surfaces inbound status; custom channels can be
/// edited or removed.
function ChannelRow({
  channel,
  mg,
  expanded,
  onToggle,
  onChanged,
}: {
  channel: Channel;
  mg: MetalcraftGatewayStatus | null;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const reportError = useReportError();
  const [editing, setEditing] = useState(false);
  const [events, setEvents] = useState<GatewayEvent[] | null>(null);

  useEffect(() => {
    if (expanded && events === null) {
      invoke<GatewayEvent[]>("channel_events", { slug: channel.slug })
        .then(setEvents)
        .catch((e) => {
          reportError("channel_events", e);
          setEvents([]);
        });
    }
  }, [expanded, events, channel.slug, reportError]);

  const remove = useCallback(async () => {
    if (!confirm(`Remove channel “${channel.name}”?`)) return;
    try {
      await invoke("delete_channel", { slug: channel.slug });
      await onChanged();
    } catch (e) {
      reportError("delete_channel", e);
    }
  }, [channel, onChanged, reportError]);

  if (editing) {
    return (
      <ChannelForm
        channel={channel}
        onCancel={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await onChanged();
        }}
      />
    );
  }

  return (
    <div className="bg-surface-1 border border-surface-3 rounded overflow-hidden">
      <div className="flex items-center gap-3 p-3.5">
        <button className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${channel.enabled === false ? "bg-gray-600" : "bg-green-400"}`}
            />
            <span className="truncate text-sm font-medium text-gray-200">{channel.name}</span>
            {channel.managed ? (
              <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-green-900/40 text-green-300 rounded">
                built-in
              </span>
            ) : channel.enabled === false ? (
              <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-surface-2 text-gray-400 rounded">
                disabled
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[11px] font-mono text-gray-500">
            {channel.slug} · {channel.url}
          </div>
          {channel.managed && (
            <div className="mt-0.5 text-[11px] text-gray-500">{metalcraftStatusLabel(mg)}</div>
          )}
        </button>
        {!channel.managed && (
          <div className="flex shrink-0 gap-1">
            <button
              className="px-2 py-1 text-xs bg-surface-2 hover:bg-surface-3 text-gray-300 rounded"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              className="px-2 py-1 text-xs bg-red-900/30 hover:bg-red-900/50 text-red-300 rounded"
              onClick={remove}
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-surface-3">
          {events === null ? (
            <div className="text-sm text-gray-500 py-3 text-center">Loading activity…</div>
          ) : (
            <div className="max-h-80 overflow-y-auto p-3">
              <GatewayEventList events={events} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// Add or edit a custom channel.
function ChannelForm({
  channel,
  onCancel,
  onSaved,
}: {
  channel?: Channel;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const reportError = useReportError();
  const editing = !!channel;
  const [name, setName] = useState(channel?.name ?? "");
  const [url, setUrl] = useState(channel?.url ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const canSave = name.trim() && url.trim() && (editing || secret.trim());

  const save = useCallback(async () => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await invoke("update_channel", {
          slug: channel!.slug,
          name: name.trim(),
          url: url.trim(),
          enabled: channel!.enabled ?? true,
          secret: secret.trim() || null,
        });
      } else {
        await invoke("create_channel", { name: name.trim(), url: url.trim(), secret: secret.trim() });
      }
      await onSaved();
    } catch (e) {
      reportError(editing ? "update_channel" : "create_channel", e);
    } finally {
      setBusy(false);
    }
  }, [canSave, busy, editing, channel, name, url, secret, onSaved, reportError]);

  return (
    <div className="bg-surface-1 border border-surface-3 rounded p-3.5 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">
        {editing ? `Edit ${channel!.slug}` : "New channel"}
      </div>
      <Field label="Name" value={name} onChange={setName} placeholder="My gateway" />
      <Field label="URL" value={url} onChange={setUrl} placeholder="https://gateway.example.com" />
      <Field
        label={editing ? "Secret (leave blank to keep)" : "Secret"}
        value={secret}
        onChange={setSecret}
        placeholder="bearer token"
        type="password"
      />
      <div className="flex justify-end gap-2 pt-1">
        <button
          className="px-2.5 py-1 text-xs bg-surface-2 hover:bg-surface-3 text-gray-300 rounded disabled:opacity-40"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className="px-2.5 py-1 text-xs bg-accent hover:bg-accent-light text-white rounded disabled:opacity-40"
          onClick={save}
          disabled={!canSave || busy}
        >
          {busy ? "Saving…" : editing ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-gray-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-0.5 w-full px-3 py-2 bg-surface-1 border border-surface-3 rounded text-sm"
      />
    </label>
  );
}

/// Honest one-liner for the built-in Metalcraft channel's inbound status.
function metalcraftStatusLabel(mg: MetalcraftGatewayStatus | null): string {
  if (!mg?.connected) return mg?.registered ? "Inbound: registered, not connected" : "Inbound: not set up";
  const num = mg.active_number;
  const suffix = num ? ` · ${num}` : "";
  if (mg.streaming) return `Inbound: receiving${suffix}`;
  if (mg.webhook_stale) return `Inbound: reconnecting${suffix}`;
  return `Inbound: connected${suffix}`;
}
