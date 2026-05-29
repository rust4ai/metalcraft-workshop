import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function PromptNode({ data, selected }: NodeProps) {
  const prompt = ((data as Record<string, unknown>).prompt as string) || "";
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-3 rounded-t-lg bg-indigo-500/10">
        <svg
          className="w-4 h-4 text-indigo-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
          />
        </svg>
        <span className="text-xs font-medium text-gray-200">Prompt</span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-400 max-w-[220px]">
        {prompt ? <p className="truncate">{prompt}</p> : <p className="italic">No prompt set</p>}
      </div>
      <div className="relative" style={{ height: 12 }}>
        <Handle
          type="source"
          position={Position.Bottom}
          id="default"
          className="!w-3 !h-3 !bg-accent !border-accent"
        />
      </div>
    </div>
  );
}
