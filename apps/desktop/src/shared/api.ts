import type { HostSnapshot, PairingPayload, Project, TerminalSession } from "@agentterminal/protocol";

export interface DesktopState extends HostSnapshot {
  currentProjectId: string;
}

export interface DesktopApi {
  getState(): Promise<DesktopState>;
  createProject(): Promise<Project | null>;
  removeProject(projectId: string): Promise<void>;
  openProject(projectId: string): Promise<void>;
  createSession(projectId: string, shellId?: string): Promise<TerminalSession>;
  closeSession(sessionId: string): Promise<void>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  getBuffer(sessionId: string): Promise<string>;
  startPairing(): Promise<PairingPayload>;
  revokeDevice(deviceId: string): Promise<void>;
  setDefaultShell(shellId: string): Promise<void>;
  onState(callback: (state: DesktopState) => void): () => void;
  onData(callback: (sessionId: string, data: string) => void): () => void;
}

