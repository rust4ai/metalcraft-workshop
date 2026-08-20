import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type {
  IntegrationDetail,
  IntegrationSummary,
  ProjectSnapshot,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/**
 * Integrations — the HTTP-API tools behind a service.
 *
 * Not an install unit: an agent pack vendors the integrations its agent needs, so
 * this page is a read-only inventory of what those packs brought with them. It
 * lists tools and flow templates and nothing else — the personas and skills on the
 * same wire record belong to the pack that carries them, and showing them here was
 * what made an integration look like something you install in its own right.
 */
export default function IntegrationsView({ snapshot, selectedId, onSelect }: Props) {
  const reportError = useReportError();
  const [integrations, setIntegrations] = useState<IntegrationSummary[] | null>(null);
  const remote = snapshot.mode === "remote";

  // Every hook runs before the local-mode branch below, so changing modes cannot
  // change how many of them React sees.
  useEffect(() => {
    if (!remote) return;
    invoke<IntegrationSummary[]>("list_integrations")
      .then(setIntegrations)
      .catch((e) => reportError("list_integrations", e));
  }, [remote, reportError]);

  // Integration state lives on the agent — local mode has nothing to show.
  if (!remote) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md text-sm text-gray-400">
          <p className="mb-2">
            Integrations are managed by the agent process and are only visible when
            connected to a remote agent.
          </p>
          <p className="text-xs text-gray-500">
            Start the agent with{" "}
            <code className="text-accent-light">
              metalcraft-daemon --api &lt;KEY&gt;
            </code>{" "}
            and connect via the Remote tab.
          </p>
        </div>
      </div>
    );
  }

  if (!integrations) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  if (selectedId) {
    return (
      <IntegrationDetailPanel id={selectedId} onBack={() => onSelect(null)} />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-3">
        <h2 className="text-sm font-semibold text-accent">Integrations</h2>
        <p className="text-xs text-gray-500">
          The HTTP-API tools behind each service. These are not installed on their
          own — an agent pack vendors the ones its agent needs, so this is a
          read-only view of what those packs brought with them.
        </p>
        {integrations.length === 0 ? (
          <div className="text-sm text-gray-500 italic">
            No integrations installed. They arrive with the agent packs that need
            them.
          </div>
        ) : (
          <ul className="space-y-2">
            {integrations.map((it) => (
              <li
                key={it.id}
                className="bg-surface-1 border border-surface-3 rounded p-4"
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onSelect(it.id)}
                    className="text-sm font-medium text-gray-200 hover:text-accent-light text-left"
                  >
                    {it.name}
                  </button>
                  <span className="text-xs text-gray-600 font-mono">
                    v{it.version}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1">{it.description}</p>
                <p className="text-xs text-gray-500 mt-2 font-mono">
                  {it.api_tools} tools · {it.flow_templates} templates
                </p>
                {(it.requires_env?.length ?? 0) > 0 && (
                  <p className="text-[10px] text-amber-400 mt-1">
                    Requires env: {it.requires_env?.join(", ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IntegrationDetailPanel({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const reportError = useReportError();
  const [detail, setDetail] = useState<IntegrationDetail | null>(null);

  useEffect(() => {
    // Clear first: a slow or failed load would otherwise leave the previously
    // selected integration on screen under this one's header.
    setDetail(null);
    invoke<IntegrationDetail>("get_integration", { id })
      .then(setDetail)
      .catch((e) => reportError("get_integration", e));
  }, [id, reportError]);

  if (!detail) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-4">
        <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-300">
          ← back to integrations
        </button>
        <header>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-accent">{detail.name}</h2>
            <span className="text-xs text-gray-600 font-mono">v{detail.version}</span>
            {detail.enabled && (
              <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-green-900/40 text-green-300 rounded">
                Enabled
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-1">{detail.description}</p>
          <p className="text-xs text-gray-500 mt-1 font-mono">id: {detail.id}</p>
          {(detail.requires_env?.length ?? 0) > 0 && (
            <p className="text-xs text-amber-400 mt-1">
              Requires env: {detail.requires_env?.join(", ")}
            </p>
          )}
        </header>

        <p className="text-xs text-gray-500">
          Vendored by an installed agent pack. To remove these tools, uninstall the
          pack that carries them.
        </p>

        <Section title="API tools" items={detail.api_tools} />
        <Section title="Flow templates" items={detail.flow_templates} />
      </div>
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-1">{title}</h3>
      <ul className="grid grid-cols-2 gap-1">
        {items.map((it) => (
          <li
            key={it}
            className="px-2 py-1 text-xs bg-surface-2 border border-surface-3 rounded font-mono text-gray-300"
          >
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
