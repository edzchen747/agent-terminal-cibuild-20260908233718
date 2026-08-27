import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, type WebContents } from "electron";
import type {
  ClientMessage,
  DeviceIdentity,
  HostSnapshot,
  PairingPayload,
  Project,
  ServerMessage,
  ShellProfile,
  TerminalSession
} from "@agentterminal/protocol";
import { PROTOCOL_VERSION } from "@agentterminal/protocol";
import { DesktopStore } from "./store";
import { detectShells } from "./shells";
import { SessionManager } from "./sessions";
import { RemoteServer } from "./remote-server";
import { RelayClient } from "./relay-client";

interface PairingGrant { expiresAt: number; }

let store: DesktopStore;
let sessions: SessionManager;
let remote: RemoteServer;
let relayClient: RelayClient | undefined;
let shells: ShellProfile[] = [];
const projectWindows = new Map<string, BrowserWindow>();
const windowProjects = new Map<number, string>();
const temporaryProjects = new Map<string, Project>();
const pairingGrants = new Map<string, PairingGrant>();
let isQuitting = false;

function projectById(projectId: string): Project {
  const project = [...store.projects, ...temporaryProjects.values()].find((item) => item.id === projectId);
  if (!project) throw new Error("Project not found.");
  return project;
}

function publicProjects(): Project[] {
  const activeProjectIds = new Set(sessions.list().map((session) => session.projectId));
  return [
    ...store.projects,
    ...[...temporaryProjects.values()].filter((project) => activeProjectIds.has(project.id) || projectWindows.has(project.id))
  ];
}

function snapshot(): HostSnapshot {
  return {
    host: { id: store.host.id, name: store.host.name, version: app.getVersion() },
    projects: publicProjects(),
    sessions: sessions.list(),
    devices: store.devices.map(({ tokenHash: _tokenHash, ...device }) => device),
    shells,
    defaultShellId: shells.some((shell) => shell.id === store.settings.defaultShellId)
      ? store.settings.defaultShellId
      : shells[0]?.id ?? "cmd"
  };
}

function stateFor(contents: WebContents): HostSnapshot & { currentProjectId: string } {
  return { ...snapshot(), currentProjectId: windowProjects.get(contents.id) ?? publicProjects()[0]?.id ?? "" };
}

function broadcastState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("desktop:state", stateFor(window.webContents));
  }
  remote?.broadcastSnapshot();
}

function selectedShell(shellId?: string): ShellProfile {
  const wanted = shellId ?? store.settings.defaultShellId;
  return shells.find((shell) => shell.id === wanted) ?? shells[0] ?? {
    id: "cmd", name: "Command Prompt", executable: process.env.ComSpec ?? "cmd.exe", args: []
  };
}

function createSession(projectId: string, shellId?: string): TerminalSession {
  const session = sessions.create(projectById(projectId), selectedShell(shellId));
  ensureProjectWindow(projectId);
  return session;
}

