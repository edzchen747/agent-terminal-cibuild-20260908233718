import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DesktopApi, DesktopState } from "../../shared/api";

interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

const stateListeners = new Set<(state: DesktopState) => void>();
const dataListeners = new Set<(sessionId: string, data: string) => void>();
const pairingListeners = new Set<() => void>();
const currentWindowTarget = getCurrentWebviewWindow().label;

const stateBridgeReady = listen<DesktopState>("desktop-state", ({ payload }) => {
  for (const listener of stateListeners) listener(payload);
}, { target: currentWindowTarget });

const dataBridgeReady = listen<TerminalDataEvent>("desktop-data", ({ payload }) => {
  for (const listener of dataListeners) listener(payload.sessionId, payload.data);
}, { target: currentWindowTarget });

const pairingBridgeReady = listen<string>("pairing-succeeded", () => {
  for (const listener of pairingListeners) listener();
});

void stateBridgeReady;
void pairingBridgeReady;

const api: DesktopApi = {
  getState: () => invoke("get_state"),
  createProject: () => invoke("create_project"),
  renameProject: (projectId, name) => invoke("rename_project", { projectId, name }),
  removeProject: (projectId) => invoke("remove_project", { projectId }),
  setProjectPersistent: (projectId, persistent) => invoke("set_project_persistent", { projectId, persistent }),
  openProject: (projectId) => invoke("open_project", { projectId }),
  createSession: (projectId, shellId) => invoke("create_session", { projectId, shellId }),
  closeSession: (sessionId) => invoke("close_session", { sessionId }),
  reorderSessions: (projectId, sessionIds) => invoke("reorder_sessions", { projectId, sessionIds }),
  write: (sessionId, data, cols, rows) => { void invoke("write_session", { sessionId, data, cols, rows }); },
  resize: (sessionId, cols, rows, force) => { void invoke("resize_session", { sessionId, cols, rows, force }); },
  attachSession: async (sessionId) => {
    await dataBridgeReady;
    return invoke("attach_session", { sessionId });
  },
  detachSession: (sessionId) => { void invoke("detach_session", { sessionId }); },
  copyText: (text) => invoke("copy_text", { text }),
  startPairing: () => invoke("start_pairing"),
  retryRemoteRegistration: () => invoke("retry_remote_registration"),
  revokeDevice: (deviceId) => invoke("revoke_device", { deviceId }),
  setDefaultShell: (shellId) => invoke("set_default_shell", { shellId }),
  selectShell: (sessionId, shellId) => invoke("select_shell", { sessionId, shellId }),
  onPairingSucceeded: (callback) => {
    pairingListeners.add(callback);
    return () => pairingListeners.delete(callback);
  },
  onState: (callback) => {
    stateListeners.add(callback);
    return () => stateListeners.delete(callback);
  },
  onData: (callback) => {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  }
};

window.agentTerminal = api;
