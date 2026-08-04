import { useEffect, useRef, useState } from "react";
import type {
  MetalcraftLoginStart,
  MetalcraftPod,
  MetalcraftPollResult,
  RecentEntry,
} from "../types";

/// The subset of the workshop hook the Metalcraft tab drives.
export interface MetalcraftApi {
  session: () => Promise<{ email: string } | null>;
  loginStart: () => Promise<Record<string, unknown>>;
  loginPoll: (deviceCode: string) => Promise<Record<string, unknown>>;
  logout: () => Promise<void>;
  listPods: () => Promise<unknown[]>;
  openPod: (podId: string) => Promise<void>;
}

interface Props {
  recents: RecentEntry[];
  error: string | null;
  onOpenRemote: (baseUrl: string, apiKey: string) => Promise<void>;
  metalcraft: MetalcraftApi;
}

type Tab = "remote" | "metalcraft";

export default function ProjectPicker({ recents, error, onOpenRemote, metalcraft }: Props) {
  const [tab, setTab] = useState<Tab>("metalcraft");
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
          project — one of your hosted Metalcraft agents, or a remote agent's admin API.
        </p>

        <div className="flex border-b border-surface-3 mb-4">
          <TabButton active={tab === "metalcraft"} onClick={() => setTab("metalcraft")}>
            Metalcraft login
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

        {tab === "remote" ? (
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
        ) : (
          <MetalcraftPanel api={metalcraft} />
        )}

        {(() => {
          const remoteRecents = recents.filter(
            (r): r is Extract<RecentEntry, { kind: "remote" }> => r.kind === "remote",
          );
          return remoteRecents.length > 0 ? (
            <div className="mt-8">
              <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Recent</h2>
              <ul className="space-y-1">
                {remoteRecents.map((r, i) => (
                  <li key={`remote-${i}`}>
                    <button
                      onClick={() => run(() => onOpenRemote(r.base_url, r.api_key))}
                      disabled={connecting}
                      className="w-full text-left px-2 py-1 text-sm text-gray-300 hover:bg-surface-2 hover:text-accent-light rounded font-mono truncate disabled:opacity-40"
                      title={r.base_url}
                    >
                      <span className="text-xs text-accent-light mr-2">api</span>
                      {r.base_url}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}

/// The "Metalcraft login" tab: browser device-login → list your hosted agent pods
/// → click one to connect (same dashboard as a remote agent).
function MetalcraftPanel({ api }: { api: MetalcraftApi }) {
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const [pods, setPods] = useState<MetalcraftPod[]>([]);
  const [podsLoading, setPodsLoading] = useState(false);
  const [busyPod, setBusyPod] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Cancel any in-flight poll loop when the panel unmounts (e.g. on connect).
  const cancelled = useRef(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      cancelled.current = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const loadPods = async () => {
    setPodsLoading(true);
    setErr(null);
    try {
      setPods((await api.listPods()) as MetalcraftPod[]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setPodsLoading(false);
    }
  };

  // On mount, resume an existing session straight into the pod list.
  useEffect(() => {
    api
      .session()
      .then((s) => {
        if (s?.email) {
          setEmail(s.email);
          void loadPods();
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginLogin = async () => {
    setErr(null);
    setLoggingIn(true);
    try {
      const start = (await api.loginStart()) as unknown as MetalcraftLoginStart;
      setVerifyUrl(start.verify_url);
      const deviceCode = start.device_code;
      const intervalMs = Math.max(1, Number(start.interval_secs) || 2) * 1000;

      const poll = async () => {
        if (cancelled.current) return;
        try {
          const res = (await api.loginPoll(deviceCode)) as unknown as MetalcraftPollResult;
          if (res.status === "signed_in") {
            setEmail(res.email);
            setLoggingIn(false);
            setVerifyUrl(null);
            void loadPods();
            return;
          }
          if (res.status === "expired") {
            setLoggingIn(false);
            setVerifyUrl(null);
            setErr("Sign-in expired before it was approved. Please try again.");
            return;
          }
          timer.current = window.setTimeout(poll, intervalMs); // still pending
        } catch (e) {
          setLoggingIn(false);
          setVerifyUrl(null);
          setErr(String(e));
        }
      };
      timer.current = window.setTimeout(poll, intervalMs);
    } catch (e) {
      setLoggingIn(false);
      setErr(String(e));
    }
  };

  const cancelLogin = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setLoggingIn(false);
    setVerifyUrl(null);
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setEmail(null);
    setPods([]);
    setErr(null);
  };

  const connect = async (pod: MetalcraftPod) => {
    setBusyPod(pod.id);
    setErr(null);
    try {
      await api.openPod(pod.id); // on success this whole picker unmounts
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyPod(null);
    }
  };

  if (checking) {
    return <p className="text-sm text-gray-500 py-6 text-center">Checking sign-in…</p>;
  }

  const panelError = err && (
    <div className="mb-3 px-3 py-2 bg-red-900/40 border border-red-900/60 text-sm text-red-200 rounded break-words">
      {err}
    </div>
  );

  // Signed out — offer to start the browser login.
  if (!email) {
    return (
      <div className="space-y-3">
        {panelError}
        {loggingIn ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-300">
              Complete sign-in in your browser, then come back here — you'll be signed
              in automatically.
            </p>
            {verifyUrl && (
              <div className="text-xs text-gray-500">
                Didn't open?{" "}
                <a
                  href={verifyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-light break-all underline"
                >
                  {verifyUrl}
                </a>
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-400 animate-pulse">Waiting for approval…</span>
              <button
                onClick={cancelLogin}
                className="text-xs text-gray-400 hover:text-gray-200"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              onClick={beginLogin}
              className="w-full px-4 py-2 bg-accent hover:bg-accent-light text-white rounded font-medium"
            >
              Sign in to Metalcraft
            </button>
            <p className="text-xs text-gray-500">
              Opens <code className="text-accent-light">id.metalcraftai.com</code> in your
              browser to sign in, then lists your hosted agent pods here.
            </p>
          </>
        )}
      </div>
    );
  }

  // Signed in — show the pod list.
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400 truncate" title={email}>
          Signed in as <span className="text-gray-200">{email}</span>
        </span>
        <button onClick={signOut} className="text-xs text-gray-400 hover:text-gray-200">
          Sign out
        </button>
      </div>
      {panelError}
      {podsLoading ? (
        <p className="text-sm text-gray-500 py-4 text-center">Loading your pods…</p>
      ) : pods.length === 0 ? (
        <div className="text-sm text-gray-400 py-4">
          <p>No agent pods on this account yet.</p>
          <p className="text-xs text-gray-500 mt-1">
            Provision one at{" "}
            <code className="text-accent-light">pods.metalcraftai.com</code>, then reload.
          </p>
          <button
            onClick={loadPods}
            className="mt-3 px-3 py-1.5 bg-surface-2 hover:bg-surface-3 text-gray-200 rounded text-sm"
          >
            Reload
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {pods.map((pod) => {
            const active = pod.status === "active";
            const busy = busyPod === pod.id;
            return (
              <li
                key={pod.id}
                className="flex items-center gap-3 px-3 py-2 bg-surface-2 border border-surface-3 rounded"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-200 font-mono truncate" title={pod.url}>
                    {pod.slug}
                  </div>
                  <StatusBadge status={pod.status} />
                </div>
                <button
                  onClick={() => connect(pod)}
                  disabled={!active || busy}
                  className="px-3 py-1.5 bg-accent hover:bg-accent-light text-white rounded text-sm disabled:opacity-40"
                  title={active ? "Connect to this agent" : `Pod is ${pod.status}`}
                >
                  {busy ? "Connecting…" : "Connect"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-green-900/40 text-green-300"
      : status === "suspended"
        ? "bg-yellow-900/40 text-yellow-300"
        : "bg-surface-3 text-gray-400";
  return (
    <span className={`inline-block mt-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded font-mono ${cls}`}>
      {status}
    </span>
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