function ensureProjectWindow(projectId: string): BrowserWindow {
  const existing = projectWindows.get(projectId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 840,
    minHeight: 560,
    backgroundColor: "#090b10",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#090b10", symbolColor: "#c8cedd", height: 42 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  projectWindows.set(projectId, window);
  const webContentsId = window.webContents.id;
  windowProjects.set(webContentsId, projectId);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    projectWindows.delete(projectId);
    windowProjects.delete(webContentsId);
    if (!isQuitting) {
      for (const session of sessions.list().filter((item) => item.projectId === projectId)) sessions.close(session.id);
      temporaryProjects.delete(projectId);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return window;
}

function setProjectPersistence(projectId: string, persistent: boolean): Project {
  const current = projectById(projectId);
  if (current.persistent === persistent) return current;

  const project: Project = {
    ...current,
    persistent,
    createdAt: persistent ? current.createdAt ?? new Date().toISOString() : current.createdAt
  };
  if (persistent) {
    temporaryProjects.delete(projectId);
    store.saveProject(project);
  } else {
    store.removeProject(projectId);
    temporaryProjects.set(projectId, project);
  }
  broadcastState();
  return project;
}

function handleSessionWorkingDirectory(sessionId: string, reportedCwd: string): void {
  const session = sessions.list().find((item) => item.id === sessionId);
  if (!session) return;
  let candidate = reportedCwd.trim().replace(/^"|"$/g, "");
  if (/^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1);
  candidate = candidate.replace(/\//g, path.sep);
  const cwd = path.resolve(candidate);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return;

  const savedProject = store.projects
    .filter((project) => isWithinProject(cwd, project.path))
    .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length)[0];
  let project = savedProject ?? [...temporaryProjects.values()].find((item) => samePath(item.path, cwd));
  if (!project) {
    project = {
      id: `temporary-${crypto.randomUUID()}`,
      name: path.basename(cwd) || cwd,
      path: cwd,
      persistent: false
    };
    temporaryProjects.set(project.id, project);
  }

  const previousProjectId = session.projectId;
  sessions.updateLocation(sessionId, project.id, cwd);
  if (project.id === previousProjectId) return;
  ensureProjectWindow(project.id);

  const previousProject = temporaryProjects.get(previousProjectId);
  if (previousProject && !sessions.list().some((item) => item.projectId === previousProjectId)) {
    const previousWindow = projectWindows.get(previousProjectId);
    if (previousWindow && !previousWindow.isDestroyed()) previousWindow.close();
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isWithinProject(candidate: string, projectPath: string): boolean {
  const relative = path.relative(path.resolve(projectPath), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createPersistentProject(name: string, folderPath: string): Project {
  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("The desktop folder does not exist.");
  const normalized = path.normalize(resolved).toLowerCase();
  const savedDuplicate = store.projects.find((project) => path.normalize(project.path).toLowerCase() === normalized);
  if (savedDuplicate) return savedDuplicate;
  const temporaryDuplicate = [...temporaryProjects.values()].find((project) => path.normalize(project.path).toLowerCase() === normalized);
  if (temporaryDuplicate) return setProjectPersistence(temporaryDuplicate.id, true);
  const project: Project = {
    id: crypto.randomUUID(),
    name: name.trim() || path.basename(resolved),
    path: resolved,
    persistent: true,
    createdAt: new Date().toISOString()
  };
  store.saveProject(project);
  broadcastState();
  return project;
}

function consumePairingGrant(token: string, device: DeviceIdentity): string | null {
  const grant = pairingGrants.get(token);
  pairingGrants.delete(token);
  if (!grant || grant.expiresAt < Date.now()) return null;
  const deviceToken = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  store.authorizeDevice({ ...device, addedAt: now, lastSeenAt: now }, deviceToken);
  broadcastState();
  return deviceToken;
}

async function executeRemote(message: ClientMessage): Promise<ServerMessage | null> {
  switch (message.type) {
    case "snapshot.request":
      return { type: "snapshot", requestId: message.requestId, snapshot: snapshot() };
    case "project.create":
      createPersistentProject(message.name, message.path);
      return { type: "snapshot", requestId: message.requestId, snapshot: snapshot() };
    case "project.remove":
      setProjectPersistence(message.projectId, false);
      return { type: "snapshot", requestId: message.requestId, snapshot: snapshot() };
    case "project.persistence":
      setProjectPersistence(message.projectId, message.persistent);
      return { type: "snapshot", requestId: message.requestId, snapshot: snapshot() };
    case "session.create": {
      const session = createSession(message.projectId, message.shellId);
      return { type: "snapshot", requestId: message.requestId, snapshot: snapshot() };
    }
    case "session.close":
      sessions.close(message.sessionId);
      return { type: "ok", requestId: message.requestId };
    case "session.attach":
      sessions.resize(message.sessionId, message.cols, message.rows);
      return { type: "session.buffer", requestId: message.requestId, sessionId: message.sessionId, data: sessions.buffer(message.sessionId) };
    case "session.detach":
      return { type: "ok", requestId: message.requestId };
    case "session.input":
      sessions.write(message.sessionId, message.data);
      return null;
    case "session.resize":
      sessions.resize(message.sessionId, message.cols, message.rows, message.force);
      return null;
    case "pair":
    case "auth":
      return null;
  }
}

function localAddress(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

function configuredRelayEndpoint(): string | undefined {
  const value = process.env.AGENT_TERMINAL_RELAY_URL?.trim();
  if (!value) return undefined;
  return value.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:").replace(/\/$/, "");
}

function startPairing(): PairingPayload {
  const pairingToken = randomBytes(24).toString("base64url");
  const expiresAtMs = Date.now() + 5 * 60_000;
  pairingGrants.set(pairingToken, { expiresAt: expiresAtMs });
  const relayEndpoint = configuredRelayEndpoint();
  return {
    version: PROTOCOL_VERSION,
    hostId: store.host.id,
    hostName: store.host.name,
    endpoint: relayEndpoint ?? `ws://${localAddress()}:${remote.port}`,
    transport: relayEndpoint ? "relay" : "direct",
    pairingToken,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

function registerIpc(): void {
  ipcMain.handle("desktop:get-state", (event) => stateFor(event.sender));
  ipcMain.handle("desktop:create-project", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], title: "Choose a project folder" };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const project = createPersistentProject(path.basename(result.filePaths[0]), result.filePaths[0]);
    if (!sessions.list().some((session) => session.projectId === project.id)) createSession(project.id);
    else ensureProjectWindow(project.id);
    return project;
  });
  ipcMain.handle("desktop:remove-project", (_event, projectId: string) => {
    setProjectPersistence(projectId, false);
  });
  ipcMain.handle("desktop:set-project-persistent", (_event, projectId: string, persistent: boolean) => setProjectPersistence(projectId, persistent));
  ipcMain.handle("desktop:open-project", (_event, projectId: string) => {
    if (!sessions.list().some((session) => session.projectId === projectId && session.status === "running")) createSession(projectId);
    else ensureProjectWindow(projectId);
  });
  ipcMain.handle("desktop:create-session", (_event, projectId: string, shellId?: string) => createSession(projectId, shellId));
  ipcMain.handle("desktop:close-session", (_event, sessionId: string) => sessions.close(sessionId));
  ipcMain.on("desktop:write", (_event, sessionId: string, data: string) => sessions.write(sessionId, data));
  ipcMain.on("desktop:resize", (_event, sessionId: string, cols: number, rows: number, force?: boolean) => sessions.resize(sessionId, cols, rows, force));
  ipcMain.handle("desktop:get-buffer", (_event, sessionId: string) => sessions.buffer(sessionId));
  ipcMain.handle("desktop:copy-text", (_event, text: string) => {
    if (typeof text !== "string") throw new Error("Clipboard content must be text.");
    clipboard.writeText(text);
  });
  ipcMain.handle("desktop:start-pairing", () => startPairing());
  ipcMain.handle("desktop:revoke-device", (_event, deviceId: string) => {
    store.revokeDevice(deviceId);
    remote.disconnectDevice(deviceId);
    broadcastState();
  });
  ipcMain.handle("desktop:set-default-shell", (_event, shellId: string) => {
    if (!shells.some((shell) => shell.id === shellId)) throw new Error("Shell profile not found.");
    store.setDefaultShell(shellId);
    broadcastState();
  });
}

app.whenReady().then(() => {
  store = new DesktopStore(path.join(app.getPath("userData"), "agent-terminal.json"));
  shells = detectShells();
  sessions = new SessionManager();
  sessions.on("data", (sessionId: string, data: string) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("desktop:data", sessionId, data);
    }
    remote.sendOutput(sessionId, data);
  });
  sessions.on("changed", () => broadcastState());
  sessions.on("cwd", (sessionId: string, cwd: string) => handleSessionWorkingDirectory(sessionId, cwd));
  remote = new RemoteServer({
    port: store.settings.port,
    getSnapshot: snapshot,
    pair: consumePairingGrant,
    authenticate: (deviceId, token) => store.authenticate(deviceId, token),
    onAuthenticated: (deviceId) => { store.touchDevice(deviceId); broadcastState(); },
    execute: executeRemote
  });
  const relayEndpoint = configuredRelayEndpoint();
  if (relayEndpoint) {
    const relaySecret = process.env.AGENT_TERMINAL_RELAY_SECRET?.trim() || store.host.relayToken;
    relayClient = new RelayClient(relayEndpoint, store.host.id, relaySecret, remote);
    relayClient.connect();
  }
  registerIpc();

  const startFolder = app.getPath("home");
  const temporary: Project = {
    id: `temporary-${crypto.randomUUID()}`,
    name: path.basename(startFolder) || "Home",
    path: startFolder,
    persistent: false
  };
  temporaryProjects.set(temporary.id, temporary);
  createSession(temporary.id);
});

app.on("before-quit", () => {
  isQuitting = true;
  relayClient?.close();
  remote?.close();
  sessions?.dispose();
});

app.on("window-all-closed", () => app.quit());
