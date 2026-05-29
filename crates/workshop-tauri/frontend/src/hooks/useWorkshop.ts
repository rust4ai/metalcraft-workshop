import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectSnapshot, RecentEntry, WorkshopEvent, FileKind } from "../types";

export function useWorkshop() {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const reloadTimer = useRef<number | null>(null);

  // Subscribe + bootstrap.
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const initial = await invoke<ProjectSnapshot | null>("get_snapshot");
        if (initial) setSnapshot(initial);
        const r = await invoke<RecentEntry[]>("list_recents");
        setRecents(r);
      } catch (e) {
        console.error("bootstrap", e);
      }

      unlisten = await listen<WorkshopEvent>("workshop-event", (ev) => {
        const payload = ev.payload;
        switch (payload.type) {
          case "project_opened": {
            const { type: _t, ...rest } = payload;
            setSnapshot(rest as ProjectSnapshot);
            break;
          }
          case "snapshot": {
            const { type: _t, ...rest } = payload;
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

  const reportError = useCallback((context: string, error: unknown) => {
    console.error(context, error);
    setLastError(`${context}: ${String(error)}`);
  }, []);

  const refreshRecents = useCallback(async () => {
    try {
      const r = await invoke<RecentEntry[]>("list_recents");
      setRecents(r);
    } catch (e) {
      console.error("list_recents", e);
    }
  }, []);

  const openProject = useCallback(
    async (path?: string) => {
      let target = path;
      if (!target) {
        const picked = await openDialog({ directory: true, multiple: false });
        if (!picked || Array.isArray(picked)) return;
        target = picked;
      }
      try {
        await invoke("open_project", { path: target });
        await refreshRecents();
      } catch (e) {
        setLastError(String(e));
      }
    },
    [refreshRecents]
  );

  const openRemote = useCallback(
    async (baseUrl: string, apiKey: string) => {
      try {
        await invoke("open_remote", { baseUrl, apiKey });
        await refreshRecents();
      } catch (e) {
        setLastError(String(e));
      }
    },
    [refreshRecents]
  );

  const closeProject = useCallback(async () => {
    await invoke("close_project").catch(console.error);
  }, []);

  return {
    snapshot,
    recents,
    lastError,
    clearError: () => setLastError(null),
    reportError,
    openProject,
    openRemote,
    closeProject,
  };
}

export type FileKindAlias = FileKind;
