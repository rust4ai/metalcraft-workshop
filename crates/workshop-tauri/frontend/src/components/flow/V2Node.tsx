import { Handle, Position, type NodeProps } from "@xyflow/react";

// Per-node-type accent color (matches the palette in FlowsView).
const ACCENT: Record<string, string> = {
  entry: "#7c5cff",
  prompt: "#3b82f6",
  conditional: "#f59e0b",
  branch: "#ec4899",
  set_variable: "#10b981",
  tool: "#14b8a6",
  http: "#06b6d4",
  sub_agent: "#8b5cf6",
  approval: "#eab308",
  wait: "#64748b",
  end: "#6b7280",
  branch_tool: "#ec4899",
};

type Data = Record<string, unknown>;

/** The source (outgoing) handles a node emits, by type + data. */
export function sourceHandles(type: string, data: Data): string[] {
  const dedupe = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
  switch (type) {
    case "entry":
    case "set_variable":
      return ["default"];
    case "prompt":
    case "tool":
    case "http":
    case "sub_agent":
      return ["ok", "error"];
    case "conditional": {
      const hs = ((data.conditions as { handle?: string }[]) ?? []).map((c) => c.handle ?? "");
      if (data.default_handle) hs.push(data.default_handle as string);
      return dedupe(hs).length ? dedupe(hs) : ["default"];
    }
    case "branch": {
      const hs = ((data.outputs as { handle?: string }[]) ?? []).map((o) => o.handle ?? "");
      if (data.default_handle) hs.push(data.default_handle as string);
      return dedupe(hs).length ? dedupe(hs) : ["default"];
    }
    case "branch_tool": {
      const hs = Object.keys((data.branches as Record<string, unknown>) ?? {});
      return hs.length ? hs : ["default"];
    }
    case "approval":
      return dedupe((data.choices as string[]) ?? ["approve", "reject"]);
    case "wait":
      return ["after"];
    case "end":
      return [];
    default:
      return ["default"];
  }
}

/** A one-line summary of the node's key config for the canvas. */
function summary(type: string, data: Data): string {
  const s = (v: unknown, n = 28) => {
    const str = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    return str.length > n ? str.slice(0, n) + "…" : str;
  };
  switch (type) {
    case "entry":
      return String(data.schedule_type ?? "manual");
    case "prompt":
      return s(data.prompt);
    case "conditional":
      return `${((data.conditions as unknown[]) ?? []).length} condition(s)`;
    case "branch":
      return s(data.query);
    case "set_variable":
      return `${data.variable ?? "?"} = …`;
    case "tool":
      return String(data.tool_name ?? "");
    case "http":
      return `${data.method ?? "GET"} ${s(data.url, 20)}`;
    case "sub_agent":
      return s(data.task);
    case "approval":
      return s(data.message);
    case "wait":
      return String(data.duration ?? data.until ?? "");
    case "end":
      return String(data.status ?? "completed");
    default:
      return "";
  }
}

/** One node component, driven by its `type` — renders the right handles for
 *  every v2 node type (single default, ok/error, dynamic branch/conditional
 *  handles, approval choices, wait `after`, terminal `end`). */
export default function V2Node({ id, type, data, selected }: NodeProps) {
  const t = (type as string) ?? "prompt";
  const d = (data as Data) ?? {};
  const accent = ACCENT[t] ?? "#7c5cff";
  const outs = sourceHandles(t, d);
  const hasTarget = t !== "entry";

  return (
    <div
      style={{ borderColor: selected ? accent : "#3a3a44", boxShadow: selected ? `0 0 0 1px ${accent}` : undefined }}
      className="rounded-md bg-surface-1 border text-xs min-w-[140px] max-w-[220px]"
    >
      {hasTarget && <Handle type="target" position={Position.Top} id="default" style={{ background: "#666" }} />}
      <div
        className="px-2 py-1 rounded-t-md font-semibold text-white/90"
        style={{ background: accent + "33", borderBottom: `1px solid ${accent}55` }}
      >
        <span style={{ color: accent }}>{t}</span>
      </div>
      <div className="px-2 py-1.5">
        <div className="font-mono text-[10px] text-gray-500">{id}</div>
        {summary(t, d) && <div className="text-gray-300 truncate">{summary(t, d)}</div>}
      </div>
      {outs.length > 0 && (
        <div className="relative h-5">
          {outs.map((h, i) => {
            const left = `${((i + 1) / (outs.length + 1)) * 100}%`;
            return (
              <div key={h}>
                <Handle type="source" position={Position.Bottom} id={h} style={{ left, background: accent }} />
                <span
                  className="absolute text-[9px] text-gray-500 -translate-x-1/2"
                  style={{ left, bottom: "-2px" }}
                >
                  {h}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
