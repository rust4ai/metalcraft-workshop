import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectSnapshot, WorkshopEvent, FileKind } from "../types";

export function useWorkshop() {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const reloadTimer = useRef<number | null>(null);

  // Subscribe + bootstrap.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const initial = await invoke<ProjectSnapshot | null>("get_snapshot");
        if (initial) setSnapshot(initial);
        const r = await invoke<string[]>("list_recents");
        setRecents(r);
      } catch (e) {
        console.error("bootstrap", e);
      }

      unlisten = await listen<WorkshopEvent>("workshop-event", (ev) => {
        const payload = ev.payload;
        switch (payload.type) {
          case "project_opened": {
            const { type: _, ...rest } = payload;
            setSnapshot(rest as ProjectSnapshot);
            break;
          }
          case "snapshot": {
            const { type: _, ...rest } = payload;
            setSnapshot(rest as ProjectSnapshot);
            break;
          }
          case "project_closed":
            setSnapshot(null);
            break;
          case "file_changed":
            // Debounce snapshot reloads so a burst of writes coalesces.
            if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
            reloadTimer.current = window.setTimeout(() => {
              invoke("refresh_snapshot").catch(console.error);
            }, 250);
            break;
          case "error":
            setLastError(payload.message);
            break;
        }
      });
    })();

    return () => {
      if (unlisten) unlisten();
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    };
  }, []);

  const openProject = useCallback(async (path?: string) => {
    let target = path;
    if (!target) {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      target = picked;
    }
    try {
      await invoke("open_project", { path: target });
      const r = await invoke<string[]>("list_recents");
      setRecents(r);
    } catch (e) {
      setLastError(String(e));
    }
  }, []);

  const closeProject = useCallback(async () => {
    await invoke("close_project").catch(console.error);
  }, []);

  return {
    snapshot,
    recents,
    lastError,
    clearError: () => setLastError(null),
    openProject,
    closeProject,
  };
}

export type FileKindAlias = FileKind;
