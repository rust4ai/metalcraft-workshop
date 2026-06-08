import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import { GatewayEventList } from "./GatewayEvents";
import type { GatewayEvent, ProjectSnapshot } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
}

type Filter = "all" | "inbound" | "outbound" | "unrouted";

/// Global gateway traffic log — every inbound message and outbound reply across
/// all channels, including inbound messages that matched no channel ("unrouted",
/// the usual sign of a misconfigured integration ID).
export default function NetworkView({ snapshot }: Props) {
  const reportError = useReportError();
  const [events, setEvents] = useState<GatewayEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  // Gateway activity lives on the agent — local mode has nothing to show.
  if (snapshot.mode !== "remote") {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md text-sm text-gray-400">
          <p className="mb-2">
            Network activity is recorded by the agent process and is only visible
            when connected to a remote agent.
          </p>
          <p className="text-xs text-gray-500">
            Connect via the Remote tab to see inbound/outbound gateway traffic.
          </p>
        </div>
      </div>
    );
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await invoke<GatewayEvent[]>("list_gateway_activity"));
    } catch (e) {
      reportError("list_gateway_activity", e);
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!events) return [];
    switch (filter) {
      case "inbound":
        return events.filter((e) => e.direction === "inbound");
      case "outbound":
        return events.filter((e) => e.direction === "outbound");
      case "unrouted":
        return events.filter((e) => !e.channel_id);
      default:
        return events;
    }
  }, [events, filter]);

  const unroutedCount = useMemo(
    () => (events ?? []).filter((e) => !e.channel_id).length,
    [events],
  );

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "inbound", label: "Inbound" },
    { id: "outbound", label: "Outbound" },
    { id: "unrouted", label: `Unrouted${unroutedCount ? ` (${unroutedCount})` : ""}` },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-accent">Network</h2>
          <button
            onClick={load}
            disabled={loading}
            className="px-2 py-1 text-xs bg-surface-2 hover:bg-surface-3 text-gray-300 rounded disabled:opacity-40"
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          All inbound messages and outbound replies across every gateway channel.
          "Unrouted" entries are inbound messages that matched no enabled channel —
          usually a wrong or missing integration ID.
        </p>

        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1 text-xs rounded ${
                filter === f.id
                  ? "bg-accent/20 text-accent-light"
                  : "bg-surface-1 text-gray-400 hover:text-gray-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {events === null ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <GatewayEventList events={filtered} showChannel />
        )}
      </div>
    </div>
  );
}
