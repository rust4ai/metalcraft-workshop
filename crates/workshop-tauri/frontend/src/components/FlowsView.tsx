import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useReportError } from "../hooks/useReportError";
import V2Node from "./flow/V2Node";
import type {
  ProjectSnapshot,
  SavedFlow,
  FlowNode,
  FlowEdge,
  FlowTemplate,
  FlowTemplateSummary,
  RunFlowResult,
  FlowRun,
  DiagnosticsSessionSummary,
  Requires,
  InstallFlowDependenciesResult,
} from "../types";

// Every node type renders through one data-driven component (it picks the right
// handles per type). Defined at module scope so React Flow doesn't re-register
// the types each render.
const NODE_KIND_COMPONENTS: NodeTypes = Object.fromEntries(
  [
    "entry",
    "prompt",
    "conditional",
    "branch",
    "set_variable",
    "tool",
    "http",
    "sub_agent",
    "approval",
    "wait",
    "end",
    "branch_tool",
  ].map((t) => [t, V2Node]),
);

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /// Navigate to the Sessions page with `sessionId` selected.
  onGoToSession: (sessionId: string) => void;
}

// Types offered by the "+ Add node" palette (entry is auto-created, at most one).
const ADDABLE_NODE_TYPES = [
  "prompt",
  "conditional",
  "branch",
  "tool",
  "http",
  "sub_agent",
  "set_variable",
  "approval",
  "wait",
  "end",
] as const;
// Full set for the node-type dropdown (includes entry).
const ALL_NODE_TYPES = ["entry", ...ADDABLE_NODE_TYPES] as const;

type SidebarTab = "node" | "run" | "sessions";

// One declared entry input (the flow's parameters).
interface FlowInputSpec {
  type?: string;
  required?: boolean;
  default?: unknown;
}
type FlowInputs = Record<string, FlowInputSpec>;

/** Optional persona/model overrides for a force-run (defaults resolved by the agent). */
type RunOptions = { persona_slug?: string; model_name?: string };

// Read the entry node's declared inputs, if any.
function entryInputsOf(flow: SavedFlow | null): FlowInputs {
  const entry = flow?.flow.nodes.find((n) => n.node_type === "entry");
  const inputs = (entry?.data as Record<string, unknown> | undefined)?.inputs;
  return inputs && typeof inputs === "object" ? (inputs as FlowInputs) : {};
}

