import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReportError } from "../hooks/useReportError";
import type { PackDetail, PackSummary, ProjectSnapshot } from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function PacksView({ snapshot, selectedId, onSelect }: Props) {
  const reportError = useReportError();
  const [packs, setPacks] = useState<PackSummary[] | null>(null);

  // Pack state lives on the agent — local mode has nothing to show.
  if (snapshot.mode !== "remote") {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md text-sm text-gray-400">
          <p className="mb-2">
            Integration packs are managed by the agent process and are only
            visible when connected to a remote agent.
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

  const refresh = async () => {
    try {
      const list = await invoke<PackSummary[]>("list_integration_packs");
      setPacks(list);
    } catch (e) {
      reportError("list_integration_packs", e);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!packs) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  if (selectedId) {
    const summary = packs.find((p) => p.id === selectedId);
    return (
      <PackDetailPanel
        packId={selectedId}
        summaryEnabled={summary?.enabled ?? false}
        onToggled={refresh}
        onBack={() => onSelect(null)}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-3">
        <h2 className="text-sm font-semibold text-accent">Integration packs</h2>
        <p className="text-xs text-gray-500">
          Each pack bundles personas, skills, HTTP-API tools, and flow
          templates around a single integration. Enabling a pack makes its
          contents visible to the agent runtime and editor.
        </p>
        {packs.length === 0 ? (
          <div className="text-sm text-gray-500 italic">No packs installed.</div>
        ) : (
          <ul className="space-y-2">
            {packs.map((p) => (
              <li
                key={p.id}
                className="bg-surface-1 border border-surface-3 rounded p-4 flex items-start gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onSelect(p.id)}
                      className="text-sm font-medium text-gray-200 hover:text-accent-light text-left"
                    >
                      {p.name}
                    </button>
                    <span className="text-xs text-gray-600 font-mono">
                      v{p.version}
                    </span>
                    {p.enabled && (
                      <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-green-900/40 text-green-300 rounded">
                        Enabled
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{p.description}</p>
                  <p className="text-xs text-gray-500 mt-2 font-mono">
                    {p.personas} personas · {p.skills} skills · {p.api_tools} tools
                    · {p.flow_templates} templates
                  </p>
                  {(p.requires_env?.length ?? 0) > 0 && (
                    <p className="text-[10px] text-amber-400 mt-1">
                      Requires env: {p.requires_env?.join(", ")}
                    </p>
                  )}
                </div>
                <PackToggle
                  packId={p.id}
                  enabled={p.enabled}
                  onChanged={refresh}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PackToggle({
  packId,
  enabled,
  onChanged,
}: {
  packId: string;
  enabled: boolean;
  onChanged: () => void;
}) {
  const reportError = useReportError();
  const [pending, setPending] = useState(false);
  const toggle = async () => {
    setPending(true);
    try {
      await invoke("set_pack_enabled", { id: packId, enabled: !enabled });
      onChanged();
    } catch (e) {
      reportError("set_pack_enabled", e);
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`px-3 py-1.5 text-xs rounded font-medium disabled:opacity-40 ${
        enabled
          ? "bg-red-900/40 hover:bg-red-900/60 text-red-200"
          : "bg-accent hover:bg-accent-light text-white"
      }`}
    >
      {pending ? "…" : enabled ? "Disable" : "Enable"}
    </button>
  );
}

function PackDetailPanel({
  packId,
  summaryEnabled,
  onToggled,
  onBack,
}: {
  packId: string;
  summaryEnabled: boolean;
  onToggled: () => void;
  onBack: () => void;
}) {
  const reportError = useReportError();
  const [detail, setDetail] = useState<PackDetail | null>(null);

  useEffect(() => {
    invoke<PackDetail>("get_integration_pack", { id: packId })
      .then(setDetail)
      .catch((e) => reportError("get_integration_pack", e));
  }, [packId, reportError]);

  if (!detail) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-4">
        <button
          onClick={onBack}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          ← back to packs
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

        <div>
          <PackToggle
            packId={detail.id}
            enabled={summaryEnabled}
            onChanged={onToggled}
          />
        </div>

        <Section title="Personas" items={detail.personas} />
        <Section title="Skills" items={detail.skills} />
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
