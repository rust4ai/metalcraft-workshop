import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  ChatSummary,
  DiagnosticsSessionSummary,
  ProjectSnapshot,
  RecentEntry,
  WorkshopEvent,
  FileKind,
} from "../types";

export function useWorkshop() {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  // Diagnostics session the current error belongs to, if any — lets the error
  // banner deep-link to that session's logs.
  const [lastErrorSessionId, setLastErrorSessionId] = useState<string | null>(null);
  // Live lists for the Chats and Sessions tabs. Unlike the rest of the
  // sidebar (driven by the one-shot snapshot), these reflect agent-side state
  // that changes outside any workshop save — so they're fetched fresh from the
  // agent whenever their tab is opened, not read from the snapshot.
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [sessions, setSessions] = useState<DiagnosticsSessionSummary[]>([]);
  // Base URL of the active remote connection, captured when we open it. The
  // agent itself can't know its public URL (it sits behind a reverse proxy), so
  // the client is the source of truth — used to show inbound webhook URLs.
  const [remoteBaseUrl, setRemoteBaseUrl] = useState<string | null>(null);
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
            setChats([]);
            setSessions([]);
            setRemoteBaseUrl(null);
            break;
          case "file_changed":
            // Debounce snapshot reloads so a burst of writes coalesces.
            if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
            reloadTimer.current = window.setTimeout(() => {
              invoke("refresh_snapshot").catch(console.error);
            }, 250);
            break;
          case "save_ok":
            // In local mode the file watcher would catch this, but in remote
            // mode there is no watcher — refresh explicitly so the sidebar
            // picks up new/renamed items right away.
            invoke("refresh_snapshot").catch(console.error);
            break;
          case "error":
            setLastError(payload.message);
            setLastErrorSessionId(null);
            break;
        }
      });
    })();

    return () => {
      if (unlisten) unlisten();
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    };
  }, []);

  const reportError = useCallback(
    (context: string, error: unknown, sessionId?: string | null) => {
      console.error(context, error);
      setLastError(`${context}: ${String(error)}`);
      setLastErrorSessionId(sessionId ?? null);
    },
    [],
  );

  // Ask the agent for the current chat list. The agent reads it straight from
  // its chats/ directory, so this is always the live catalog.
  const refreshChats = useCallback(async () => {
    try {
      setChats(await invoke<ChatSummary[]>("list_chats"));
    } catch {
      // Local mode (and a disconnected agent) can't list chats — clear rather
      // than surface a recurring error every time the tab is opened.
      setChats([]);
    }
  }, []);

  // Ask the agent for the current diagnostics-session list. The agent reads it
  // straight from its sessions/ directory each call.
  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await invoke<DiagnosticsSessionSummary[]>("list_diagnostics_sessions"));
    } catch (e) {
      console.error("list_diagnostics_sessions", e);
      setSessions([]);
    }
  }, []);

  const refreshRecents = useCallback(async () => {
    try {
      const r = await invoke<RecentEntry[]>("list_recents");
      setRecents(r);
    } catch (e) {
      console.error("list_recents", e);
    }
  }, []);

  // Re-pull the project snapshot from the agent. The backend command emits a
  // `snapshot` workshop-event, so the listener above updates `snapshot` state —
  // no return value to thread through here. Used by the snapshot-driven tabs
  // (Personas/Skills) to pick up pack content an agent enabled mid-chat, which
  // in remote mode fires no file watcher and no save_ok.
  const refreshSnapshot = useCallback(async () => {
    try {
      await invoke("refresh_snapshot");
    } catch {
      // Local mode / disconnected agent has nothing to refresh from — the
      // existing snapshot stays as-is rather than surfacing a recurring error.
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
        setRemoteBaseUrl(null);
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
        setRemoteBaseUrl(baseUrl);
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

  // ── Metalcraft login (metalcraft-id + pod picker) ──────────────────────────
  // Thin passthroughs to the Tauri commands; connecting to a pod emits the same
  // `project_opened` event as any remote connection, so the app drops into the
  // dashboard through the existing listener.
  const metalcraftSession = useCallback(
    () => invoke<{ email: string } | null>("metalcraft_session"),
    [],
  );
  const metalcraftLoginStart = useCallback(
    () => invoke<Record<string, unknown>>("metalcraft_login_start"),
    [],
  );
  const metalcraftLoginPoll = useCallback(
    (deviceCode: string) =>
      invoke<Record<string, unknown>>("metalcraft_login_poll", { deviceCode }),
    [],
  );
  const metalcraftLogout = useCallback(() => invoke<void>("metalcraft_logout"), []);
  const listMetalcraftPods = useCallback(
    () => invoke<unknown[]>("list_metalcraft_pods"),
    [],
  );
  const openMetalcraftPod = useCallback(async (podId: string) => {
    await invoke("open_metalcraft_pod", { podId });
    setRemoteBaseUrl(null);
    await refreshRecents();
  }, [refreshRecents]);
  const rotateMetalcraftPodKey = useCallback(
    (podId: string) => invoke<void>("rotate_metalcraft_pod_key", { podId }),
    [],
  );

  return {
    snapshot,
    recents,
    remoteBaseUrl,
    lastError,
    lastErrorSessionId,
    clearError: () => {
      setLastError(null);
      setLastErrorSessionId(null);
    },
    reportError,
    openProject,
    openRemote,
    closeProject,
    metalcraftSession,
    metalcraftLoginStart,
    metalcraftLoginPoll,
    metalcraftLogout,
    listMetalcraftPods,
    openMetalcraftPod,
    rotateMetalcraftPodKey,
    chats,
    sessions,
    refreshChats,
    refreshSessions,
    refreshSnapshot,
  };
}

export type FileKindAlias = FileKind;