export default function FlowsView({ selectedId, onSelect, onGoToSession }: Props) {
  const [flow, setFlow] = useState<SavedFlow | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<FlowTemplateSummary[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunFlowResult | null>(null);
  const [pauseRun, setPauseRun] = useState<FlowRun | null>(null);
  const [sessions, setSessions] = useState<DiagnosticsSessionSummary[]>([]);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("node");
  const reportError = useReportError();
  const isNew = selectedId === "__new__";

  // Diagnostics sessions produced by running THIS flow (kind == "flow",
  // flow_id == selectedId), newest first.
  const refreshFlowSessions = useCallback(async () => {
    if (!selectedId || selectedId === "__new__") {
      setSessions([]);
      return;
    }
    try {
      const all = await invoke<DiagnosticsSessionSummary[]>("list_diagnostics_sessions");
      setSessions(
        all
          .filter((s) => s.flow_id === selectedId)
          .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? "")),
      );
    } catch (e) {
      console.error("list_diagnostics_sessions", e);
      setSessions([]);
    }
  }, [selectedId]);

  // After a run/resume, if the v2 run is paused, fetch its pause details so we
  // can offer resume options; otherwise clear them.
  const processRunResult = useCallback(
    async (result: RunFlowResult) => {
      setRunResult(result);
      if (result.run_id && result.status === "paused") {
        try {
          setPauseRun(await invoke<FlowRun>("get_flow_run", { runId: result.run_id }));
        } catch (e) {
          reportError("get_flow_run", e);
          setPauseRun(null);
        }
      } else {
        setPauseRun(null);
      }
      // A run just wrote a new flow-tagged session; reflect it in the list.
      refreshFlowSessions();
    },
    [reportError, refreshFlowSessions],
  );

  const resumeRun = useCallback(
    async (runId: string, handle: string) => {
      setRunning(true);
      try {
        await processRunResult(await invoke<RunFlowResult>("resume_flow_run", { runId, handle }));
      } catch (e) {
        reportError("resume_flow_run", e);
      } finally {
        setRunning(false);
      }
    },
    [processRunResult, reportError],
  );

  const runFlow = useCallback(
    async (inputs: Record<string, unknown>, opts?: RunOptions) => {
      setRunning(true);
      setRunResult(null);
      setPauseRun(null);
      try {
        await processRunResult(
          await invoke<RunFlowResult>("run_flow", {
            id: selectedId,
            inputs,
            personaSlug: opts?.persona_slug || null,
            modelName: opts?.model_name || null,
          }),
        );
      } catch (e) {
        reportError("run_flow", e);
      } finally {
        setRunning(false);
      }
    },
    [selectedId, processRunResult, reportError],
  );

  useEffect(() => {
    setSavedAt(null);
    setValidationErrors([]);
    setSelectedNodeId(null);
    setRunResult(null);
    setPauseRun(null);
    refreshFlowSessions();
    if (!selectedId) {
      setFlow(null);
      return;
    }
    if (isNew) {
      // Show the picker (blank vs template) instead of loading immediately.
      setFlow(null);
      setShowPicker(true);
      invoke<FlowTemplateSummary[]>("list_flow_templates")
        .then(setTemplates)
        .catch((e) => reportError("list_flow_templates", e));
      return;
    }
    setShowPicker(false);
    invoke<SavedFlow>("get_flow", { id: selectedId })
      .then(setFlow)
      .catch((e) => reportError("get_flow", e));
  }, [selectedId, isNew, reportError, refreshFlowSessions]);

  // The picker is its own screen — short-circuit before checking `flow`.
  if (isNew && showPicker) {
    return (
      <FlowTemplatePicker
        templates={templates}
        onPick={async (slug) => {
          if (!slug) {
            setFlow(blankFlow());
            setShowPicker(false);
            return;
          }
          try {
            const tpl = await invoke<FlowTemplate>("get_flow_template", { slug });
            // Reset id/name/timestamps so it saves as a new flow.
            const now = new Date().toISOString();
            setFlow({
              ...tpl.flow,
              id: `flow-${Math.random().toString(36).slice(2, 8)}`,
              name: `${tpl.name} (copy)`,
              created_at: now,
              updated_at: now,
              enabled: false,
            });
            setShowPicker(false);
          } catch (e) {
            reportError("get_flow_template", e);
          }
        }}
        onCancel={() => onSelect(null)}
      />
    );
  }

  if (!selectedId) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Select a flow from the sidebar, or create a new one.
      </div>
    );
  }
  if (!flow) {
    return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  }

  const save = async () => {
    const updated: SavedFlow = {
      ...flow,
      updated_at: new Date().toISOString(),
    };
    try {
      const errors = await invoke<string[]>("save_flow", { flow: updated });
      setValidationErrors(errors);
      if (errors.length === 0) {
        setSavedAt(Date.now());
        setFlow(updated);
        if (isNew) onSelect(updated.id);
      }
    } catch (e) {
      setValidationErrors([String(e)]);
    }
  };

  const remove = async () => {
    if (isNew || !confirm(`Delete flow "${selectedId}"?`)) return;
    try {
      await invoke("delete_flow", { id: selectedId });
      onSelect(null);
    } catch (e) {
      reportError("delete_flow", e);
    }
  };

  const updateFlow = (patch: Partial<SavedFlow>) => setFlow({ ...flow, ...patch });
  const updateGraph = (nodes: FlowNode[], edges: FlowEdge[]) =>
    setFlow({ ...flow, flow: { nodes, edges } });

  const selectedNode = flow.flow.nodes.find((n) => n.id === selectedNodeId) || null;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 bg-surface-1 border-b border-surface-3">
        <input
          type="text"
          value={flow.id}
          onChange={(e) => updateFlow({ id: e.target.value })}
          disabled={!isNew}
          placeholder="flow-id"
          className="px-2 py-1 bg-surface-2 border border-surface-3 rounded font-mono text-xs w-48 disabled:opacity-60"
        />
        <input
          type="text"
          value={flow.name}
          onChange={(e) => updateFlow({ name: e.target.value })}
          placeholder="Flow name"
          className="px-2 py-1 bg-surface-2 border border-surface-3 rounded text-sm flex-1"
        />
        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          <input
            type="checkbox"
            checked={flow.enabled}
            onChange={(e) => updateFlow({ enabled: e.target.checked })}
          />
          enabled
        </label>
        <button
          onClick={save}
          className="px-3 py-1 bg-accent hover:bg-accent-light text-white text-xs rounded"
        >
          Save
        </button>
        {!isNew && (
          <button
            onClick={remove}
            className="px-3 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-200 text-xs rounded"
          >
            Delete
          </button>
        )}
        {savedAt && <span className="text-xs text-green-400">Saved.</span>}
      </div>

      {flow.requires && (
        <RequiresBanner
          flowId={flow.id}
          requires={flow.requires}
          onInstalled={() => {
            if (selectedId)
              invoke<SavedFlow>("get_flow", { id: selectedId })
                .then(setFlow)
                .catch((e) => reportError("get_flow", e));
          }}
        />
      )}

      {runResult && (
        <RunResultPanel
          result={runResult}
          pauseRun={pauseRun}
          running={running}
          onResume={resumeRun}
          onViewSession={sessions[0] ? () => onGoToSession(sessions[0].id) : undefined}
        />
      )}

      {validationErrors.length > 0 && (
        <ul className="px-4 py-2 bg-red-900/30 border-b border-red-900/50 text-xs text-red-200 space-y-0.5">
          {validationErrors.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}

      {/* Graph + inspector — wrap both in ReactFlowProvider so the inspector
          can also use useReactFlow() to place new nodes at the viewport
          center. */}
      <ReactFlowProvider>
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 min-h-0">
            <FlowCanvas
              flowId={flow.id}
              nodes={flow.flow.nodes}
              edges={flow.flow.edges}
              onChange={updateGraph}
              onSelectNode={setSelectedNodeId}
            />
          </div>
          <NodeInspectorWithRf
            existingNodes={flow.flow.nodes}
            sessions={sessions}
            onGoToSession={onGoToSession}
            tab={sidebarTab}
            setTab={setSidebarTab}
            entryInputs={entryInputsOf(flow)}
            onRun={runFlow}
            running={running}
            node={selectedNode}
            onChange={(updated) => {
              const next = flow.flow.nodes.map((n) =>
                n.id === updated.id ? updated : n,
              );
              updateGraph(next, flow.flow.edges);
            }}
            onDelete={(nid) => {
              updateGraph(
                flow.flow.nodes.filter((n) => n.id !== nid),
                flow.flow.edges.filter((e) => e.source !== nid && e.target !== nid),
              );
              setSelectedNodeId(null);
            }}
            onAddNode={(node) => {
              updateGraph([...flow.flow.nodes, node], flow.flow.edges);
              setSelectedNodeId(node.id);
            }}
          />
        </div>
      </ReactFlowProvider>
    </div>
  );
}

/// Thin wrapper that adds viewport-aware node placement on top of
/// [`NodeInspector`]. Lives inside `ReactFlowProvider` so it can call
/// `useReactFlow().screenToFlowPosition()`.
function NodeInspectorWithRf({
  existingNodes,
  sessions,
  onGoToSession,
  tab,
  setTab,
  entryInputs,
  onRun,
  running,
  node,
  onChange,
  onDelete,
  onAddNode,
}: {
  existingNodes: FlowNode[];
  sessions: DiagnosticsSessionSummary[];
  onGoToSession: (sessionId: string) => void;
  tab: SidebarTab;
  setTab: (t: SidebarTab) => void;
  entryInputs: FlowInputs;
  onRun: (inputs: Record<string, unknown>, opts?: RunOptions) => void;
  running: boolean;
  node: FlowNode | null;
  onChange: (n: FlowNode) => void;
  onDelete: (id: string) => void;
  onAddNode: (n: FlowNode) => void;
}) {
  const rf = useReactFlow();
  return (
    <NodeInspector
      node={node}
      sessions={sessions}
      onGoToSession={onGoToSession}
      tab={tab}
      setTab={setTab}
      entryInputs={entryInputs}
      onRun={onRun}
      running={running}
      onChange={onChange}
      onDelete={onDelete}
      onAddNode={(kind) => {
        const id = makeId(kind);
        // Drop the new node near the center of whatever the user is
        // currently looking at, with a small per-add offset so multiple
        // adds don't stack on top of each other.
        const center = rf.screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
        const offset = (existingNodes.length % 8) * 30;
        const node: FlowNode = {
          id,
          node_type: kind,
          data: defaultDataFor(kind),
          position: [center.x + offset, center.y + offset],
        };
        onAddNode(node);
      }}
    />
  );
}

