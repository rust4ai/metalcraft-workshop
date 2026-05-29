import { useState } from "react";
import type { RecentEntry } from "../types";

interface Props {
  recents: RecentEntry[];
  error: string | null;
  onOpen: (path?: string) => Promise<void>;
  onOpenRemote: (baseUrl: string, apiKey: string) => Promise<void>;
}

type Tab = "local" | "remote";

export default function ProjectPicker({ recents, error, onOpen, onOpenRemote }: Props) {
  const [tab, setTab] = useState<Tab>("local");
  const [path, setPath] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3002");
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);

  // openProject/openRemote resolve on success (this component then unmounts)
  // or after catching their own error (which surfaces via the `error` prop).
  // Either way we clear the pending state so the user isn't stuck.
  const run = async (fn: () => Promise<void>) => {
    setConnecting(true);
    try {
      await fn();
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-surface-0 text-gray-200">
      <div className="w-full max-w-lg p-8 bg-surface-1 rounded-lg border border-surface-3 shadow-xl">
        <h1 className="text-2xl font-semibold text-accent mb-2">Metalcraft Workshop</h1>
        <p className="text-sm text-gray-400 mb-6">
          View and edit a <code className="text-accent-light">metalcraft-agent</code>{" "}
          project — either a local directory, or a remote agent's admin API.
        </p>

        <div className="flex border-b border-surface-3 mb-4">
          <TabButton active={tab === "local"} onClick={() => setTab("local")}>
            Local directory
          </TabButton>
          <TabButton active={tab === "remote"} onClick={() => setTab("remote")}>
            Remote agent
          </TabButton>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 bg-red-900/40 border border-red-900/60 text-sm text-red-200 rounded break-words">
            {error}
          </div>
        )}

        {tab === "local" ? (
          <>
            <button
              onClick={() => run(() => onOpen())}
              disabled={connecting}
              className="w-full px-4 py-2 mb-4 bg-accent hover:bg-accent-light text-white rounded font-medium disabled:opacity-40"
            >
              Browse for directory…
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (path.trim()) run(() => onOpen(path.trim()));
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="or paste an absolute path"
                spellCheck={false}
                className="flex-1 px-3 py-2 bg-surface-2 border border-surface-3 rounded font-mono text-sm"
              />
              <button
                type="submit"
                disabled={!path.trim() || connecting}
                className="px-3 py-2 bg-surface-2 hover:bg-surface-3 text-gray-200 rounded text-sm disabled:opacity-40"
              >
                Open
              </button>
            </form>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (baseUrl.trim() && apiKey.trim()) {
                run(() => onOpenRemote(baseUrl.trim(), apiKey.trim()));
              }
            }}
            className="space-y-3"
          >
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                Agent base URL
              </span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:3002"
                spellCheck={false}
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded font-mono text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                API key (Bearer)
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="the value passed to --api <KEY>"
                spellCheck={false}
                autoComplete="off"
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded font-mono text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={!baseUrl.trim() || !apiKey.trim() || connecting}
              className="w-full px-4 py-2 bg-accent hover:bg-accent-light text-white rounded font-medium disabled:opacity-40"
            >
              {connecting ? "Connecting…" : "Connect"}
            </button>
            <p className="text-xs text-gray-500">
              Start the agent with{" "}
              <code className="text-accent-light">metalcraft-agent --api &lt;KEY&gt;</code>{" "}
              to enable this endpoint.
            </p>
          </form>
        )}

        {recents.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Recent</h2>
            <ul className="space-y-1">
              {recents.map((r, i) => (
                <li key={`${r.kind}-${i}`}>
                  {r.kind === "local" ? (
                    <button
                      onClick={() => run(() => onOpen(r.path))}
                      disabled={connecting}
                      className="w-full text-left px-2 py-1 text-sm text-gray-300 hover:bg-surface-2 hover:text-accent-light rounded font-mono truncate disabled:opacity-40"
                      title={r.path}
                    >
                      <span className="text-xs text-gray-600 mr-2">dir</span>
                      {r.path}
                    </button>
                  ) : (
                    <button
                      onClick={() => run(() => onOpenRemote(r.base_url, r.api_key))}
                      disabled={connecting}
                      className="w-full text-left px-2 py-1 text-sm text-gray-300 hover:bg-surface-2 hover:text-accent-light rounded font-mono truncate disabled:opacity-40"
                      title={r.base_url}
                    >
                      <span className="text-xs text-accent-light mr-2">api</span>
                      {r.base_url}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-medium uppercase tracking-wide transition-colors ${
        active
          ? "text-accent border-b-2 border-accent"
          : "text-gray-500 hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}
