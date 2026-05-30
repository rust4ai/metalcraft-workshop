import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useReportError } from "../hooks/useReportError";
import type {
  ChatDetail,
  ChatStreamEvent,
  ChatSummary,
  ChatWireMessage,
  ProjectSnapshot,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function ChatsView({ snapshot, selectedId, onSelect }: Props) {
  const reportError = useReportError();

  if (snapshot.mode !== "remote") {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md text-sm text-gray-400">
          <p className="mb-2">
            Live chats require a remote connection — they invoke the agent
            runtime.
          </p>
          <p className="text-xs text-gray-500">
            Start the agent with{" "}
            <code className="text-accent-light">
              metalcraft-daemon --api &lt;KEY&gt;
            </code>{" "}
            and connect via the Remote tab in the project picker.
          </p>
        </div>
      </div>
    );
  }

  if (selectedId === "__new__" || selectedId === null) {
    return <NewChatPanel snapshot={snapshot} onCreated={onSelect} />;
  }

  return (
    <ChatTranscript
      key={selectedId}
      chatId={selectedId}
      onDelete={() => onSelect(null)}
      reportError={reportError}
    />
  );
}

function NewChatPanel({
  snapshot,
  onCreated,
}: {
  snapshot: ProjectSnapshot;
  onCreated: (id: string) => void;
}) {
  const reportError = useReportError();
  const [persona, setPersona] = useState(snapshot.personas[0]?.slug ?? "");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!persona) return;
    setCreating(true);
    try {
      const summary = await invoke<ChatSummary>("create_chat", {
        personaSlug: persona,
      });
      onCreated(summary.id);
    } catch (e) {
      reportError("create_chat", e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-surface-1 border border-surface-3 rounded p-6 space-y-3">
        <h3 className="text-sm font-semibold text-accent">New chat</h3>
        <p className="text-xs text-gray-400">
          Spin up an ad-hoc chat against this agent. Chats are persisted on
          the agent across restarts.
        </p>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Persona
          </span>
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded text-sm"
          >
            {snapshot.personas.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name} ({p.slug})
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={create}
          disabled={creating || !persona}
          className="w-full px-4 py-2 bg-accent hover:bg-accent-light text-white rounded text-sm font-medium disabled:opacity-40"
        >
          {creating ? "Creating…" : "Start chat"}
        </button>
      </div>
    </div>
  );
}

// ── Turn-grouped transcript ─────────────────────────────────────────────────

/// An item within a turn. Either an LLM-produced batch of messages or a
/// tool call (which may still be in-flight).
type TurnEvent =
  | { kind: "llm"; messages: ChatWireMessage[]; durationMs?: number }
  | {
      kind: "tool";
      toolCallId: string;
      name: string;
      args: unknown;
      result?: ChatWireMessage;
      durationMs?: number;
      startedAt: number;
    };

interface Turn {
  index: number;
  userMessage: string;
  events: TurnEvent[];
}

type Activity =
  | { kind: "llm"; startedAt: number }
  | { kind: "tool"; name: string; toolCallId: string; startedAt: number }
  | null;