// ---- React Flow <-> wire-format conversions ----

function toRfNode(n: FlowNode): Node {
  return {
    id: n.id,
    // Match the node_type to a registered component in NODE_KIND_COMPONENTS.
    // Unknown kinds fall through to RF's `default` which renders a basic box.
    type: n.node_type in NODE_KIND_COMPONENTS ? n.node_type : "default",
    position: { x: n.position[0], y: n.position[1] },
    data: n.data,
  };
}

function toRfEdge(e: FlowEdge): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    // Our single-handle nodes name their port "default" — fall back to that
    // when the edge JSON doesn't specify a handle (the common case for
    // entry → prompt edges in seed flows).
    sourceHandle: e.source_handle ?? "default",
    targetHandle: e.target_handle ?? "default",
  };
}

function FlowCanvas({
  flowId,
  nodes,
  edges,
  onChange,
  onSelectNode,
}: {
  flowId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  onChange: (n: FlowNode[], e: FlowEdge[]) => void;
  onSelectNode: (id: string | null) => void;
}) {
  const rf = useReactFlow();

  // The canvas owns its React Flow node/edge state rather than deriving it
  // fresh from props each render. This keeps node object identity stable so
  // React Flow can retain each node's measured handle bounds — edges are only
  // drawn once their source/target handles have been measured, so rebuilding
  // the node array every render (the old approach) left edges with no
  // endpoints and they never appeared.
  const [rfNodes, setRfNodes] = useState<Node[]>(() => nodes.map(toRfNode));
  const [rfEdges, setRfEdges] = useState<Edge[]>(() => edges.map(toRfEdge));

  // Keep refs in sync so change handlers can read the latest arrays without
  // being torn down/recreated on every edit.
  const rfNodesRef = useRef(rfNodes);
  const rfEdgesRef = useRef(rfEdges);
  rfNodesRef.current = rfNodes;
  rfEdgesRef.current = rfEdges;

  // Remember each node's original wire `node_type` so unknown/vendor kinds
  // (which render as "default") round-trip correctly on save.
  const nodeTypeById = useRef(new Map<string, string>());
  nodeTypeById.current = new Map(nodes.map((n) => [n.id, n.node_type]));

  const serialize = useCallback(
    (ns: Node[], es: Edge[]) => {
      const fnodes: FlowNode[] = ns.map((u) => ({
        id: u.id,
        node_type: nodeTypeById.current.get(u.id) ?? (u.type as string) ?? "prompt",
        data: u.data as Record<string, unknown>,
        position: [u.position.x, u.position.y],
      }));
      const fedges: FlowEdge[] = es.map((u) => ({
        id: u.id,
        source: u.source,
        target: u.target,
        source_handle: u.sourceHandle ?? undefined,
        target_handle: u.targetHandle ?? undefined,
      }));
      onChange(fnodes, fedges);
    },
    [onChange],
  );

  // Re-seed internal state when the user switches to a different flow. Keyed
  // on flowId only: edits made through the inspector are merged in by the
  // reconcile effect below without resetting positions/measurements.
  useEffect(() => {
    setRfNodes(nodes.map(toRfNode));
    setRfEdges(edges.map(toRfEdge));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId]);

  // Merge inspector-driven changes (node data edits, adds, deletes) from props
  // into internal state. Existing nodes keep their RF identity + measured
  // bounds and live position; only `data`/`type` are refreshed when they
  // actually change, so dragging a node doesn't trigger churn here.
  useEffect(() => {
    setRfNodes((cur) => {
      const byId = new Map(cur.map((n) => [n.id, n]));
      let changed = cur.length !== nodes.length;
      const next = nodes.map((n) => {
        const existing = byId.get(n.id);
        if (!existing) {
          changed = true;
          return toRfNode(n);
        }
        const type = n.node_type in NODE_KIND_COMPONENTS ? n.node_type : "default";
        if (existing.data === n.data && existing.type === type) return existing;
        changed = true;
        return { ...existing, type, data: n.data };
      });
      return changed ? next : cur;
    });
  }, [nodes]);

  useEffect(() => {
    setRfEdges((cur) => {
      const byId = new Map(cur.map((e) => [e.id, e]));
      let changed = cur.length !== edges.length;
      const next = edges.map((e) => {
        const existing = byId.get(e.id);
        const mapped = toRfEdge(e);
        if (
          existing &&
          existing.source === mapped.source &&
          existing.target === mapped.target &&
          existing.sourceHandle === mapped.sourceHandle &&
          existing.targetHandle === mapped.targetHandle
        ) {
          return existing;
        }
        changed = true;
        return mapped;
      });
      return changed ? next : cur;
    });
  }, [edges]);

  // React Flow's `fitView` prop only fires on initial mount. When the user
  // switches to a different flow the canvas keeps its old viewport, leaving
  // newly-loaded nodes parked off-screen. Re-fit explicitly when the flow
  // changes; the rAF gives RF a tick to measure the new nodes.
  useEffect(() => {
    if (nodes.length === 0) return;
    const tick = requestAnimationFrame(() => {
      rf.fitView({ padding: 0.2, duration: 200 });
    });
    return () => cancelAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, rf]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const next = applyNodeChanges(changes, rfNodesRef.current);
      setRfNodes(next);
      serialize(next, rfEdgesRef.current);
    },
    [serialize],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, rfEdgesRef.current);
      setRfEdges(next);
      serialize(rfNodesRef.current, next);
    },
    [serialize],
  );

  const onConnect = useCallback<OnConnect>(
    (conn: Connection) => {
      const next = addEdge(conn, rfEdgesRef.current);
      setRfEdges(next);
      serialize(rfNodesRef.current, next);
    },
    [serialize],
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_KIND_COMPONENTS}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => onSelectNode(n.id)}
        onPaneClick={() => onSelectNode(null)}
        fitView
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ animated: true, style: { stroke: "#818cf8" } }}
      >
        <Background gap={20} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function NodeInspector({
  node,
  sessions,
  onGoToSession,
  tab,
  setTab,
  entryInputs,
  onRun,
  running,
  onChange,
  onDelete,
  onAddNode,
}: {
  node: FlowNode | null;
  sessions: DiagnosticsSessionSummary[];
  onGoToSession: (sessionId: string) => void;
  tab: SidebarTab;
  setTab: (t: SidebarTab) => void;
  entryInputs: FlowInputs;
  onRun: (inputs: Record<string, unknown>, opts?: RunOptions) => void;
  running: boolean;
  onChange: (n: FlowNode) => void;
  onDelete: (id: string) => void;
  onAddNode: (kind: string) => void;
}) {
  // Selecting a node on the canvas jumps to the editing tab.
  useEffect(() => {
    if (node) setTab("node");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  const pill = (active: boolean) =>
    `flex-1 px-2 py-1 text-xs rounded-md transition-colors ${
      active ? "bg-surface-3 text-gray-100" : "text-gray-400 hover:text-gray-200"
    }`;

  return (
    <aside className="w-80 bg-surface-1 border-l border-surface-3 flex flex-col">
      <div className="shrink-0 p-2 border-b border-surface-3">
        <div className="flex gap-1 bg-surface-2 rounded-lg p-0.5">
          <button className={pill(tab === "node")} onClick={() => setTab("node")}>
            Edit
          </button>
          <button className={pill(tab === "run")} onClick={() => setTab("run")}>
            Run
          </button>
          <button className={pill(tab === "sessions")} onClick={() => setTab("sessions")}>
            Sessions{sessions.length ? ` · ${sessions.length}` : ""}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === "node" ? (
          <>
            <div className="mb-4">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Add node</p>
              <div className="flex flex-wrap gap-1.5">
                {ADDABLE_NODE_TYPES.map((k) => (
                  <button
                    key={k}
                    onClick={() => onAddNode(k)}
                    className="px-2 py-1 text-xs bg-surface-2 hover:bg-surface-3 text-gray-300 rounded"
                  >
                    + {k}
                  </button>
                ))}
              </div>
            </div>

            {!node ? (
              <p className="text-xs text-gray-500">
                Click a node to edit its config. Drag to move; connect by dragging from node edges.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Editing <span className="font-mono text-accent">{node.id}</span>
                </p>

                <label className="block">
                  <span className="block text-xs text-gray-500 mb-1">Node type</span>
                  <select
                    value={node.node_type}
                    onChange={(e) => onChange({ ...node, node_type: e.target.value })}
                    className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-sm"
                  >
                    {ALL_NODE_TYPES.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </label>

                <NodeFields node={node} onChange={onChange} />

                <details className="text-xs">
                  <summary className="cursor-pointer text-gray-500">Raw data JSON</summary>
                  <textarea
                    value={JSON.stringify(node.data, null, 2)}
                    onChange={(e) => {
                      try {
                        onChange({ ...node, data: JSON.parse(e.target.value) });
                      } catch {
                        // ignore parse errors while typing
                      }
                    }}
                    rows={6}
                    className="w-full mt-1 p-2 bg-surface-2 border border-surface-3 rounded font-mono text-xs"
                  />
                </details>

                <button
                  onClick={() => onDelete(node.id)}
                  className="w-full px-3 py-1.5 text-xs bg-red-900/40 hover:bg-red-900/60 text-red-200 rounded"
                >
                  Delete node
                </button>
              </div>
            )}
          </>
        ) : tab === "run" ? (
          <RunTab entryInputs={entryInputs} onRun={onRun} running={running} />
        ) : (
          <RecentSessions sessions={sessions} onGoToSession={onGoToSession} />
        )}
      </div>
    </aside>
  );
}

// Coerce a form value to the JSON type its input declares.
function coerceInput(spec: FlowInputSpec, raw: unknown): unknown {
  if (spec.type === "integer" || spec.type === "number") {
    if (raw === "" || raw === undefined || raw === null) return undefined;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (spec.type === "boolean") return raw === true;
  return raw;
}

// Re-coerce an existing default when an input's declared type changes, so the
// stored default always matches the type (no stale "24"-as-string).
function coerceDefaultForType(v: unknown, type: string): unknown {
  if (v === undefined || v === null || v === "") return undefined;
  if (type === "integer" || type === "number") {
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === "boolean") return v === true || v === "true";
  return String(v);
}

// One control that renders per declared type and emits the correct JSON type.
// Shared by the entry-inputs editor (a default value) and the Run form (a value
// for a run). Booleans use a checkbox; integers a number input (→ number);
// everything else text. Empty → undefined so "required" checks and default
// fallback work.
function TypedValueInput({
  type,
  value,
  onChange,
  placeholder,
  className,
}: {
  type?: string;
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder?: string;
  className?: string;
}) {
  if (type === "boolean") {
    return (
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
    );
  }
  const cls =
    className ?? "w-full px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs font-mono";
  const text = value === undefined || value === null ? "" : String(value);
  if (type === "integer" || type === "number") {
    return (
      <input
        type="number"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(undefined);
          const n = Number(raw);
          onChange(Number.isNaN(n) ? raw : n);
        }}
        className={cls}
      />
    );
  }
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      className={cls}
    />
  );
}

