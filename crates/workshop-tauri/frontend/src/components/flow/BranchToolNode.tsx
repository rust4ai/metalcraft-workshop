import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function BranchToolNode({ data, selected }: NodeProps) {
  const d = data as Record<string, unknown>;
  const condition = (d.condition as string) || "";
  const outputs = (d.outputs as string[]) || [];

  return (
    <div
      className={`rounded-lg border shadow-lg min-w-[220px] bg-surface-1 ${
        selected ? "border-accent ring-1 ring-accent/50" : "border-surface-3"
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="default"
        className="!w-3 !h-3 !bg-gray-500 !border-gray-600"
      />
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-3 rounded-t-lg bg-cyan-500/10">
        <svg
          className="w-4 h-4 text-cyan-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"
          />
        </svg>
        <span className="text-xs font-medium text-gray-200">Tool Branch</span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-400 max-w-[240px]">
        {condition ? <p className="truncate">{condition}</p> : <p className="italic">No condition</p>}
        {outputs.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {outputs.map((o) => (
              <span
                key={o}
                className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-mono"
              >
                {o}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="relative flex justify-around px-3 pb-1" style={{ height: 12 }}>
        {outputs.length === 0 ? (
          <Handle
            type="source"
            position={Position.Bottom}
            id="default"
            className="!w-3 !h-3 !bg-cyan-500 !border-cyan-700"
          />
        ) : (
          outputs.map((output, i) => (
            <Handle
              key={output}
              type="source"
              position={Position.Bottom}
              id={output}
              style={{ left: `${((i + 1) * 100) / (outputs.length + 1)}%` }}
              className="!w-3 !h-3 !bg-cyan-500 !border-cyan-700"
            />
          ))
        )}
      </div>
    </div>
  );
}
