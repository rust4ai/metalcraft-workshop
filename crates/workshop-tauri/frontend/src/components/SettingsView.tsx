import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type { ProjectSnapshot, SettingsInfo } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
}

/// Settings / About panel. Shows this app's version plus the connected agent's
/// version, so you can confirm which agent build is live after a deploy.
export default function SettingsView({ snapshot }: Props) {
  const reportError = useReportError();
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await invoke<SettingsInfo>("settings_info"));
    } catch (e) {
      reportError("settings_info", e);
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    load();
  }, [load]);

  const isRemote = snapshot.mode === "remote";

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-accent">Settings</h2>
          <button
            onClick={load}
            disabled={loading}
            className="px-2 py-1 text-xs bg-surface-2 hover:bg-surface-3 text-gray-300 rounded disabled:opacity-40"
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>

        {/* Connected agent ------------------------------------------------- */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Connected agent
          </h3>
          <dl className="rounded border border-surface-3 bg-surface-1 divide-y divide-surface-3">
            <Row label="Connection">
              <span className="inline-flex items-center gap-2">
                <span
                  className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded font-mono ${
                    isRemote
                      ? "bg-accent/20 text-accent-light"
                      : "bg-surface-2 text-gray-400"
                  }`}
                >
                  {isRemote ? "Remote API" : "Local directory"}
                </span>
              </span>
            </Row>
            <Row label={isRemote ? "Agent URL" : "Project directory"}>
              <span className="font-mono text-xs break-all text-gray-300">
                {snapshot.root}
              </span>
            </Row>
            <Row label="Agent version">
              <AgentVersion isRemote={isRemote} info={info} loading={loading} />
            </Row>
          </dl>
          {isRemote && (
            <p className="text-xs text-gray-500">
              Compare this against the version you deployed to confirm an update
              actually landed. Also available over HTTP at{" "}
              <code className="font-mono text-gray-400">{`${trimSlash(snapshot.root)}/health`}</code>.
            </p>
          )}
        </section>

        {/* This app ------------------------------------------------------- */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Workshop app
          </h3>
          <dl className="rounded border border-surface-3 bg-surface-1 divide-y divide-surface-3">
            <Row label="Version">
              <span className="font-mono text-sm text-gray-200">
                {info ? `v${info.workshop_version}` : "…"}
              </span>
            </Row>
          </dl>
        </section>
      </div>
    </div>
  );
}

function AgentVersion({
  isRemote,
  info,
  loading,
}: {
  isRemote: boolean;
  info: SettingsInfo | null;
  loading: boolean;
}) {
  if (!isRemote) {
    return (
      <span className="text-xs text-gray-500">
        N/A — local directory (no running agent)
      </span>
    );
  }
  if (loading && !info) {
    return <span className="text-xs text-gray-500">…</span>;
  }
  if (!info || !info.agent_reachable) {
    return (
      <span className="text-xs text-red-300">Unreachable — could not query the agent</span>
    );
  }
  if (!info.agent_version) {
    return (
      <span className="text-xs text-amber-300">
        Unknown — this agent predates version reporting (update it)
      </span>
    );
  }
  return (
    <span className="font-mono text-sm text-gray-200">v{info.agent_version}</span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 px-3 py-2.5">
      <dt className="w-36 shrink-0 text-xs text-gray-500">{label}</dt>
      <dd className="flex-1 min-w-0">{children}</dd>
    </div>
  );
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
