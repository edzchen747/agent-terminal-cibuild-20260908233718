import type { HostSnapshot, PairingPayload, PortBridge, Project, SessionActivity, SessionSegment, TaskbarProgress, TerminalSession, TuiMode } from "@agentterminal/protocol";

export interface DesktopState extends HostSnapshot {
  currentProjectId: string;
  /**
   * How the window came to show its current project: the user opened it
   * ("user"), or the host placed it there - a shell cd moved a session
   * into the project, or an empty temporary project was retired ("host").
   * The renderer uses this to keep a host-placed project's auto-selected
   * tab from claiming the PTY grid: the client that ran the cd (a phone)
   * is the one actually interacting, and a claim would steal the grid -
   * reflowing the phone's view - from under it.
   */
  currentProjectOrigin: "user" | "host";
  openProjectsInNewWindows: boolean;
  confirmExternalLinks: boolean;
  followWorkingDirectory: boolean;
  remoteRegistration: {
    status: "unregistered" | "pending" | "enrolled" | "failed" | "offline" | "unpaired";
    error?: string;
  };
  /** Whether this app is registered as the user's default terminal app
   * (Windows); the settings UI shows a one-shot "set as default" option
   * while this is false. */
  isDefaultTerminal: boolean;
}

/** Per-grid PTY journal snapshot returned by `attachSession`: history split at
 * every grid epoch so the emulator can reflow through the exact sequence the
 * live clients applied. */
export interface SessionSnapshot {
  segments: SessionSegment[];
  /** Absolute stream byte offset just past the journal; live chunks below it are already contained in the replay. */
  endOffset: number;
}

/** A console Windows handed to us: open its project and select its tab. */
export interface FocusSessionEvent {
  projectId: string;
  sessionId: string;
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
  resize(sessionId: string, cols: number, rows: number, claim: boolean): void;
  attachSession(sessionId: string, cols: number, rows: number, claim: boolean): Promise<SessionSnapshot>;
  detachSession(sessionId: string): void;
  /** Leave the session's viewport set S without leaving its stream: the
   * pane stays attached (still receiving output) but is no longer a sizing
   * candidate. A hidden tab sends this instead of detaching. */
  releaseSessionViewport(sessionId: string): void;
  copyText(text: string): Promise<void>;
  /** Read the system clipboard text (the host's arboard-backed copy, the
   * same source Ctrl+V pastes into a pane). */
  readClipboard(): Promise<string>;
  logDebug(message: string): void;
  openExternalUrl(url: string): Promise<void>;
  startPairing(): Promise<PairingPayload>;
  retryRemoteRegistration(): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  /** Replace a device's Port Bridge configuration. Ports the user picks are
   * saved as configured even when another device currently holds one: the
   * host arbitrates collisions between devices at connection time and reports
   * the loser as a conflict, so the bridge comes up on its own once the
   * holder disconnects. */
  setDevicePortBridging(deviceId: string, enabled: boolean, bridges: PortBridge[]): Promise<void>;
  setDefaultShell(shellId: string): Promise<void>;
  /** Register this app as the user's default terminal app (Windows, per-user
   * registry; no elevation). Resolves once the choice is stored. */
  setDefaultTerminal(): Promise<void>;
  unsetDefaultTerminal(): Promise<void>;
  takeFocusSession(): Promise<FocusSessionEvent | null>;
  /** Report the tab this window is actively showing (or `null` when it
   * shows no tab): the host records it per window so a phone's "come
   * look" marker for that session drops the moment the terminal is
   * opened on the desktop. */
  setActiveSession(sessionId: string | null): Promise<void>;
  setTerminalTheme(darkSchemeId: string, lightSchemeId: string): Promise<void>;
  setOpenProjectsInNewWindows(enabled: boolean): Promise<void>;
  setConfirmExternalLinks(enabled: boolean): Promise<void>;
  setFollowWorkingDirectory(enabled: boolean): Promise<void>;
  selectShell(sessionId: string | null, shellId: string): Promise<TerminalSession | null>;
  onPairingSucceeded(callback: () => void): () => void;
  /** A session the OS handed to us: the window should bring it to the front. */
  onFocusSession(callback: (event: FocusSessionEvent) => void): () => void;
  onState(callback: (state: DesktopState) => void): () => void;
  onData(callback: (sessionId: string, data: string, offset: number) => void): () => void;
  onGrid(callback: (sessionId: string, cols: number, rows: number, offset: number) => void): () => void;
  onTuiMode(callback: (sessionId: string, mode: TuiMode, offset: number) => void): () => void;
  /**
   * The host reclassified whether a session is blocked on a foreground
   * program. There is no stream offset: idle is found by a timeout on
   * the host, not by a byte in the stream.
   */
  onActivity(callback: (sessionId: string, activity: SessionActivity, since: string) => void): () => void;
  /**
   * The session's taskbar progress changed, like the activity event: an
   * explicit ConEmu `OSC 9;4` report or the shell's command lifecycle,
   * both host-side, so there is no stream offset either.
   */
  onTaskbar(callback: (sessionId: string, taskbar: TaskbarProgress) => void): () => void;
}
