import type { HostSnapshot, PairingPayload, Project, TerminalSession } from "@agentterminal/protocol";

export interface DesktopState extends HostSnapshot {
  currentProjectId: string;
  remoteRegistration: {
    status: "unregistered" | "pending" | "enrolled" | "failed";
    error?: string;
  };
}

export interface DesktopApi {
  getState(): Promise<DesktopState>;
  createProject(): Promise<Project | null>;
  renameProject(projectId: string, name: string): Promise<Project>;
  removeProject(projectId: string): Promise<void>;
  setProjectPersistent(projectId: string, persistent: boolean): Promise<Project>;
  openProject(projectId: string): Promise<void>;
  createSession(projectId: string, shellId?: string): Promise<TerminalSession>;
  closeSession(sessionId: string): Promise<void>;
  reorderSessions(projectId: string, sessionIds: string[]): Promise<void>;
  write(sessionId: string, data: string, cols?: number, rows?: number): void;
  resize(sessionId: string, cols: number, rows: number, force?: boolean): void;
  attachSession(sessionId: string): Promise<string>;
  detachSession(sessionId: string): void;
  copyText(text: string): Promise<void>;
  startPairing(): Promise<PairingPayload>;
  retryRemoteRegistration(): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  setDefaultShell(shellId: string): Promise<void>;
  selectShell(sessionId: string | null, shellId: string): Promise<TerminalSession | null>;
  onPairingSucceeded(callback: () => void): () => void;
  onState(callback: (state: DesktopState) => void): () => void;
  onData(callback: (sessionId: string, data: string) => void): () => void;
}
