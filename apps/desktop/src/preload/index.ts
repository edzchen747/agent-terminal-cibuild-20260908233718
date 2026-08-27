import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopState } from "../shared/api";

const api: DesktopApi = {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  createProject: () => ipcRenderer.invoke("desktop:create-project"),
  removeProject: (projectId) => ipcRenderer.invoke("desktop:remove-project", projectId),
  setProjectPersistent: (projectId, persistent) => ipcRenderer.invoke("desktop:set-project-persistent", projectId, persistent),
  openProject: (projectId) => ipcRenderer.invoke("desktop:open-project", projectId),
  createSession: (projectId, shellId) => ipcRenderer.invoke("desktop:create-session", projectId, shellId),
  closeSession: (sessionId) => ipcRenderer.invoke("desktop:close-session", sessionId),
  write: (sessionId, data) => ipcRenderer.send("desktop:write", sessionId, data),
  resize: (sessionId, cols, rows, force) => ipcRenderer.send("desktop:resize", sessionId, cols, rows, force),
  getBuffer: (sessionId) => ipcRenderer.invoke("desktop:get-buffer", sessionId),
  copyText: (text) => ipcRenderer.invoke("desktop:copy-text", text),
  startPairing: () => ipcRenderer.invoke("desktop:start-pairing"),
  revokeDevice: (deviceId) => ipcRenderer.invoke("desktop:revoke-device", deviceId),
  setDefaultShell: (shellId) => ipcRenderer.invoke("desktop:set-default-shell", shellId),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopState) => callback(state);
    ipcRenderer.on("desktop:state", listener);
    return () => ipcRenderer.removeListener("desktop:state", listener);
  },
  onData: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data);
    ipcRenderer.on("desktop:data", listener);
    return () => ipcRenderer.removeListener("desktop:data", listener);
  }
};

contextBridge.exposeInMainWorld("agentTerminal", api);
