import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useReportError } from "../hooks/useReportError";
import type {
  AgentPackPreview,
  InstallReport,
  InstalledAgentPack,
  Lock,
  PackSource,
  ProjectSnapshot,
  RestoreLockfileResult,
  RestoreOutcome,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  /// Archive URL from a `metalcraft-workshop://install` deep link, passed straight
  /// through to the install dialog.
  deepLinkUrl?: string | null;
  onDeepLinkConsumed?: () => void;
}

/**
 * Agent packs — the install unit.
 *
 * A pack carries one agent preset plus every persona, skill and integration it
 * needs, so installing one is the moment a person grants an agent reach into their
 * accounts. The dialog below therefore *inspects first*: the pod validates the
 * archive, derives what it would reach from the archive's own tool definitions, and
 * says so — and only then offers to install. Showing a permission summary after the
 * fact would not be consent.
 *
 * What a pack brought with it is inventoried on the Integrations page; this one is
 * about the packs themselves.
 */
export default function AgentPacksView({
  snapshot,
  deepLinkUrl,
  onDeepLinkConsumed,
}: Props) {
  // Pack state lives on the agent — local mode has nothing to show.
  if (snapshot.mode !== "remote") {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center">
        <div className="max-w-md text-sm text-gray-400">
          <p className="mb-2">
            Agent packs are installed into the agent process and are only visible
            when connected to a remote agent.
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

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl space-y-3">
        <AgentPacks
          snapshot={snapshot}
          deepLinkUrl={deepLinkUrl}
          onDeepLinkConsumed={onDeepLinkConsumed}
        />
        <LockfilePanel />
      </div>
    </div>
  );
}
function LockfilePanel() {
  const reportError = useReportError();
  const [open, setOpen] = useState(false);
  const [lock, setLock] = useState<Lock | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [outcomes, setOutcomes] = useState<RestoreOutcome[] | null>(null);

  const load = () => {
    invoke<Lock>("get_lockfile")
      .then(setLock)
      .catch((e) => reportError("get_lockfile", e));
  };

  useEffect(() => {
    if (open && !lock) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const restore = async () => {
    setRestoring(true);
    setOutcomes(null);
    try {
      const res = await invoke<RestoreLockfileResult>("restore_lockfile");
      setOutcomes(res.outcomes);
      load();
    } catch (e) {
      reportError("restore_lockfile", e);
    } finally {
      setRestoring(false);
    }
  };

  const count =
    (lock?.agent_packs?.length ?? 0) +
    (lock?.packs?.length ?? 0) +
    (lock?.flows?.length ?? 0);

  return (
    <div className="mt-3 bg-surface-1 border border-surface-3 rounded p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <span className="text-sm font-medium text-gray-200">🔒 Lockfile</span>
        <span className="text-xs text-gray-500">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {!lock ? (
            <div className="text-xs text-gray-500">Loading…</div>
          ) : count === 0 ? (
            <p className="text-xs text-gray-500">Nothing pinned yet — install a pack or flow.</p>
          ) : (
            <>
              <LockGroup title="Agent packs" entries={lock.agent_packs} />
              {/* `packs` pins the integrations those agent packs vendored. */}
              <LockGroup title="Integrations" entries={lock.packs} />
              <LockGroup title="Flows" entries={lock.flows} />
              <button
                onClick={restore}
                disabled={restoring}
                className="px-3 py-1.5 text-xs bg-surface-2 hover:bg-surface-3 text-gray-200 border border-surface-3 rounded disabled:opacity-40"
              >
                {restoring ? "Restoring…" : "Restore all from lockfile"}
              </button>
            </>
          )}
          {outcomes && (
            <ul className="space-y-0.5 text-[11px]">
              {outcomes.map((o, i) => (
                <li key={i} className={o.status === "installed" ? "text-green-400" : "text-red-400"}>
                  {o.kind} {o.name}@{o.version}: {o.status}
                  {o.detail ? ` — ${o.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function LockGroup({ title, entries }: { title: string; entries: Lock["packs"] }) {
  if (!entries || entries.length === 0) return null;
  return (
    <div>
      <h4 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{title}</h4>
      <ul className="space-y-1">
        {entries.map((e) => (
          <li
            key={e.name}
            className="px-2 py-1.5 bg-surface-2 border border-surface-3 rounded font-mono text-[11px]"
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-gray-300">{e.name}</span>
              <span className="text-gray-500">v{e.version}</span>
            </div>
            <div className="truncate text-[10px] text-gray-600">
              {e.content_sha256.slice(0, 12)}… · {e.source}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentPacks({
  snapshot,
  deepLinkUrl,
  onDeepLinkConsumed,
}: {
  snapshot: ProjectSnapshot;
  deepLinkUrl?: string | null;
  onDeepLinkConsumed?: () => void;
}) {
  const reportError = useReportError();
  const [packs, setPacks] = useState<InstalledAgentPack[] | null>(null);
  const [registries, setRegistries] = useState<string[]>([]);

  const refresh = async () => {
    try {
      setPacks(await invoke<InstalledAgentPack[]>("list_agent_packs"));
    } catch (e) {
      reportError("list_agent_packs", e);
      setPacks([]);
    }
  };

  useEffect(() => {
    refresh();
    invoke<string[]>("agent_pack_registries")
      .then(setRegistries)
      .catch(() => setRegistries([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-accent">Agent packs</h2>
      <p className="text-xs text-gray-500">
        An agent, packaged: one preset, its personas and skills, and every
        integration they need. Installing one adds an agent you can start a chat
        with.
      </p>

      <InstallAgentPack
        registries={registries}
        deepLinkUrl={deepLinkUrl}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onInstalled={refresh}
      />

      {packs === null ? (
        <div className="text-xs text-gray-500">Loading…</div>
      ) : packs.length === 0 ? (
        <div className="text-sm text-gray-500 italic">
          No agent packs installed. The agents this pod ships with are built in.
        </div>
      ) : (
        <ul className="space-y-2">
          {packs.map((p) => (
            <li key={p.id} className="bg-surface-1 border border-surface-3 rounded p-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-200">{p.manifest.name}</span>
                <span className="text-xs text-gray-600 font-mono">
                  v{p.manifest.version}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1">{p.manifest.description}</p>
              <p className="text-xs text-gray-500 mt-2 font-mono">
                {(p.manifest.presets ?? []).join(", ") || "no preset"} ·{" "}
                {(p.manifest.provides?.personas ?? []).length} personas ·{" "}
                {(p.manifest.provides?.skills ?? []).length} skills
              </p>
              <UninstallAgentPack
                id={p.id}
                name={p.manifest.name}
                onDone={refresh}
              />
            </li>
          ))}
        </ul>
      )}

      <ExportAgentPack snapshot={snapshot} />
    </section>
  );
}

function InstallAgentPack({
  registries,
  onInstalled,
  deepLinkUrl,
  onDeepLinkConsumed,
}: {
  registries: string[];
  onInstalled: () => void;
  /// An archive URL from a `metalcraft-workshop://install` deep link. It seeds the
  /// field and triggers a review — never an install. Somebody clicking a link on a
  /// web page has not seen the consent summary yet, which is the entire reason the
  /// review step exists.
  deepLinkUrl?: string | null;
  onDeepLinkConsumed?: () => void;
}) {
  const reportError = useReportError();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<InstallReport | null>(null);
  /// The reviewed pack **and the exact source it was reviewed from**, together.
  ///
  /// These were two pieces of state, and a cancelled or failed review left the file
  /// path behind — so reviewing a URL afterwards showed that pack's consent summary
  /// while Install still uploaded the stale file. Consent for one archive, install of
  /// another. Holding them as one value makes that unrepresentable.
  const [reviewed, setReviewed] = useState<
    { preview: AgentPackPreview; source: PackSource } | null
  >(null);

  const inspect = async (source: PackSource) => {
    setBusy(true);
    setReport(null);
    setReviewed(null);
    try {
      const preview = await invoke<AgentPackPreview>("inspect_agent_pack", { source });
      setReviewed({ preview, source });
    } catch (e) {
      reportError("inspect_agent_pack", e);
    } finally {
      setBusy(false);
    }
  };

  // A deep link arrives asynchronously and possibly before this view is mounted,
  // so react to it rather than reading it once.
  useEffect(() => {
    if (!deepLinkUrl) return;
    setUrl(deepLinkUrl);
    void inspect({ kind: "url", url: deepLinkUrl });
    onDeepLinkConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkUrl]);

  /// Pick an `.agentpack` from this machine. The Rust side reads it and uploads the
  /// bytes — the pod may be elsewhere and cannot open a path we hand it.
  const pickFile = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Agent pack", extensions: ["agentpack", "zip"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    await inspect({ kind: "local_file", path: picked });
  };

  const install = async () => {
    if (!reviewed) return;
    setBusy(true);
    try {
      // The source carried by the review, so what lands is what was approved.
      setReport(
        await invoke<InstallReport>("install_agent_pack", { source: reviewed.source }),
      );
      setReviewed(null);
      setUrl("");
      onInstalled();
    } catch (e) {
      reportError("install_agent_pack", e);
    } finally {
      setBusy(false);
    }
  };

  if (report) {
    return (
      <div className="bg-surface-1 border border-green-700/50 rounded p-4 space-y-2">
        <div className="text-sm text-green-300">
          Installed {report.id} v{report.version}
        </div>
        <div className="text-xs text-gray-400">
          {(report.presets ?? []).length} agent · {(report.personas ?? []).length}{" "}
          personas · {(report.skills ?? []).length} skills ·{" "}
          {report.memories_indexed} memories
        </div>
        {(report.missing_env ?? []).length > 0 && (
          <div className="text-xs text-amber-400">
            Still needs: {report.missing_env.join(", ")} — set them in Keys, or its
            tools will fail when the agent reaches for them.
          </div>
        )}
        <button
          onClick={() => setReport(null)}
          className="text-xs text-gray-500 hover:text-gray-300 underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (reviewed) {
    return (
      <ConsentDialog
        preview={reviewed.preview}
        busy={busy}
        onInstall={install}
        onCancel={() => setReviewed(null)}
      />
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && url.trim() && inspect({ kind: "url", url: url.trim() })
          }
          placeholder="Paste an agent pack URL…"
          className="flex-1 min-w-0 px-3 py-2 bg-surface-2 border border-surface-3 rounded text-sm"
        />
        <button
          onClick={() => url.trim() && inspect({ kind: "url", url: url.trim() })}
          disabled={busy || !url.trim()}
          className="px-3 py-2 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded disabled:opacity-40"
        >
          {busy ? "…" : "Review"}
        </button>
        <button
          onClick={pickFile}
          disabled={busy}
          className="px-3 py-2 text-xs text-gray-400 hover:text-gray-200 border border-surface-3 rounded disabled:opacity-40"
        >
          From file…
        </button>
      </div>
      {registries.length > 0 && (
        <p className="text-[10px] text-gray-600">
          This pod downloads from: {registries.join(", ")}
        </p>
      )}
    </div>
  );
}

/// What installing would grant, before it is granted.
///
/// Everything here is derived by the pod from the archive's own bytes — the domains
/// come from the tools' URLs, the credentials from what those tools reference. An
/// author cannot write a friendlier summary of their own pack.
function ConsentDialog({
  preview,
  busy,
  onInstall,
  onCancel,
}: {
  preview: AgentPackPreview;
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const c = preview.consent;
  const mutating = (c.mutating_tools ?? []).length;
  const total = (c.tools ?? []).length;
  // No tools listed at all is "we could not derive this", not "it is harmless". Every
  // consent field defaults to empty on the wire, so an older pod — or a derivation
  // that failed — would otherwise render as an affirmative safety claim.
  const unknown = total === 0;

  return (
    <div className="bg-surface-1 border border-accent/40 rounded p-4 space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-100">
            {preview.manifest.name}
          </span>
          <span className="text-xs text-gray-600 font-mono">
            v{preview.manifest.version}
          </span>
          {preview.installed_version && (
            <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-surface-3 text-gray-400 rounded">
              replaces v{preview.installed_version}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-1">{preview.manifest.description}</p>
      </div>

      <p className={`text-xs ${unknown ? "text-amber-400" : "text-gray-300"}`}>
        {unknown
          ? "This pack declares no tools, so there is nothing to summarise — check the source you got it from."
          : mutating === 0
            ? `This agent only reads. None of its ${total} tools can change anything.`
            : `This agent can change things: ${mutating} of its ${total} tools write.`}
      </p>

      {(c.domains ?? []).length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Reaches</div>
          <div className="flex flex-wrap gap-1 mt-1">
            {c.domains.map((d) => (
              <span
                key={d}
                className="px-1.5 py-0.5 text-xs bg-surface-2 text-gray-300 rounded font-mono"
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      )}

      {(c.requires_env ?? []).length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">
            Wants these credentials
          </div>
          <ul className="mt-1 space-y-0.5">
            {c.requires_env.map((e) => (
              <li key={e.name} className="text-xs">
                <code className="text-gray-300">{e.name}</code>
                <span className="text-gray-500">
                  {" "}
                  — for {(e.needed_by ?? []).join(", ")}
                  {(preview.missing_env ?? []).includes(e.name) ? " (not set)" : " (set)"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(preview.preset_collisions ?? []).length > 0 && (
        <p className="px-2 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-300">
          An agent named {preview.preset_collisions.join(", ")} already exists on this
          pod. Installing this would make both unusable — the loader refuses to guess
          between two agents with the same name.
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onInstall}
          disabled={busy || (preview.preset_collisions ?? []).length > 0}
          className="px-4 py-2 text-sm bg-accent hover:bg-accent-light text-white rounded disabled:opacity-40"
        >
          {busy ? "Installing…" : "Install"}
        </button>
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300">
          Cancel
        </button>
        <span
          className="ml-auto text-[10px] text-gray-600 font-mono"
          title={`content hash: ${preview.content_sha256}`}
        >
          {preview.content_sha256.slice(0, 12)}…
        </span>
      </div>
    </div>
  );
}

function UninstallAgentPack({
  id,
  name,
  onDone,
}: {
  id: string;
  name: string;
  onDone: () => void;
}) {
  const reportError = useReportError();
  const [confirming, setConfirming] = useState(false);
  const [inUse, setInUse] = useState<string | null>(null);

  const run = async (force: boolean) => {
    try {
      await invoke("uninstall_agent_pack", { id, force });
      setConfirming(false);
      setInUse(null);
      onDone();
    } catch (e) {
      const msg = String(e);
      // The pod refuses while a saved agent still uses it, and says which. That is
      // a question to put to the user, not an error to swallow.
      if (msg.includes("in use by")) setInUse(msg);
      else reportError("uninstall_agent_pack", e);
    }
  };

  if (inUse) {
    return (
      <div className="mt-3 px-3 py-2 bg-surface-2 border border-amber-500/40 rounded space-y-2">
        <p className="text-xs text-amber-300">{inUse}</p>
        <div className="flex gap-2">
          <button
            onClick={() => run(true)}
            className="px-3 py-1 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded"
          >
            Uninstall anyway
          </button>
          <button
            onClick={() => setInUse(null)}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            Keep it
          </button>
        </div>
      </div>
    );
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="mt-3 text-xs text-red-400/70 hover:text-red-400 underline"
      >
        Uninstall
      </button>
    );
  }

  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="text-xs text-gray-300">Uninstall “{name}”?</span>
      <button
        onClick={() => run(false)}
        className="px-3 py-1 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded"
      >
        Uninstall
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="text-xs text-gray-500 hover:text-gray-300"
      >
        Cancel
      </button>
    </div>
  );
}

/// Package one of this pod's own agents as a distributable `.agentpack`.
function ExportAgentPack({ snapshot }: { snapshot: ProjectSnapshot }) {
  const reportError = useReportError();
  const [preset, setPreset] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const presets = snapshot.agent_presets ?? [];
  if (presets.length === 0) return null;

  const run = async () => {
    const slug = preset || presets[0].slug;
    const path = await saveDialog({
      defaultPath: `${slug}-${version}.agentpack`,
      filters: [{ name: "Agent pack", extensions: ["agentpack"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const bytes = await invoke<number>("export_agent_pack", {
        preset: slug,
        version,
        outPath: path,
      });
      setDone(`${path} (${bytes} bytes)`);
    } catch (e) {
      reportError("export_agent_pack", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-4 space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-gray-500">
        Export one of this pod's agents
      </h3>
      <div className="flex gap-2">
        <select
          value={preset || presets[0].slug}
          onChange={(e) => setPreset(e.target.value)}
          className="px-2 py-1.5 bg-surface-2 border border-surface-3 rounded text-xs"
        >
          {presets.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          className="w-24 px-2 py-1.5 bg-surface-2 border border-surface-3 rounded text-xs font-mono"
        />
        <button
          onClick={run}
          disabled={busy}
          className="px-3 py-1.5 text-xs bg-accent/20 hover:bg-accent/30 text-accent-light rounded disabled:opacity-40"
        >
          {busy ? "…" : "Export"}
        </button>
      </div>
      {done && <p className="text-xs text-gray-500 font-mono truncate">Wrote {done}</p>}
    </div>
  );
}
