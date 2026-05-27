import { useState } from "react";
import { useWorkshop } from "./hooks/useWorkshop";
import ProjectPicker from "./components/ProjectPicker";
import Sidebar from "./components/Sidebar";
import PersonasView from "./components/PersonasView";
import SkillsView from "./components/SkillsView";
import FlowsView from "./components/FlowsView";
import ChatsView from "./components/ChatsView";

export type Section = "personas" | "skills" | "flows" | "chats";

export default function App() {
  const workshop = useWorkshop();
  const [section, setSection] = useState<Section>("personas");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!workshop.snapshot) {
    return (
      <ProjectPicker
        recents={workshop.recents}
        onOpen={(p?: string) => workshop.openProject(p)}
      />
    );
  }

  const snap = workshop.snapshot;

  return (
    <div className="h-screen flex flex-col bg-surface-0 text-gray-200">
      <header className="flex items-center gap-3 px-4 py-2 bg-surface-1 border-b border-surface-3">
        <h1 className="text-sm font-semibold text-accent">Metalcraft Workshop</h1>
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
          }}
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
            />
          )}
        </main>
      </div>

      {workshop.lastError && (
        <div
          className="absolute bottom-4 right-4 max-w-md px-3 py-2 bg-red-900/90 text-red-100 text-sm rounded shadow-lg cursor-pointer"
          onClick={workshop.clearError}
        >
          {workshop.lastError}
        </div>
      )}
    </div>
  );
}
