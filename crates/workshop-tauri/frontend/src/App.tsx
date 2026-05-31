import { useEffect, useState } from "react";
import { useWorkshop } from "./hooks/useWorkshop";
import { ErrorProvider } from "./hooks/useReportError";
import ProjectPicker from "./components/ProjectPicker";
import Sidebar from "./components/Sidebar";
import PersonasView from "./components/PersonasView";
import SkillsView from "./components/SkillsView";
import FlowsView from "./components/FlowsView";
import ChatsView from "./components/ChatsView";
import SessionsView from "./components/SessionsView";
import ApiToolsView from "./components/ApiToolsView";
import KeysView from "./components/KeysView";
import PacksView from "./components/PacksView";

export type Section =
  | "personas"
  | "skills"
  | "flows"
  | "chats"
  | "sessions"
  | "api_tools"
  | "keys"
  | "packs";

export default function App() {
  const workshop = useWorkshop();
  const [section, setSection] = useState<Section>("personas");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-dismiss the error toast so a transient failure doesn't sit on screen
  // forever. It stays clickable/closable for as long as it's shown.
  const { lastError, clearError } = workshop;
  useEffect(() => {
    if (!lastError) return;
    const t = window.setTimeout(clearError, 5000);
    return () => window.clearTimeout(t);
  }, [lastError, clearError]);

  if (!workshop.snapshot) {
    return (
      <ProjectPicker
        recents={workshop.recents}
        error={workshop.lastError}
        onOpen={(p?: string) => workshop.openProject(p)}
        onOpenRemote={(url, key) => workshop.openRemote(url, key)}
      />
    );
  }

  const snap = workshop.snapshot;
  const modeLabel = snap.mode === "remote" ? "API" : "DIR";
  const modeClass =
    snap.mode === "remote"
      ? "bg-accent/20 text-accent-light"
      : "bg-surface-2 text-gray-400";

  return (
    <ErrorProvider value={workshop.reportError}>
    <div className="h-screen flex flex-col bg-surface-0 text-gray-200">
      <header className="flex items-center gap-3 px-4 py-2 bg-surface-1 border-b border-surface-3">
        <h1 className="text-sm font-semibold text-accent">Metalcraft Workshop</h1>
        <span
          className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded font-mono ${modeClass}`}
        >
          {modeLabel}
        </span>
        <span className="text-xs text-gray-500 font-mono truncate" title={snap.root}>
          {snap.root}
        </span>
        <div className="flex-1" />
        <button
          onClick={workshop.closeProject}
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          Close project
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          snapshot={snap}
          section={section}
          selectedId={selectedId}
          onSection={(s) => {
            setSection(s);
            setSelectedId(null);
            // Chats and Sessions reflect agent-side state written outside any
            // workshop save, so re-fetch their lists live from the agent each
            // time the tab is opened rather than trusting the snapshot.
            if (s === "chats") workshop.refreshChats();
            if (s === "sessions") workshop.refreshSessions();
          }}
          chats={workshop.chats}
          sessions={workshop.sessions}
          onSelect={setSelectedId}
        />
        <main className="flex-1 overflow-hidden">
          {section === "personas" && (
            <PersonasView
              snapshot={snap}
              selectedSlug={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {section === "skills" && (
            <SkillsView
              snapshot={snap}
              selectedSlug={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {section === "flows" && (
            <FlowsView
              snapshot={snap}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {section === "chats" && (
            <ChatsView
              snapshot={snap}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChatsChanged={() => {
                workshop.refreshChats();
                // A finished/failed turn also appends to the chat's diagnostics
                // session, so keep that list current too.
                workshop.refreshSessions();
              }}
            />
          )}
          {section === "sessions" && (
            <SessionsView
              snapshot={snap}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {section === "api_tools" && (
            <ApiToolsView
              snapshot={snap}
              selectedName={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {section === "keys" && (
            <KeysView
              snapshot={snap}
              selectedName={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {section === "packs" && (
            <PacksView
              snapshot={snap}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </main>
      </div>

      {workshop.lastError && (
        <div className="absolute bottom-4 right-4 max-w-md flex items-start gap-2 px-3 py-2 bg-red-900/90 text-red-100 text-sm rounded shadow-lg">
          <div className="flex-1 min-w-0">
            <pre className="whitespace-pre-wrap break-words font-sans max-h-48 overflow-auto m-0">
              {workshop.lastError}
            </pre>
            {workshop.lastErrorSessionId && (
              <button
                className="mt-1 text-xs text-red-200 underline hover:text-red-100"
                onClick={() => {
                  const sid = workshop.lastErrorSessionId;
                  workshop.clearError();
                  setSelectedId(sid);
                  setSection("sessions");
                  workshop.refreshSessions();
                }}
              >
                View session logs ↗
              </button>
            )}
          </div>
          <button
            className="shrink-0 text-red-300 hover:text-red-100 leading-none"
            title="Dismiss"
            onClick={workshop.clearError}
          >
            ✕
          </button>
        </div>
      )}
    </div>
    </ErrorProvider>
  );
}
