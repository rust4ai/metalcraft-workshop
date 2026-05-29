import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function EntryNode({ data, selected }: NodeProps) {
  const d = data as Record<string, unknown>;
  const scheduleType = (d?.schedule_type as string) || "manual";
  const interval = (d?.interval as number) || 0;
  const cron = (d?.cron as string) || "";

  let label = "Manual";
  if (scheduleType === "minutes") label = `Every ${interval || "?"}m`;
  else if (scheduleType === "hours") label = `Every ${interval || "?"}h`;
  else if (scheduleType === "cron") label = cron ? `cron: ${cron}` : "cron";

  // Inline styles only — Tailwind classes may not be applying inside
  // React Flow's node renderer for some reason, so we use explicit styles
  // to guarantee the box is sized and themed.
  return (
    <div
      style={{
        background: "#12121a",
        color: "#e5e7eb",
        border: selected ? "1px solid #d97706" : "1px solid #2a2a35",
        borderRadius: 8,
        minWidth: 200,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid #2a2a35",
          background: "rgba(34,197,94,0.10)",
          borderRadius: "8px 8px 0 0",
        }}
      >
        <span style={{ color: "#4ade80", fontSize: 14 }}>●</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: "#e5e7eb" }}>Entry</span>
      </div>
      <div style={{ padding: "6px 10px", fontSize: 12, color: "#9ca3af" }}>{label}</div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="default"
        style={{ width: 10, height: 10, background: "#22c55e", border: "1px solid #166534" }}
      />
    </div>
  );
}