/** A banner over the editor showing a flow's declared `requires` (packs + tools),
 *  with a one-click "Install dependencies" that installs the missing packs. */
function RequiresBanner({
  flowId,
  requires,
  onInstalled,
}: {
  flowId: string;
  requires: Requires;
  onInstalled: () => void;
}) {
  const reportError = useReportError();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const packs = requires.packs ?? [];
  const tools = requires.tools ?? [];
  if (packs.length === 0 && tools.length === 0) return null;

  const install = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await invoke<InstallFlowDependenciesResult>("install_flow_dependencies", {
        id: flowId,
      });
      setOutcome(
        res.packs.length
          ? res.packs.map((p) => `${p.pack}: ${p.status}`).join(" · ")
          : "No packs to install.",
      );
      onInstalled();
    } catch (e) {
      reportError("install_flow_dependencies", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-2 bg-surface-2/60 border-b border-surface-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-gray-500">Requires</span>
        <div className="flex-1 flex flex-wrap gap-1.5">
          {packs.map((p) => (
            <span
              key={p.id}
              className="px-1.5 py-0.5 rounded bg-surface-3 text-gray-300 font-mono"
              title={p.reason ?? undefined}
            >
              {p.id}
              {p.version ? `@${p.version}` : ""}
              {p.optional ? " (opt)" : ""}
            </span>
          ))}
        </div>
        {packs.length > 0 && (
          <button
            onClick={install}
            disabled={busy}
            className="px-2 py-1 bg-accent hover:bg-accent-light text-white rounded disabled:opacity-40"
          >
            {busy ? "Installing…" : "Install dependencies"}
          </button>
        )}
      </div>
      {tools.length > 0 && (
        <p className="mt-1 text-gray-500 font-mono">tools: {tools.join(", ")}</p>
      )}
      {outcome && <p className="mt-1 text-green-400">{outcome}</p>}
    </div>
  );
}

