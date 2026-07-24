import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useReportError } from "../hooks/useReportError";
import type {
  ChatDetail,
  ChatStreamEvent,
  ChatSummary,
  ChatWireMessage,
  ProjectSnapshot,
  ScheduledTask,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /// Fired when the chat catalog changes (create/delete) or a turn finishes,
  /// so the parent can refresh the live chat + session lists.
  onChatsChanged?: () => void;
}

export default function ChatsView({ snapshot, selectedId, onSelect, onChatsChanged }: Props) {
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
    return (
      <NewChatPanel
        snapshot={snapshot}
        onCreated={(id) => {
          onChatsChanged?.();
          onSelect(id);
        }}
      />
    );
  }

  return (
    <ChatTranscript
      key={selectedId}
      chatId={selectedId}
      onDelete={() => {
        onChatsChanged?.();
        onSelect(null);
      }}
      onTurnSettled={() => onChatsChanged?.()}
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
  // Default to the Orchestrator when it's installed (it delegates to the right
  // specialist for anything), falling back to the first persona otherwise.
  const defaultSlug =
    snapshot.personas.find((p) => p.slug === "orchestrator-agent")?.slug ??
    snapshot.personas[0]?.slug ??
    "";
  const [persona, setPersona] = useState(defaultSlug);
  // The persona picker is hidden until the user opts into a custom persona.
  const [customPersona, setCustomPersona] = useState(false);
  const [creating, setCreating] = useState(false);

  const selected = snapshot.personas.find((p) => p.slug === persona);

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

        {customPersona ? (
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
        ) : (
          <div className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-2 border border-surface-3 rounded">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wide text-gray-500">
                Persona
              </div>
              <div className="text-sm text-gray-200 truncate">
                {selected?.name ?? persona ?? "—"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCustomPersona(true)}
              className="shrink-0 text-xs text-accent-light/80 hover:text-accent-light underline"
            >
              Use custom persona
            </button>
          </div>
        )}

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
  | { kind: "reply"; content: string }
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
  onTurnSettled,
  reportError,
}: {
  chatId: string;
  onDelete: () => void;
  onTurnSettled: () => void;
  reportError: (ctx: string, e: unknown, sessionId?: string | null) => void;
}) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<Activity>(null);
  const [status, setStatus] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback in a ref so the stream subscription (keyed only
  // on chatId) can call it without re-subscribing when its identity changes.
  const onTurnSettledRef = useRef(onTurnSettled);
  onTurnSettledRef.current = onTurnSettled;
  // Diagnostics session the in-flight turn logs to, captured from the
  // `turn_started` event so a turn failure can deep-link to its session logs.
  const turnSessionIdRef = useRef<string | null>(null);

  // Fetch the agent's persisted copy of the chat and render the transcript
  // from it. This is the single source of truth: the same grouping is used
  // for the initial load AND for reconciling after every turn settles, so a
  // live stream that drops or garbles mid-turn self-heals to the saved state.
  // The number of messages in the agent's last-loaded persisted copy. The
  // daemon only persists a turn once, at the very end, so this count stays at
  // the pre-turn baseline for the whole turn and then jumps. We use that jump
  // to detect when an interrupted turn has actually settled server-side.
  const persistedCountRef = useRef(0);
  const loadDetail = useCallback(
    () =>
      invoke<ChatDetail>("get_chat", { id: chatId })
        .then((d) => {
          persistedCountRef.current = d.messages.length;
          setDetail(d);
          setTurns(groupHistoricalMessages(d.messages));
        })
        .catch((e) => reportError("get_chat", e)),
    [chatId, reportError],
  );
  // Hold the latest loader in a ref so the stream subscription (keyed only on
  // chatId) can reconcile without re-subscribing when the loader identity
  // changes — same pattern as onTurnSettledRef.
  const loadDetailRef = useRef(loadDetail);
  loadDetailRef.current = loadDetail;

  // Persisted message count captured when the in-flight turn started, i.e. the
  // pre-turn baseline. A settled turn pushes the persisted count above this.
  const turnBaselineCountRef = useRef(0);
  // Cancellation token for an in-flight settle poll. Replaced on each new turn
  // and on unmount/chat switch so a stale poll can't reconcile the wrong chat.
  const settlePollRef = useRef<{ cancelled: boolean } | null>(null);

  // After a turn ends WITHOUT a clean `completed` terminal (the live SSE feed
  // dropped mid-turn), the daemon may still be running and hasn't persisted the
  // final transcript yet. Reloading immediately would wipe the optimistic
  // in-flight turn and show stale pre-turn state with no recovery. Instead,
  // poll the persisted copy until its message count grows past the pre-turn
  // baseline (the daemon persists the whole turn in one write at the end,
  // success or fail), then reconcile once. Until then we keep the live overlay
  // on screen. Bounded so a turn that genuinely never persists can't poll
  // forever — the sub_agent tool caps at 120s, so ~150s of polling covers it.
  const reconcileWhenSettled = useCallback(() => {
    // Cancel any prior poll before starting a fresh one.
    if (settlePollRef.current) settlePollRef.current.cancelled = true;
    const token = { cancelled: false };
    settlePollRef.current = token;
    const baseline = turnBaselineCountRef.current;
    const MAX_ATTEMPTS = 75;
    const INTERVAL_MS = 2000;
    let attempts = 0;
    const poll = () => {
      if (token.cancelled) return;
      invoke<ChatDetail>("get_chat", { id: chatId })
        .then((d) => {
          if (token.cancelled) return;
          const settled = d.messages.length > baseline;
          if (settled || attempts >= MAX_ATTEMPTS) {
            // Daemon finished (or we gave up): reconcile to the persisted copy.
            persistedCountRef.current = d.messages.length;
            setDetail(d);
            setTurns(groupHistoricalMessages(d.messages));
            // Clear the "interrupted" banner only on a genuine recovery; if we
            // gave up without the turn persisting, keep it so the user knows.
            if (settled) setStatus("");
            onTurnSettledRef.current();
            settlePollRef.current = null;
            return;
          }
          attempts += 1;
          window.setTimeout(poll, INTERVAL_MS);
        })
        .catch((e) => {
          if (token.cancelled) return;
          reportError("get_chat", e);
          settlePollRef.current = null;
        });
    };
    poll();
  }, [chatId, reportError]);
  const reconcileWhenSettledRef = useRef(reconcileWhenSettled);
  reconcileWhenSettledRef.current = reconcileWhenSettled;

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // Subscribe to streaming events filtered by chat id.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ChatStreamEvent>("chat-stream", (ev) => {
      const p = ev.payload;
      if (p.chat_id !== chatId) return;
      switch (p.kind) {
        case "turn_started":
          turnSessionIdRef.current = p.session_id ?? null;
          // A new turn supersedes any settle poll still running for the prior
          // one, and its pre-turn persisted count becomes the settle baseline.
          if (settlePollRef.current) settlePollRef.current.cancelled = true;
          turnBaselineCountRef.current = persistedCountRef.current;
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
        case "reply":
          // The agent's user-facing reply (from a say_to_user tool call). In
          // tool-only mode this — not llm_completed — carries the message.
          setActivity(null);
          setTurns((prev) =>
            appendToLastTurn(prev, { kind: "reply", content: p.content }),
          );
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
          if (p.status === "completed") {
            // Clean terminal: the agent has persisted the chat. Reconcile the
            // transcript against that persisted copy (the stream is only a
            // best-effort live overlay) and refresh the sidebar lists.
            loadDetailRef.current();
            onTurnSettledRef.current();
            // A turn may have just armed a new follow-up, or a fired one just
            // completed — refresh the chips either way.
            refreshFollowupsRef.current();
          } else {
            // The live feed dropped (or the turn failed) — the daemon may still
            // be running and hasn't persisted the final transcript yet.
            // Reconciling now would wipe the in-flight turn to stale state, so
            // poll until the persisted copy settles, then reconcile once.
            reconcileWhenSettledRef.current();
          }
          break;
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
      // Cancel a settle poll bound to the chat we're leaving so it can't
      // reconcile after the component re-keys to a different chat.
      if (settlePollRef.current) settlePollRef.current.cancelled = true;
    };
  }, [chatId]);

  // Subscribe to this chat's agent-initiated turns (scheduled follow-ups). They
  // arrive on the same `chat-stream` bus as user turns, so the listener above
  // renders them; we just have to open/close the subscription with the chat.
  useEffect(() => {
    invoke("subscribe_chat_events", { id: chatId }).catch((e) =>
      reportError("subscribe_chat_events", e),
    );
    return () => {
      invoke("stop_chat_events").catch(() => {});
    };
  }, [chatId, reportError]);

  // Pending follow-ups scheduled for this chat, shown as dismissible chips.
  const [followups, setFollowups] = useState<ScheduledTask[]>([]);
  const refreshFollowups = useCallback(() => {
    invoke<ScheduledTask[]>("list_scheduled_tasks")
      .then((all) =>
        setFollowups(
          all.filter((t) => t.chat_id === chatId && t.status === "pending"),
        ),
      )
      .catch(() => setFollowups([]));
  }, [chatId]);
  const refreshFollowupsRef = useRef(refreshFollowups);
  refreshFollowupsRef.current = refreshFollowups;
  useEffect(() => {
    refreshFollowups();
  }, [refreshFollowups]);

  const cancelFollowup = useCallback(
    (id: string) => {
      invoke("cancel_scheduled_task", { id })
        .then(refreshFollowups)
        .catch((e) => reportError("cancel_scheduled_task", e));
    },
    [refreshFollowups, reportError],
  );

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
      reportError("chat_turn", e, turnSessionIdRef.current);
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

      {followups.length > 0 && (
        <div className="px-4 pt-2 flex flex-wrap gap-1.5">
          {followups.map((f) => (
            <span
              key={f.id}
              className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 text-[11px] bg-accent/15 text-accent-light rounded"
              title={`Runs ${new Date(f.run_at).toLocaleString()} — ${f.task}`}
            >
              <span className="shrink-0">⏰ follow-up {relativeTime(f.run_at)}</span>
              <span className="truncate opacity-80">{f.task}</span>
              <button
                onClick={() => cancelFollowup(f.id)}
                className="shrink-0 text-accent-light/70 hover:text-accent-light leading-none"
                title="Cancel follow-up"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

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

/// Compact "in ~5m" / "in ~2h" label for a future run time; "now" once due.
function relativeTime(iso: string): string {
  const secs = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (secs <= 0) return "now";
  if (secs < 90) return `in ${secs}s`;
  if (secs < 90 * 60) return `in ~${Math.round(secs / 60)}m`;
  return `in ~${Math.round(secs / 3600)}h`;
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
          ) : ev.kind === "reply" ? (
            <ReplyCard key={`reply-${i}`} content={ev.content} />
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

/// The agent's user-facing reply (a `say_to_user` call). Rendered like an
/// assistant message bubble — in tool-only mode this is the assistant's message.
function ReplyCard({ content }: { content: string }) {
  return (
    <div className="px-3 py-2 bg-surface-1 border-l-2 border-accent rounded text-sm whitespace-pre-wrap">
      <div className="text-xs uppercase tracking-wide text-accent-light mb-1">
        Assistant
      </div>
      {content}
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
      // say_to_user is the user-facing reply, not an internal tool. Render its
      // message (carried in args.message) as an assistant bubble.
      if (message.name === "say_to_user") {
        const text =
          (message.args as { message?: string } | null)?.message ?? "";
        return <ReplyCard content={text} />;
      }
      return (
        <div className="px-3 py-2 bg-surface-1 border-l-2 border-purple-500 rounded text-xs">
          🔧 {message.name}
        </div>
      );
    case "tool_result":
      // The say_to_user result is just a delivery ack; the text was already
      // shown by its tool_call above, so hide it.
      if (message.name === "say_to_user") {
        return null;
      }
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
      // say_to_user is the user-facing reply, not an internal tool. Render it as
      // a reply bubble (mirroring the live `reply` event), not a tool card — and
      // don't register it for tool_result wiring, so its delivery-ack result is
      // dropped. Without this, reconciling a persisted chat turns the reply back
      // into a `✓ say_to_user` card and the answer text disappears.
      if (m.name === "say_to_user") {
        const content = (m.args as { message?: string } | null)?.message ?? "";
        turns[turns.length - 1].events.push({ kind: "reply", content });
        continue;
      }
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
