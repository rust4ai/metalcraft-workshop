import type { GatewayEvent, GatewayOutcome } from "../types";

// Outcome → badge color + human label. Green = success, red = dropped/failed,
// amber = misconfiguration the user can fix.
function outcomeStyle(outcome: GatewayOutcome): { cls: string; label: string } {
  switch (outcome) {
    case "routed":
      return { cls: "bg-green-900/40 text-green-300", label: "routed" };
    case "sent":
      return { cls: "bg-green-900/40 text-green-300", label: "sent" };
    case "no_matching_channel":
      return { cls: "bg-amber-900/40 text-amber-300", label: "no matching channel" };
    case "no_persona":
      return { cls: "bg-amber-900/40 text-amber-300", label: "no persona" };
    case "signature_rejected":
      return { cls: "bg-red-900/40 text-red-300", label: "signature rejected" };
    case "send_failed":
      return { cls: "bg-red-900/40 text-red-300", label: "send failed" };
    default:
      return { cls: "bg-surface-2 text-gray-400", label: outcome };
  }
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

/// Renders a list of gateway events, newest first (the caller passes them in
/// that order). `showChannel` adds the channel column for the global Network
/// view; per-channel views omit it.
export function GatewayEventList({
  events,
  showChannel = false,
}: {
  events: GatewayEvent[];
  showChannel?: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="text-sm text-gray-500 italic py-6 text-center">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {events.map((e, i) => {
        const style = outcomeStyle(e.outcome);
        const inbound = e.direction === "inbound";
        const peer = inbound
          ? e.from_name || e.from || "unknown"
          : e.to || "unknown";
        return (
          <li
            key={`${e.ts}-${i}`}
            className="bg-surface-1 border border-surface-3 rounded p-3 text-sm"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded font-mono ${
                  inbound ? "bg-blue-900/40 text-blue-300" : "bg-purple-900/40 text-purple-300"
                }`}
                title={inbound ? "inbound" : "outbound"}
              >
                {inbound ? "↓ in" : "↑ out"}
              </span>
              <span className="font-medium text-gray-200 truncate">{peer}</span>
              <span className={`px-1.5 py-0.5 text-[10px] rounded ${style.cls}`}>
                {style.label}
              </span>
              <span className="px-1.5 py-0.5 text-[10px] bg-surface-2 text-gray-400 rounded font-mono">
                {e.platform}
              </span>
              {showChannel && (
                <span className="text-[11px] text-gray-500 truncate">
                  {e.channel_name ?? (e.channel_id ? e.channel_id : "— unrouted")}
                </span>
              )}
              <span className="ml-auto text-[11px] text-gray-500 shrink-0">
                {formatTs(e.ts)}
              </span>
            </div>
            {e.body && (
              <p className="mt-1.5 text-gray-300 break-words whitespace-pre-wrap">{e.body}</p>
            )}
            {e.detail && (
              <p className="mt-1 text-[11px] text-gray-500">{e.detail}</p>
            )}
            {(e.source_id || e.from || e.to) && (
              <p className="mt-1 text-[10px] text-gray-600 font-mono break-all">
                {inbound && e.from ? `from ${e.from}` : ""}
                {!inbound && e.to ? `to ${e.to}` : ""}
                {e.source_id ? `  ·  integration ${e.source_id}` : ""}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
