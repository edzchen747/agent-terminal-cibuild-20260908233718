import type { HostSnapshot, PairingPayload, Project, SessionSegment, TerminalSession, TuiMode } from "@agentterminal/protocol";

export interface DesktopState extends HostSnapshot {
  currentProjectId: string;
  openProjectsInNewWindows: boolean;
  confirmExternalLinks: boolean;
  followWorkingDirectory: boolean;
  remoteRegistration: {
    status: "unregistered" | "pending" | "enrolled" | "failed" | "offline" | "unpaired";
    error?: string;
  };
}

/** Per-grid PTY journal snapshot returned by `attachSession`: history split at
 * every grid epoch so the emulator can reflow through the exact sequence the
 * live clients applied. */
export interface SessionSnapshot {
  segments: SessionSegment[];
  /** Absolute stream byte offset just past the journal; live chunks below it are already contained in the replay. */
  endOffset: number;
}

export interface DesktopApi {
  getState(): Promise<DesktopState>;
  createProject(): Promise<Project | null>;
  renameProject(projectId: string, name: string): Promise<Project>;
  removeProject(projectId: string): Promise<void>;
  setProjectPersistent(projectId: string, persistent: boolean): Promise<Project>;
  openProject(projectId: string): Promise<void>;
  reorderProjects(projectIds: string[]): Promise<void>;
  createSession(projectId: string, shellId?: string): Promise<TerminalSession>;
  closeSession(sessionId: string): Promise<void>;
  reorderSessions(projectId: string, sessionIds: string[]): Promise<void>;
  write(sessionId: string, data: string, cols?: number, rows?: number): void;
  resize(sessionId: string, cols: number, rows: number, force?: boolean): void;
  attachSession(sessionId: string, cols: number, rows: number): Promise<SessionSnapshot>;
  detachSession(sessionId: string): void;
  copyText(text: string): Promise<void>;
  logDebug(message: string): void;
  openExternalUrl(url: string): Promise<void>;
  startPairing(): Promise<PairingPayload>;
  retryRemoteRegistration(): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  setDefaultShell(shellId: string): Promise<void>;
  setOpenProjectsInNewWindows(enabled: boolean): Promise<void>;
  setConfirmExternalLinks(enabled: boolean): Promise<void>;
  setFollowWorkingDirectory(enabled: boolean): Promise<void>;
  selectShell(sessionId: string | null, shellId: string): Promise<TerminalSession | null>;
  onPairingSucceeded(callback: () => void): () => void;
  onState(callback: (state: DesktopState) => void): () => void;
  onData(callback: (sessionId: string, data: string, offset: number) => void): () => void;
  onGrid(callback: (sessionId: string, cols: number, rows: number, offset: number) => void): () => void;
  onTuiMode(callback: (sessionId: string, mode: TuiMode, offset: number) => void): () => void;
}
