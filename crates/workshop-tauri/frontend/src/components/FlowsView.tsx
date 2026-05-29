import { useCallback, useEffect, useMemo, useState } from "react";
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
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useReportError } from "../hooks/useReportError";
import type {
  ProjectSnapshot,
  SavedFlow,
  FlowNode,
  FlowEdge,
  FlowTemplate,
  FlowTemplateSummary,
  RunFlowResult,
} from "../types";

interface Props {
  snapshot: ProjectSnapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const NODE_TYPES = ["entry", "prompt", "branch", "branch_tool"] as const;

export default function FlowsView({ selectedId, onSelect }: Props) {
  const [flow, setFlow] = useState<SavedFlow | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<FlowTemplateSummary[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunFlowResult | null>(null);
  const reportError = useReportError();
  const isNew = selectedId === "__new__";

  useEffect(() => {
    setSavedAt(null);
    setValidationErrors([]);
    setSelectedNodeId(null);
    setRunResult(null);
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
  }, [selectedId, isNew, reportError]);

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
          <>
            <button
              onClick={async () => {
                setRunning(true);
                setRunResult(null);
                try {
                  const result = await invoke<RunFlowResult>("run_flow", {
                    id: selectedId,
                  });
                  setRunResult(result);
                } catch (e) {
                  reportError("run_flow", e);
                } finally {
                  setRunning(false);
                }
              }}
              disabled={running}
              className="px-3 py-1 bg-green-700 hover:bg-green-600 text-white text-xs rounded disabled:opacity-40"
            >
              {running ? "Running…" : "Run"}
            </button>
            <button
              onClick={remove}
              className="px-3 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-200 text-xs rounded"
            >
              Delete
            </button>
          </>
        )}
        {savedAt && <span className="text-xs text-green-400">Saved.</span>}
      </div>

      {runResult && (
        <div className="px-4 py-2 bg-surface-1 border-b border-surface-3 text-xs">
          <div className="font-semibold mb-1 text-gray-300">
            Run results — {runResult.prompts.length} prompt(s)
          </div>
          <ul className="space-y-1">
            {runResult.prompts.map((p) => (
              <li
                key={p.prompt_index}
                className={
                  p.status === "completed"
                    ? "text-green-300"
                    : p.status === "interrupted"
                      ? "text-amber-300"
                      : "text-red-300"
                }
              >
                <span className="font-mono">[{p.prompt_index}]</span> {p.status}
                {p.answer && <> — {truncate(p.answer, 200)}</>}
                {p.error && <> — {truncate(p.error, 200)}</>}
              </li>
            ))}
          </ul>
        </div>
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
  node,
  onChange,
  onDelete,
  onAddNode,
}: {
  existingNodes: FlowNode[];
  node: FlowNode | null;
  onChange: (n: FlowNode) => void;
  onDelete: (id: string) => void;
  onAddNode: (n: FlowNode) => void;
}) {
  const rf = useReactFlow();
  return (
    <NodeInspector
      node={node}
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

  // React Flow's `fitView` prop only fires on initial mount. When the user
  // switches to a different flow the canvas keeps its old viewport, leaving
  // newly-loaded nodes parked off-screen. Re-fit explicitly when the flow
  // changes; the rAF + small delay gives RF a tick to measure the new nodes.
  useEffect(() => {
    if (nodes.length === 0) return;
    const tick = requestAnimationFrame(() => {
      rf.fitView({ padding: 0.2, duration: 200 });
    });
    return () => cancelAnimationFrame(tick);
  }, [flowId, rf, nodes.length]);

  const rfNodes = useMemo<Node[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: "default",
        position: { x: n.position[0], y: n.position[1] },
        data: { label: nodeLabel(n) },
      })),
    [nodes]
  );
  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.source_handle,
        targetHandle: e.target_handle,
      })),
    [edges]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const updated = applyNodeChanges(changes, rfNodes);
      const merged: FlowNode[] = updated.map((u) => {
        const orig = nodes.find((n) => n.id === u.id)!;
        return {
          ...orig,
          position: [u.position.x, u.position.y],
        };
      });
      onChange(merged, edges);
    },
    [rfNodes, nodes, edges, onChange]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const updated = applyEdgeChanges(changes, rfEdges);
      const merged: FlowEdge[] = updated.map((u) => ({
        id: u.id,
        source: u.source,
        target: u.target,
        source_handle: u.sourceHandle ?? undefined,
        target_handle: u.targetHandle ?? undefined,
      }));
      onChange(nodes, merged);
    },
    [rfEdges, nodes, edges, onChange]
  );

  const onConnect = useCallback<OnConnect>(
    (conn: Connection) => {
      const updated = addEdge(conn, rfEdges);
      const merged: FlowEdge[] = updated.map((u) => ({
        id: u.id,
        source: u.source,
        target: u.target,
        source_handle: u.sourceHandle ?? undefined,
        target_handle: u.targetHandle ?? undefined,
      }));
      onChange(nodes, merged);
    },
    [rfEdges, nodes, onChange]
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={(_, n) => onSelectNode(n.id)}
      onPaneClick={() => onSelectNode(null)}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} color="#222230" />
      <Controls />
    </ReactFlow>
  );
}

function NodeInspector({
  node,
  onChange,
  onDelete,
  onAddNode,
}: {
  node: FlowNode | null;
  onChange: (n: FlowNode) => void;
  onDelete: (id: string) => void;
  onAddNode: (kind: string) => void;
}) {
  return (
    <aside className="w-80 bg-surface-1 border-l border-surface-3 overflow-y-auto p-3">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Add node</p>
        <div className="flex flex-wrap gap-1.5">
          {NODE_TYPES.map((k) => (
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
              {NODE_TYPES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          {node.node_type === "entry" && (
            <EntryFields node={node} onChange={onChange} />
          )}
          {node.node_type === "prompt" && (
            <PromptFields node={node} onChange={onChange} />
          )}
          {(node.node_type === "branch" || node.node_type === "branch_tool") && (
            <BranchFields node={node} onChange={onChange} />
          )}

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
    </aside>
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
    </>
  );
}

function PromptFields({ node, onChange }: { node: FlowNode; onChange: (n: FlowNode) => void }) {
  const d = node.data as Record<string, unknown>;
  return (
    <label className="block">
      <span className="block text-xs text-gray-500 mb-1">Prompt</span>
      <textarea
        value={(d.prompt as string) ?? ""}
        onChange={(e) => onChange({ ...node, data: { ...d, prompt: e.target.value } })}
        rows={6}
        className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-sm"
      />
    </label>
  );
}

function BranchFields({ node, onChange }: { node: FlowNode; onChange: (n: FlowNode) => void }) {
  const d = node.data as Record<string, unknown>;
  return (
    <label className="block">
      <span className="block text-xs text-gray-500 mb-1">Condition</span>
      <input
        type="text"
        value={(d.condition as string) ?? ""}
        onChange={(e) => onChange({ ...node, data: { ...d, condition: e.target.value } })}
        className="w-full px-2 py-1 bg-surface-2 border border-surface-3 rounded text-sm"
      />
    </label>
  );
}

// ---- helpers ----

function blankFlow(): SavedFlow {
  const now = new Date().toISOString();
  return {
    spec_version: "1",
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
    case "branch":
    case "branch_tool":
      return { condition: "" };
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
