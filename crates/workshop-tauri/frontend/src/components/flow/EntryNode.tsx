import { Handle, Position, type NodeProps } from "@xyflow/react";

export default function EntryNode({ data, selected }: NodeProps) {
  const d = data as Record<string, unknown>;
  const scheduleType = (d.schedule_type as string) || "manual";
  const interval = (d.interval as number) || 0;
  const cron = (d.cron as string) || "";

  let label = "Manual";
  if (scheduleType === "minutes") label = `Every ${interval || "?"}m`;
  else if (scheduleType === "hours") label = `Every ${interval || "?"}h`;
  else if (scheduleType === "cron") label = cron ? `cron: ${cron}` : "cron";

  return (
    <div
      className={`rounded-lg border shadow-lg min-w-[200px] bg-surface-1 ${
        selected ? "border-accent ring-1 ring-accent/50" : "border-surface-3"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-3 rounded-t-lg bg-green-500/10">
        <svg
          className="w-4 h-4 text-green-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span className="text-xs font-medium text-gray-200">Entry</span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-400">{label}</div>
      <div className="relative" style={{ height: 12 }}>
        <Handle
          type="source"
          position={Position.Bottom}
          id="default"
          className="!w-3 !h-3 !bg-green-500 !border-green-700"
        />
      </div>
    </div>
  );
}