function RunTab({
  entryInputs,
  onRun,
  running,
}: {
  entryInputs: FlowInputs;
  onRun: (inputs: Record<string, unknown>, opts?: RunOptions) => void;
  running: boolean;
}) {
  const names = Object.keys(entryInputs);
  // Seed the form from declared defaults; re-seed when the flow's inputs change.
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const seed: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(entryInputs)) {
      if (spec.default !== undefined) seed[name] = spec.default;
      else if (spec.type === "boolean") seed[name] = false;
    }
    return seed;
  });
  const key = JSON.stringify(names);
  useEffect(() => {
    setValues((cur) => {
      const next: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(entryInputs)) {
        next[name] = cur[name] ?? spec.default ?? (spec.type === "boolean" ? false : undefined);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Optional persona/model overrides — blank means "let the agent decide"
  // (defaults to the coding-agent persona and the configured default model).
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState("");

  const missingRequired = names.filter((n) => {
    if (!entryInputs[n].required) return false;
    const v = values[n];
    return v === undefined || v === null || v === "";
  });
  const canRun = !running && missingRequired.length === 0;

  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(entryInputs)) {
      const v = coerceInput(spec, values[name]);
      if (v !== undefined) out[name] = v;
    }
    onRun(out, {
      persona_slug: persona.trim() || undefined,
      model_name: model.trim() || undefined,
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Persona</span>
          <input
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="coding-agent"
            className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-xs font-mono"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="default"
            className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-xs font-mono"
          />
        </label>
      </div>
      {names.length === 0 ? (
        <p className="text-xs text-gray-500">This flow takes no inputs.</p>
      ) : (
        <>
          <p className="text-xs text-gray-500">Provide inputs, then run.</p>
          {names.map((name) => {
            const spec = entryInputs[name];
            const v = values[name];
            const set = (val: unknown) => setValues((cur) => ({ ...cur, [name]: val }));
            const isMissing = missingRequired.includes(name);
            return (
              <label key={name} className="block">
                <span className="block text-xs text-gray-400 mb-1">
                  {name}{" "}
                  {spec.required && <span className="text-red-400">required</span>}{" "}
                  <span className="text-gray-600 font-mono">{spec.type ?? "string"}</span>
                </span>
                <TypedValueInput
                  type={spec.type}
                  value={v}
                  onChange={set}
                  className={`w-full px-2 py-1 bg-surface-2 border rounded text-sm font-mono ${
                    isMissing ? "border-red-800" : "border-surface-3"
                  }`}
                />
              </label>
            );
          })}
        </>
      )}

      <button
        onClick={submit}
        disabled={!canRun}
        className="w-full px-3 py-1.5 text-xs bg-green-700 hover:bg-green-600 text-white rounded disabled:opacity-40"
      >
        {running ? "Running…" : "Run"}
      </button>
      {missingRequired.length > 0 && (
        <p className="text-xs text-red-400">
          Fill required input{missingRequired.length > 1 ? "s" : ""}: {missingRequired.join(", ")}
        </p>
      )}
      <p className="text-[11px] text-gray-600">Run results appear above; the run is logged under Session Runs.</p>
    </div>
  );
}

function RecentSessions({
  sessions,
  onGoToSession,
}: {
  sessions: DiagnosticsSessionSummary[];
  onGoToSession: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        No runs yet. Runs of this flow appear here — click one to open its session logs.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {sessions.map((s) => (
        <li key={s.id}>
          <button
            onClick={() => onGoToSession(s.id)}
            className="w-full text-left px-2 py-1.5 rounded bg-surface-2 hover:bg-surface-3 group"
            title="Open in Sessions ↗"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-200 truncate">
                {s.persona_name ?? s.persona_slug ?? "flow run"}
              </span>
              <span className="text-[10px] text-gray-500 opacity-0 group-hover:opacity-100">↗</span>
            </div>
            <div className="text-[10px] text-gray-500 font-mono truncate">
              {s.timestamp}
              {s.turn_count ? ` · ${s.turn_count} turns` : ""}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EntryFields({ node, onChange }: { node: FlowNode; onChange: (n: FlowNode) => void }) {
  const d = node.data as Record<string, unknown>;
  const scheduleType = (d.schedule_type as string) ?? "manual";
  return (
    <>
      <label className="block">
        <span className="block text-xs text-gray-500 mb-1">Schedule type</span>
        <select
          value={scheduleType}
          onChange={(e) => onChange({ ...node, data: { ...d, schedule_type: e.target.value } })}
          className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-sm"
        >
          {["manual", "minutes", "hours", "cron"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      {(scheduleType === "minutes" || scheduleType === "hours") && (
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Interval</span>
          <input
            type="number"
            value={(d.interval as number) ?? 30}
            onChange={(e) =>
              onChange({ ...node, data: { ...d, interval: Number(e.target.value) } })
            }
            className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-sm"
          />
        </label>
      )}
      {scheduleType === "cron" && (
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">Cron expression</span>
          <input
            type="text"
            value={(d.cron as string) ?? ""}
            onChange={(e) => onChange({ ...node, data: { ...d, cron: e.target.value } })}
            className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded font-mono text-sm"
            placeholder="0 */5 * * * *"
          />
        </label>
      )}
      <EntryInputsEditor
        inputs={(d.inputs as FlowInputs) ?? {}}
        onChange={(next) =>
          onChange({
            ...node,
            data: { ...d, inputs: Object.keys(next).length ? next : undefined },
          })
        }
      />
    </>
  );
}

// Editor for the entry node's declared `inputs` (the flow's parameters). Rows
// are keyed by index so renaming a key doesn't steal input focus.
function EntryInputsEditor({
  inputs,
  onChange,
}: {
  inputs: FlowInputs;
  onChange: (next: FlowInputs) => void;
}) {
  const entries = Object.entries(inputs);
  const rebuild = (rows: [string, FlowInputSpec][]) => {
    const next: FlowInputs = {};
    for (const [k, v] of rows) if (k) next[k] = v;
    onChange(next);
  };
  const setRow = (i: number, name: string, spec: FlowInputSpec) => {
    const rows = entries.slice();
    rows[i] = [name, spec];
    rebuild(rows);
  };
  const add = () => {
    let name = "input";
    let n = 1;
    while (inputs[name]) name = `input${n++}`;
    rebuild([...entries, [name, { type: "string" }]]);
  };
  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">Inputs</span>
        <span className="text-[11px] text-gray-600">the flow's parameters</span>
      </div>
      {entries.map(([name, spec], i) => (
        <div key={i} className="p-2 bg-surface-2 rounded space-y-1">
          <div className="flex gap-1 items-center">
            <input
              value={name}
              onChange={(e) => setRow(i, e.target.value, spec)}
              placeholder="name"
              className="flex-1 px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs font-mono"
            />
            <button
              className="text-xs text-red-300 px-1"
              onClick={() => rebuild(entries.filter((_, j) => j !== i))}
              aria-label="remove input"
            >
              ✕
            </button>
          </div>
          <div className="flex gap-1 items-center">
            <select
              value={spec.type ?? "string"}
              onChange={(e) =>
                setRow(i, name, {
                  ...spec,
                  type: e.target.value,
                  default: coerceDefaultForType(spec.default, e.target.value),
                })
              }
              className="px-1 py-1 bg-surface-1 border border-surface-3 rounded text-xs"
            >
              {["string", "integer", "boolean"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
              <input
                type="checkbox"
                checked={!!spec.required}
                onChange={(e) => setRow(i, name, { ...spec, required: e.target.checked })}
              />
              required
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 w-12 shrink-0">default</span>
            <TypedValueInput
              type={spec.type}
              value={spec.default}
              onChange={(val) => setRow(i, name, { ...spec, default: val })}
              placeholder="optional"
              className="flex-1 px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs font-mono"
            />
          </div>
        </div>
      ))}
      <button className="text-xs text-accent" onClick={add}>
        + input
      </button>
    </div>
  );
}

// ---- shared field inputs ----

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  rows?: number;
}) {
  const cls = `w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-sm ${mono ? "font-mono" : ""}`;
  return (
    <label className="block">
      <span className="block text-xs text-gray-500 mb-1">{label}</span>
      {rows ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className={cls} placeholder={placeholder} />
      ) : (
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={cls} placeholder={placeholder} />
      )}
    </label>
  );
}

/** Dispatch a node to the field editor for its type. Any node also has the
 *  "Raw data JSON" editor below as a universal fallback. */
function NodeFields({ node, onChange }: { node: FlowNode; onChange: (n: FlowNode) => void }) {
  const d = node.data as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => onChange({ ...node, data: { ...d, ...patch } });
  const str = (k: string) => (d[k] as string) ?? "";

  switch (node.node_type) {
    case "entry":
      return <EntryFields node={node} onChange={onChange} />;
    case "prompt":
      return (
        <>
          <Field label="Prompt" value={str("prompt")} onChange={(v) => set({ prompt: v })} rows={5} />
          <Field label="Persona (optional)" value={str("persona")} onChange={(v) => set({ persona: v })} placeholder="e.g. github-agent" />
          <Field label="Store answer in variable (optional)" value={str("output_var")} onChange={(v) => set({ output_var: v })} placeholder="e.g. summary" />
        </>
      );
    case "conditional":
      return <ConditionalFields d={d} set={set} />;
    case "branch":
      return <BranchFields d={d} set={set} />;
    case "set_variable":
      return (
        <>
          <Field label="Variable" value={str("variable")} onChange={(v) => set({ variable: v })} />
          <Field label="Value (literal or {{template}})" value={str("value")} onChange={(v) => set({ value: v })} placeholder="{{_last}}" />
          <Field label="…or copy from _last path" value={str("from")} onChange={(v) => set({ from: v })} placeholder="e.g. data.id" mono />
        </>
      );
    case "tool":
      return (
        <>
          <Field label="Tool name" value={str("tool_name")} onChange={(v) => set({ tool_name: v })} mono />
          <Field label="Args (JSON)" value={jsonStr(d.args)} onChange={(v) => setJson(set, "args", v)} rows={4} mono />
          <Field label="Store result in variable (optional)" value={str("output_var")} onChange={(v) => set({ output_var: v })} />
        </>
      );
    case "http":
      return (
        <>
          <Field label="Method" value={str("method") || "GET"} onChange={(v) => set({ method: v })} mono />
          <Field label="URL" value={str("url")} onChange={(v) => set({ url: v })} mono placeholder="https://…" />
          <Field label="Store response in variable (optional)" value={str("output_var")} onChange={(v) => set({ output_var: v })} />
        </>
      );
    case "sub_agent":
      return (
        <>
          <Field label="Task" value={str("task")} onChange={(v) => set({ task: v })} rows={4} />
          <Field label="Persona (optional)" value={str("persona")} onChange={(v) => set({ persona: v })} />
          <Field label="Store result in variable (optional)" value={str("output_var")} onChange={(v) => set({ output_var: v })} />
        </>
      );
    case "approval":
      return (
        <>
          <Field label="Message" value={str("message")} onChange={(v) => set({ message: v })} rows={3} />
          <Field
            label="Choices (comma-separated)"
            value={((d.choices as string[]) ?? ["approve", "reject"]).join(", ")}
            onChange={(v) => set({ choices: v.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
        </>
      );
    case "wait":
      return (
        <>
          <Field label="Duration (e.g. 30m, 2h, 1d)" value={str("duration")} onChange={(v) => set({ duration: v })} />
          <Field label="…or until (RFC-3339)" value={str("until")} onChange={(v) => set({ until: v })} mono placeholder="2026-08-01T09:00:00Z" />
        </>
      );
    case "end":
      return <Field label="Status (optional)" value={str("status")} onChange={(v) => set({ status: v })} placeholder="completed" />;
    default:
      return null;
  }
}

function ConditionalFields({ d, set }: { d: Record<string, unknown>; set: (p: Record<string, unknown>) => void }) {
  const conds = (d.conditions as Record<string, unknown>[]) ?? [];
  const update = (i: number, patch: Record<string, unknown>) => {
    const next = conds.map((c, j) => (j === i ? { ...c, ...patch } : c));
    set({ conditions: next });
  };
  const OPS = ["equals", "not_equals", "contains", "starts_with", "ends_with", "gt", "lt", "exists", "truthy", "matches"];
  return (
    <div className="space-y-2">
      <span className="block text-xs text-gray-500">Conditions (first match wins)</span>
      {conds.map((c, i) => (
        <div key={i} className="p-2 bg-surface-2 rounded space-y-1">
          <input className="w-full px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs font-mono" placeholder="variable (e.g. _last, triage.severity)" value={(c.variable as string) ?? ""} onChange={(e) => update(i, { variable: e.target.value })} />
          <div className="flex gap-1">
            <select className="px-1 py-1 bg-surface-1 border border-surface-3 rounded text-xs" value={(c.operator as string) ?? "equals"} onChange={(e) => update(i, { operator: e.target.value })}>
              {OPS.map((o) => <option key={o}>{o}</option>)}
            </select>
            <input className="flex-1 px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs" placeholder="value" value={valStr(c.value)} onChange={(e) => update(i, { value: coerce(e.target.value) })} />
          </div>
          <div className="flex gap-1 items-center">
            <input className="flex-1 px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs" placeholder="→ handle" value={(c.handle as string) ?? ""} onChange={(e) => update(i, { handle: e.target.value })} />
            <button className="text-xs text-red-300 px-1" onClick={() => set({ conditions: conds.filter((_, j) => j !== i) })}>✕</button>
          </div>
        </div>
      ))}
      <button className="text-xs text-accent" onClick={() => set({ conditions: [...conds, { handle: "", variable: "_last", operator: "equals", value: "" }] })}>+ condition</button>
      <Field label="Default handle" value={(d.default_handle as string) ?? ""} onChange={(v) => set({ default_handle: v })} placeholder="default" />
    </div>
  );
}

function BranchFields({ d, set }: { d: Record<string, unknown>; set: (p: Record<string, unknown>) => void }) {
  const outs = (d.outputs as Record<string, unknown>[]) ?? [];
  const update = (i: number, patch: Record<string, unknown>) => set({ outputs: outs.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <div className="space-y-2">
      <Field label="Query (what the model decides)" value={(d.query as string) ?? ""} onChange={(v) => set({ query: v })} rows={3} />
      <Field label="Persona (optional — grants tools)" value={(d.persona as string) ?? ""} onChange={(v) => set({ persona: v })} placeholder="e.g. weather-agent" />
      <span className="block text-xs text-gray-500">Typed outputs (model picks one)</span>
      {outs.map((o, i) => (
        <div key={i} className="p-2 bg-surface-2 rounded space-y-1">
          <div className="flex gap-1 items-center">
            <input className="flex-1 px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs font-mono" placeholder="handle" value={(o.handle as string) ?? ""} onChange={(e) => update(i, { handle: e.target.value })} />
            <button className="text-xs text-red-300 px-1" onClick={() => set({ outputs: outs.filter((_, j) => j !== i) })}>✕</button>
          </div>
          <input className="w-full px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs" placeholder="description" value={(o.description as string) ?? ""} onChange={(e) => update(i, { description: e.target.value })} />
          <input className="w-full px-2 py-1 bg-surface-1 border border-surface-3 rounded text-xs font-mono" placeholder='schema JSON e.g. {"type":"integer"}' value={jsonStr(o.schema)} onChange={(e) => { try { update(i, { schema: JSON.parse(e.target.value) }); } catch { /* typing */ } }} />
        </div>
      ))}
      <button className="text-xs text-accent" onClick={() => set({ outputs: [...outs, { handle: "", description: "", schema: { type: "string" } }] })}>+ output</button>
      <Field label="Default handle" value={(d.default_handle as string) ?? ""} onChange={(v) => set({ default_handle: v })} placeholder="error" />
    </div>
  );
}

// small JSON helpers for the field editors
function jsonStr(v: unknown): string {
  return v == null ? "" : JSON.stringify(v);
}
function setJson(set: (p: Record<string, unknown>) => void, key: string, raw: string) {
  try {
    set({ [key]: raw.trim() === "" ? undefined : JSON.parse(raw) });
  } catch {
    /* ignore while typing */
  }
}
function valStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
}
// Coerce a condition value string to number/bool/string.
function coerce(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !isNaN(Number(s))) return Number(s);
  return s;
}

// ---- helpers ----

function blankFlow(): SavedFlow {
  const now = new Date().toISOString();
  return {
    spec_version: "2",
    id: `flow-${Math.random().toString(36).slice(2, 8)}`,
    name: "New flow",
    created_at: now,
    updated_at: now,
    enabled: false,
    flow: {
      nodes: [
        {
          id: "entry",
          node_type: "entry",
          data: { schedule_type: "manual" },
          position: [40, 40],
        },
      ],
      edges: [],
    },
  };
}

function makeId(kind: string): string {
  return `${kind}-${Math.random().toString(36).slice(2, 7)}`;
}

function defaultDataFor(kind: string): Record<string, unknown> {
  switch (kind) {
    case "entry":
      return { schedule_type: "manual" };
    case "prompt":
      return { prompt: "" };
    case "conditional":
      return { conditions: [{ handle: "yes", variable: "_last", operator: "truthy" }], default_handle: "no" };
    case "branch":
      return {
        query: "",
        outputs: [
          { handle: "ok", description: "", schema: { type: "string" } },
          { handle: "error", description: "could not complete", schema: { type: "string" } },
        ],
        default_handle: "error",
      };
    case "set_variable":
      return { variable: "", value: "" };
    case "tool":
      return { tool_name: "", args: {} };
    case "http":
      return { method: "GET", url: "" };
    case "sub_agent":
      return { task: "" };
    case "approval":
      return { message: "", choices: ["approve", "reject"] };
    case "wait":
      return { duration: "1h" };
    case "end":
      return { status: "completed" };
    default:
      return {};
  }
}

function nodeLabel(n: FlowNode): string {
  const d = n.data as Record<string, unknown>;
  switch (n.node_type) {
    case "entry":
      return `entry (${d.schedule_type ?? "manual"})`;
    case "prompt":
      return `prompt: ${truncate((d.prompt as string) ?? "", 30)}`;
    case "branch":
    case "branch_tool":
      return `${n.node_type}: ${truncate((d.condition as string) ?? "", 30)}`;
    default:
      return n.node_type;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function RunResultPanel({
  result,
  pauseRun,
  running,
  onResume,
  onViewSession,
}: {
  result: RunFlowResult;
  pauseRun: FlowRun | null;
  running: boolean;
  onResume: (runId: string, handle: string) => void;
  onViewSession?: () => void;
}) {
  const sessionLink = onViewSession && (
    <button onClick={onViewSession} className="text-accent hover:underline whitespace-nowrap">
      View session logs ↗
    </button>
  );

  // v1 legacy shape: a flat prompts array.
  if (result.prompts && result.prompts.length > 0 && !result.run_id) {
    return (
      <div className="px-4 py-2 bg-surface-1 border-b border-surface-3 text-xs">
        <div className="flex items-center justify-between mb-1">
          <span className="font-semibold text-gray-300">Run results — {result.prompts.length} prompt(s)</span>
          {sessionLink}
        </div>
        <ul className="space-y-1">
          {result.prompts.map((p) => (
            <li key={p.prompt_index} className={p.status === "completed" ? "text-green-300" : p.status === "interrupted" ? "text-amber-300" : "text-red-300"}>
              <span className="font-mono">[{p.prompt_index}]</span> {p.status}
              {p.answer && <> — {truncate(p.answer, 200)}</>}
              {p.error && <> — {truncate(p.error, 200)}</>}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // v2 state-machine shape: status + step trace + optional resume.
  const status = result.status ?? "completed";
  const statusColor = status === "completed" ? "text-green-300" : status === "paused" ? "text-amber-300" : "text-red-300";
  return (
    <div className="px-4 py-2 bg-surface-1 border-b border-surface-3 text-xs space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-gray-300">Run</span>
        <span className={`font-semibold uppercase ${statusColor}`}>{status}</span>
        {result.run_id && <span className="font-mono text-gray-500">{result.run_id.slice(0, 8)}</span>}
        {sessionLink && <span className="ml-auto">{sessionLink}</span>}
      </div>

      {result.steps && result.steps.length > 0 && (
        <ol className="space-y-0.5">
          {result.steps.map((s, i) => (
            <li key={i} className="text-gray-400">
              <span className="font-mono text-gray-500">{s.node_type}</span> <span className="text-gray-300">{s.node_id}</span> — {s.outcome}
              {s.detail && <> — {truncate(s.detail, 120)}</>}
            </li>
          ))}
        </ol>
      )}

      {status === "paused" && pauseRun?.pause && (
        <div className="p-2 bg-amber-900/20 border border-amber-800/40 rounded space-y-1.5">
          <div className="text-amber-200">
            Paused at <span className="font-mono">{pauseRun.current_node_id}</span> ({pauseRun.pause.reason})
          </div>
          {pauseRun.pause.message && <div className="text-gray-300">{pauseRun.pause.message}</div>}
          <div className="flex flex-wrap gap-1.5">
            {pauseRun.pause.resume_handles.map((h) => (
              <button
                key={h}
                disabled={running}
                onClick={() => onResume(pauseRun.id, h)}
                className="px-2 py-1 bg-amber-700 hover:bg-amber-600 text-white rounded disabled:opacity-40"
              >
                {h}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FlowTemplatePicker({
  templates,
  onPick,
  onCancel,
}: {
  templates: FlowTemplateSummary[];
  onPick: (slug: string | null) => void;
  onCancel: () => void;
}) {
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-surface-1 border border-surface-3 rounded p-6 space-y-3">
        <h3 className="text-sm font-semibold text-accent">New flow</h3>
        <p className="text-xs text-gray-400">
          Start from a template or build from scratch.
        </p>
        <button
          onClick={() => onPick(null)}
          className="w-full text-left px-3 py-2 bg-surface-2 hover:bg-surface-3 rounded text-sm"
        >
          <div className="font-medium text-gray-200">Blank flow</div>
          <div className="text-xs text-gray-500">An entry node and nothing else.</div>
        </button>
        {templates.length > 0 && (
          <div className="pt-2 border-t border-surface-3">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
              From template
            </div>
            <ul className="space-y-1">
              {templates.map((t) => (
                <li key={t.slug}>
                  <button
                    onClick={() => onPick(t.slug)}
                    className="w-full text-left px-3 py-2 bg-surface-2 hover:bg-surface-3 rounded text-sm"
                  >
                    <div className="font-medium text-gray-200">{t.name}</div>
                    <div className="text-xs text-gray-500 font-mono">{t.slug}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button
          onClick={onCancel}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
