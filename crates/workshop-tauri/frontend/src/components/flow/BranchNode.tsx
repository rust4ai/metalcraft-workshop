import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function BranchNode({ data, selected }: NodeProps) {
  const condition = ((data as Record<string, unknown>).condition as string) || "";
  return (
    <div
      className={`rounded-lg border shadow-lg min-w-[200px] bg-surface-1 ${
        selected ? "border-accent ring-1 ring-accent/50" : "border-surface-3"
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-gray-500 !border-gray-600"
      />
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-3 rounded-t-lg bg-amber-500/10">
        <svg
          className="w-4 h-4 text-amber-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3"
          />
        </svg>
        <span className="text-xs font-medium text-gray-200">Branch</span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-400 max-w-[220px]">
        {condition ? <p className="truncate">{condition}</p> : <p className="italic">No condition</p>}
      </div>
      <div className="relative flex justify-between px-6" style={{ height: 12 }}>
        <Handle
          type="source"
          position={Position.Bottom}
          id="true"
          style={{ left: "30%" }}
          className="!w-3 !h-3 !bg-green-500 !border-green-700"
        />
        <Handle
          type="source"
          position={Position.Bottom}
          id="false"
          style={{ left: "70%" }}
          className="!w-3 !h-3 !bg-red-500 !border-red-700"
        />
      </div>
    </div>
  );
}
