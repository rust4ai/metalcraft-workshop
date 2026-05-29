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
          Spin up an ad-hoc chat against this agent. Chats live for the
          lifetime of the agent process.
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
  const [messages, setMessages] = useState<ChatWireMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load chat detail (the persisted server-side messages for this chat).
  useEffect(() => {
    invoke<ChatDetail>("get_chat", { id: chatId })
      .then((d) => {
        setDetail(d);
        setMessages(d.messages);
      })
      .catch((e) => reportError("get_chat", e));
  }, [chatId, reportError]);

  // Subscribe to streaming events filtered by chat id.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ChatStreamEvent>("chat-stream", (ev) => {
      const payload = ev.payload;
      if (payload.chat_id !== chatId) return;
      if (payload.kind === "messages") {
        setMessages((prev) => [...prev, ...payload.messages]);
      } else if (payload.kind === "done") {
        setStatus(
          payload.status === "completed"
            ? ""
            : `${payload.status}${payload.reason ? `: ${payload.reason}` : ""}`,
        );
        setSending(false);
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [chatId]);

  // Autoscroll on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setStatus("");
    setInput("");
    // Optimistically render the user message; the server echoes it back as
    // the first item in the stream, so we suppress that to avoid duplicates.
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    try {
      await invoke("chat_turn", { id: chatId, message: text });
    } catch (e) {
      reportError("chat_turn", e);
      setSending(false);
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

  // The server's first echoed user message duplicates our optimistic one.
  // Collapse consecutive identical user messages.
  const rendered = dedupeConsecutiveUsers(messages);

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

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {rendered.map((m, i) => (
          <ChatMessageCard key={i} message={m} />
        ))}
        {sending && (
          <div className="text-xs text-gray-500 italic">
            Agent is thinking…
          </div>
        )}
        {status && (
          <div className="text-xs text-amber-400">⚠ {status}</div>
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

function ChatMessageCard({ message }: { message: ChatWireMessage }) {
  switch (message.role) {
    case "user":
      return (
        <div className="px-3 py-2 bg-surface-2 border-l-2 border-blue-500 rounded text-sm whitespace-pre-wrap">
          <div className="text-xs uppercase tracking-wide text-blue-400 mb-1">User</div>
          {message.content}
        </div>
      );
    case "assistant":
      return (
        <div className="px-3 py-2 bg-surface-1 border-l-2 border-accent rounded text-sm whitespace-pre-wrap">
          <div className="text-xs uppercase tracking-wide text-accent-light mb-1">Assistant</div>
          {message.content}
        </div>
      );
    case "tool_call":
      return (
        <details className="px-3 py-2 bg-surface-1 border-l-2 border-purple-500 rounded text-xs">
          <summary className="cursor-pointer text-purple-300">🔧 {message.name}</summary>
          <pre className="mt-1 font-mono text-gray-400 whitespace-pre-wrap max-h-60 overflow-auto">
            {JSON.stringify(message.args, null, 2)}
          </pre>
        </details>
      );
    case "tool_result":
      return (
        <details className="px-3 py-2 bg-surface-1 border-l-2 border-green-500 rounded text-xs">
          <summary className="cursor-pointer text-green-300">↳ {message.name} result</summary>
          <pre className="mt-1 font-mono text-gray-400 whitespace-pre-wrap max-h-60 overflow-auto">
            {message.result}
          </pre>
        </details>
      );
  }
}

function dedupeConsecutiveUsers(msgs: ChatWireMessage[]): ChatWireMessage[] {
  const out: ChatWireMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (
      m.role === "user" &&
      last &&
      last.role === "user" &&
      last.content === m.content
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}
