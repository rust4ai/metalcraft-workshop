import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type { ChatMessage, ChatTimeline, ProjectSnapshot, TimelineEvent } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function ChatsView({ selectedId }: Props) {
  const [timeline, setTimeline] = useState<ChatTimeline | null>(null);
  const reportError = useReportError();

  useEffect(() => {
    if (!selectedId) {
      setTimeline(null);
      return;
    }
    invoke<ChatTimeline>("load_diagnostics_session", { id: selectedId })
      .then(setTimeline)
      .catch((e) => reportError("load_diagnostics_session", e));
  }, [selectedId, reportError]);

  if (!selectedId) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Select a diagnostics session from the sidebar.
      </div>
    );
  }
  if (!timeline) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  const info = timeline.session;

  return (
    <div className="h-full overflow-y-auto">
      <header className="px-6 py-4 bg-surface-1 border-b border-surface-3 sticky top-0 z-10">
        <h2 className="text-sm font-semibold text-accent">{info.timestamp ?? selectedId}</h2>
        <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-3">
          {info.persona_slug && <span>persona: {info.persona_slug}</span>}
          {info.model_name && <span>model: {info.model_name}</span>}
          {info.cwd && <span className="font-mono truncate">cwd: {info.cwd}</span>}
          {info.auto_approve && <span className="text-amber-400">auto-approve</span>}
        </div>
      </header>

      <div className="px-6 py-4 space-y-3">
        {timeline.events.map((ev, i) => (
          <TimelineEventCard key={i} event={ev} />
        ))}
      </div>
    </div>
  );
}

function TimelineEventCard({ event }: { event: TimelineEvent }) {
  switch (event.kind) {
    case "turn":
      return <TurnCard turn={event.turn} messages={event.messages} />;
    case "llm_request":
      return (
        <details className="bg-surface-1 border border-surface-3 rounded px-3 py-2 text-xs">
          <summary className="cursor-pointer text-gray-400">
            LLM request before turn {event.turn}
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto text-gray-300 font-mono whitespace-pre-wrap">
            {JSON.stringify(event.snapshot, null, 2)}
          </pre>
        </details>
      );
    case "config_change":
      return (
        <div className="px-3 py-2 bg-amber-900/30 border border-amber-900/50 rounded text-xs text-amber-200">
          <div>⚙ {event.event} after turn {event.after_turn}</div>
          {event.details !== null && event.details !== undefined && (
            <pre className="mt-1 text-xs font-mono opacity-75">
              {JSON.stringify(event.details, null, 2)}
            </pre>
          )}
        </div>
      );
    case "compaction":
      return (
        <div className="px-3 py-2 bg-blue-900/30 border border-blue-900/50 rounded text-xs text-blue-200">
          🗜 Compaction after turn {event.after_turn}: {event.before_tokens} → {event.after_tokens} tokens
        </div>
      );
  }
}

function TurnCard({ turn, messages }: { turn: number; messages: ChatMessage[] }) {
  // Only render messages that weren't in the previous turn — diagnostics turn
  // files are cumulative, so the last few messages are what's new this turn.
  // For v1, just render the full snapshot of the latest turn directly. We can
  // diff against prev later.
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Turn {turn}</h3>
      <div className="space-y-2">
        {messages.map((m, i) => (
          <Message key={i} msg={m} />
        ))}
      </div>
    </section>
  );
}

function Message({ msg }: { msg: ChatMessage }) {
  switch (msg.role) {
    case "user":
      return (
        <div className="px-3 py-2 bg-surface-2 border-l-2 border-blue-500 rounded text-sm whitespace-pre-wrap">
          <div className="text-xs uppercase tracking-wide text-blue-400 mb-1">User</div>
          {msg.content}
        </div>
      );
    case "assistant":
      return (
        <div className="px-3 py-2 bg-surface-1 border-l-2 border-accent rounded text-sm whitespace-pre-wrap">
          <div className="text-xs uppercase tracking-wide text-accent-light mb-1">Assistant</div>
          {msg.content}
        </div>
      );
    case "tool_call":
      return (
        <details className="px-3 py-2 bg-surface-1 border-l-2 border-purple-500 rounded text-xs">
          <summary className="cursor-pointer text-purple-300">
            🔧 {msg.name}
          </summary>
          <pre className="mt-1 font-mono text-gray-400 whitespace-pre-wrap max-h-60 overflow-auto">
            {JSON.stringify(msg.args, null, 2)}
          </pre>
        </details>
      );
    case "tool_result":
      return (
        <details className={`px-3 py-2 bg-surface-1 border-l-2 rounded text-xs ${msg.is_error ? "border-red-500" : "border-green-500"}`}>
          <summary className={`cursor-pointer ${msg.is_error ? "text-red-300" : "text-green-300"}`}>
            ↳ {msg.name} result
          </summary>
          <pre className="mt-1 font-mono text-gray-400 whitespace-pre-wrap max-h-60 overflow-auto">
            {msg.result}
          </pre>
        </details>
      );
  }
}