function ChatTranscript({
  chatId,
  onDelete,
  reportError,
}: {
  chatId: string;
  onDelete: () => void;
  reportError: (ctx: string, e: unknown) => void;
}) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<Activity>(null);
  const [status, setStatus] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load persisted detail and group its messages into historical turns so
  // reloading a chat shows the same structure as a live conversation.
  useEffect(() => {
    invoke<ChatDetail>("get_chat", { id: chatId })
      .then((d) => {
        setDetail(d);
        setTurns(groupHistoricalMessages(d.messages));
      })
      .catch((e) => reportError("get_chat", e));
  }, [chatId, reportError]);

  // Subscribe to streaming events filtered by chat id.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ChatStreamEvent>("chat-stream", (ev) => {
      const p = ev.payload;
      if (p.chat_id !== chatId) return;
      switch (p.kind) {
        case "turn_started":
          setTurns((prev) => [
            ...prev,
            { index: p.turn_index, userMessage: p.user_message, events: [] },
          ]);
          break;
        case "llm_started":
          setActivity({ kind: "llm", startedAt: Date.now() });
          break;
        case "llm_completed":
          setActivity(null);
          if (p.messages.length > 0) {
            setTurns((prev) =>
              appendToLastTurn(prev, {
                kind: "llm",
                messages: p.messages,
                durationMs: p.duration_ms,
              }),
            );
          }
          break;
        case "tool_started":
          setActivity({
            kind: "tool",
            name: p.name,
            toolCallId: p.tool_call_id,
            startedAt: Date.now(),
          });
          setTurns((prev) =>
            appendToLastTurn(prev, {
              kind: "tool",
              toolCallId: p.tool_call_id,
              name: p.name,
              args: p.args,
              startedAt: Date.now(),
            }),
          );
          break;
        case "tool_completed":
          setActivity(null);
          setTurns((prev) => fillToolResult(prev, p.tool_call_id, p.result, p.duration_ms));
          break;
        case "done":
          setActivity(null);
          setSending(false);
          setStatus(
            p.status === "completed"
              ? ""
              : `${p.status}${p.reason ? `: ${p.reason}` : ""}`,
          );
          break;
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [chatId]);

  // Autoscroll on any state change that adds visible content.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns.length, activity]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setStatus("");
    setInput("");
    try {
      await invoke("chat_turn", { id: chatId, message: text });
    } catch (e) {
      reportError("chat_turn", e);
      setSending(false);
      setActivity(null);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this chat?")) return;
    try {
      await invoke("delete_chat", { id: chatId });
      onDelete();
    } catch (e) {
      reportError("delete_chat", e);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 py-2 bg-surface-1 border-b border-surface-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-accent">
          {detail?.persona_slug ?? chatId}
        </h2>
        <span className="text-xs text-gray-500 font-mono truncate">{chatId}</span>
        <div className="flex-1" />
        <button
          onClick={remove}
          className="px-2 py-1 text-xs bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded"
        >
          Delete
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {turns.map((turn) => (
          <TurnCard key={`${turn.index}-${turn.userMessage.slice(0, 20)}`} turn={turn} />
        ))}
        {activity && <ActivityIndicator activity={activity} />}
        {status && (
          <div className="text-xs text-amber-400 whitespace-pre-wrap break-words select-text font-mono bg-amber-400/10 border border-amber-400/30 rounded px-2 py-1.5">
            ⚠ {status}
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-surface-3 bg-surface-1">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex gap-2"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={sending}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="flex-1 px-3 py-2 bg-surface-2 border border-surface-3 rounded text-sm resize-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="px-4 py-2 bg-accent hover:bg-accent-light text-white rounded text-sm font-medium disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function TurnCard({ turn }: { turn: Turn }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 border-t border-surface-3" />
        <span className="text-[10px] uppercase tracking-wide text-gray-500 font-mono">
          Turn {turn.index + 1}
        </span>
        <div className="flex-1 border-t border-surface-3" />
      </div>
      <div className="space-y-2">
        <UserMessageCard content={turn.userMessage} />
        {turn.events.map((ev, i) =>
          ev.kind === "llm" ? (
            <LlmCard key={`llm-${i}`} messages={ev.messages} durationMs={ev.durationMs} />
          ) : (
            <ToolCard key={`tool-${ev.toolCallId}`} event={ev} />
          ),
        )}
      </div>
    </section>
  );
}

function UserMessageCard({ content }: { content: string }) {
  return (
    <div className="px-3 py-2 bg-surface-2 border-l-2 border-blue-500 rounded text-sm whitespace-pre-wrap">
      <div className="text-xs uppercase tracking-wide text-blue-400 mb-1">User</div>
      {content}
    </div>
  );
}

function LlmCard({
  messages,
  durationMs,
}: {
  messages: ChatWireMessage[];
  durationMs?: number;
}) {
  return (
    <div className="space-y-2">
      {messages.map((m, i) => {
        if (m.role === "assistant") {
          return (
            <div
              key={i}
              className="px-3 py-2 bg-surface-1 border-l-2 border-accent rounded text-sm whitespace-pre-wrap"
            >
              <div className="text-xs uppercase tracking-wide text-accent-light mb-1 flex items-center gap-2">
                <span>Assistant</span>
                {durationMs !== undefined && (
                  <span className="text-gray-500 font-mono normal-case tracking-normal">
                    {formatDuration(durationMs)}
                  </span>
                )}
              </div>
              {m.content}
            </div>
          );
        }
        // Other roles inside an LLM batch are unusual but render generically.
        return <GenericMessage key={i} message={m} />;
      })}
    </div>
  );
}

function ToolCard({
  event,
}: {
  event: Extract<TurnEvent, { kind: "tool" }>;
}) {
  const pending = event.result === undefined;
  return (
    <details
      className={`px-3 py-2 bg-surface-1 border-l-2 rounded text-xs ${
        pending
          ? "border-purple-500 animate-pulse"
          : "border-green-500"
      }`}
    >
      <summary className="cursor-pointer flex items-center gap-2">
        <span className={pending ? "text-purple-300" : "text-green-300"}>
          {pending ? "🔧" : "✓"} {event.name}
        </span>
        {pending ? (
          <LiveTimer startedAt={event.startedAt} />
        ) : (
          event.durationMs !== undefined && (
            <span className="text-gray-500 font-mono">
              {formatDuration(event.durationMs)}
            </span>
          )
        )}
      </summary>
      <div className="mt-1 space-y-1">
        <div>
          <div className="text-gray-500 mb-1">args</div>
          <pre className="font-mono text-gray-400 whitespace-pre-wrap max-h-40 overflow-auto">
            {JSON.stringify(event.args, null, 2)}
          </pre>
        </div>
        {event.result && event.result.role === "tool_result" && (
          <div>
            <div className="text-gray-500 mb-1">result</div>
            <pre className="font-mono text-gray-400 whitespace-pre-wrap max-h-60 overflow-auto">
              {event.result.result}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function GenericMessage({ message }: { message: ChatWireMessage }) {
  switch (message.role) {
    case "user":
      return <UserMessageCard content={message.content} />;
    case "assistant":
      return <LlmCard messages={[message]} />;
    case "tool_call":
      return (
        <div className="px-3 py-2 bg-surface-1 border-l-2 border-purple-500 rounded text-xs">
          🔧 {message.name}
        </div>
      );
    case "tool_result":
      return (
        <details className="px-3 py-2 bg-surface-1 border-l-2 border-green-500 rounded text-xs">
          <summary className="text-green-300">↳ {message.name} result</summary>
          <pre className="mt-1 font-mono text-gray-400 whitespace-pre-wrap max-h-60 overflow-auto">
            {message.result}
          </pre>
        </details>
      );
  }
}

function ActivityIndicator({ activity }: { activity: NonNullable<Activity> }) {
  const label =
    activity.kind === "llm" ? "🧠 Calling LLM…" : `🔧 Running ${activity.name}…`;
  return (
    <div className="px-3 py-2 bg-accent/10 border border-accent/30 rounded text-xs text-accent-light flex items-center gap-2">
      <span>{label}</span>
      <LiveTimer startedAt={activity.startedAt} />
    </div>
  );
}

/// Ticks every 100ms while mounted. Cheap enough — it only updates one small
/// piece of text. Unmounts as soon as the activity (or tool placeholder) clears.
function LiveTimer({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const i = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(i);
  }, []);
  return (
    <span className="text-gray-500 font-mono">
      {formatDuration(Date.now() - startedAt)}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(0);
  return `${m}m ${rem}s`;
}

// ── State helpers ───────────────────────────────────────────────────────────

/// Append a turn event to the most recent turn. No-op if there is no turn
/// (defensive — TurnStarted is always emitted first by the server).
function appendToLastTurn(turns: Turn[], event: TurnEvent): Turn[] {
  if (turns.length === 0) return turns;
  const last = turns[turns.length - 1];
  return [
    ...turns.slice(0, -1),
    { ...last, events: [...last.events, event] },
  ];
}

/// Find the in-flight tool placeholder by id and fill in its result + duration.
function fillToolResult(
  turns: Turn[],
  toolCallId: string,
  result: ChatWireMessage,
  durationMs: number,
): Turn[] {
  return turns.map((turn) => ({
    ...turn,
    events: turn.events.map((ev) =>
      ev.kind === "tool" && ev.toolCallId === toolCallId
        ? { ...ev, result, durationMs }
        : ev,
    ),
  }));
}

/// When loading a persisted chat we get a flat message list. Reconstruct
/// per-user-message turns by splitting on each `user` role.
function groupHistoricalMessages(messages: ChatWireMessage[]): Turn[] {
  const turns: Turn[] = [];
  let pendingLlm: ChatWireMessage[] = [];
  const flushLlm = () => {
    if (pendingLlm.length > 0 && turns.length > 0) {
      turns[turns.length - 1].events.push({ kind: "llm", messages: pendingLlm });
      pendingLlm = [];
    }
  };
  const callIdToToolEvent = new Map<string, Extract<TurnEvent, { kind: "tool" }>>();
  for (const m of messages) {
    if (m.role === "user") {
      flushLlm();
      turns.push({
        index: turns.length,
        userMessage: m.content,
        events: [],
      });
    } else if (m.role === "assistant") {
      pendingLlm.push(m);
    } else if (m.role === "tool_call") {
      flushLlm();
      if (turns.length === 0) continue;
      const ev: Extract<TurnEvent, { kind: "tool" }> = {
        kind: "tool",
        toolCallId: m.id,
        name: m.name,
        args: m.args,
        startedAt: 0,
      };
      turns[turns.length - 1].events.push(ev);
      callIdToToolEvent.set(m.id, ev);
    } else if (m.role === "tool_result") {
      const ev = callIdToToolEvent.get(m.id);
      if (ev) {
        ev.result = m;
      }
    }
  }
  flushLlm();
  return turns;
}
