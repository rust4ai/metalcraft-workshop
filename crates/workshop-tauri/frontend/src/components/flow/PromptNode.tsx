import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function PromptNode({ data, selected }: NodeProps) {
  const prompt = ((data as Record<string, unknown> | undefined)?.prompt as string) || "";
  return (
    <div
      style={{
        background: "#12121a",
        color: "#e5e7eb",
        border: selected ? "1px solid #d97706" : "1px solid #2a2a35",
        borderRadius: 8,
        minWidth: 200,
        maxWidth: 240,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ width: 10, height: 10, background: "#9ca3af", border: "1px solid #6b7280" }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid #2a2a35",
          background: "rgba(129,140,248,0.10)",
          borderRadius: "8px 8px 0 0",
        }}
      >
        <span style={{ color: "#818cf8", fontSize: 14 }}>●</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: "#e5e7eb" }}>Prompt</span>
      </div>
      <div
        style={{
          padding: "6px 10px",
          fontSize: 12,
          color: "#9ca3af",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {prompt || <span style={{ fontStyle: "italic" }}>No prompt set</span>}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="default"
        style={{ width: 10, height: 10, background: "#818cf8", border: "1px solid #4338ca" }}
      />
    </div>
  );
}
