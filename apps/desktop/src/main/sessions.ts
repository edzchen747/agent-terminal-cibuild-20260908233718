import { EventEmitter } from "node:events";
import type { IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { parseTerminalWorkingDirectories } from "@agentterminal/protocol";
import type { Project, ShellProfile, TerminalSession } from "@agentterminal/protocol";

const MAX_SCROLLBACK_BYTES = 512_000;

interface ManagedSession {
  metadata: TerminalSession;
  process: IPty;
  buffer: string;
  controlTail: string;
  resizeRevision: number;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session.metadata }));
  }

  create(project: Project, shell: ShellProfile): TerminalSession {
    const id = crypto.randomUUID();
    const processEnv = { ...process.env } as { [key: string]: string | undefined };
    const shellArgs = configureShellIntegration(shell, processEnv);
    const terminal = pty.spawn(shell.executable, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: project.path,
      env: processEnv,
      useConpty: true
    });
    const metadata: TerminalSession = {
      id,
      projectId: project.id,
      title: shell.name,
      cwd: project.path,
      shellId: shell.id,
      status: "running",
      createdAt: new Date().toISOString()
    };
    const managed: ManagedSession = { metadata, process: terminal, buffer: "", controlTail: "", resizeRevision: 0 };
    this.sessions.set(id, managed);
    terminal.onData((data) => {
      managed.buffer = (managed.buffer + data).slice(-MAX_SCROLLBACK_BYTES);
      managed.controlTail = (managed.controlTail + data).slice(-8192);
      const reportedCwd = parseTerminalWorkingDirectories(managed.controlTail).at(-1);
      if (reportedCwd && normalizeForComparison(reportedCwd) !== normalizeForComparison(managed.metadata.cwd)) {
        this.emit("cwd", id, reportedCwd);
      }
      this.emit("data", id, data);
    });
    terminal.onExit(({ exitCode }) => {
      managed.metadata = { ...managed.metadata, status: "exited", exitCode };
      this.emit("changed");
    });
    this.emit("changed");
    return { ...metadata };
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.metadata.status === "running") session.process.write(data);
  }

  resize(sessionId: string, cols: number, rows: number, force = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.metadata.status === "running") {
      const nextCols = Math.max(2, Math.min(cols, 500));
      const nextRows = Math.max(1, Math.min(rows, 200));
      const revision = ++session.resizeRevision;
      if (!force) {
        session.process.resize(nextCols, nextRows);
        return;
      }
      session.process.resize(nextCols, nextRows > 1 ? nextRows - 1 : nextRows + 1);
      queueMicrotask(() => {
        if (this.sessions.get(sessionId) === session && session.resizeRevision === revision && session.metadata.status === "running") {
          session.process.resize(nextCols, nextRows);
        }
      });
    }
  }

  updateLocation(sessionId: string, projectId: string, cwd: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.metadata = { ...session.metadata, projectId, cwd };
    this.emit("changed");
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.metadata.status === "running") session.process.kill();
    this.sessions.delete(sessionId);
    this.emit("changed");
  }

  buffer(sessionId: string): string {
    return this.sessions.get(sessionId)?.buffer ?? "";
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.metadata.status === "running") session.process.kill();
    }
    this.sessions.clear();
  }
}

const POWERSHELL_CWD_HOOK = "$global:__AgentTerminalOriginalPrompt=$function:prompt; function global:prompt { $loc=$executionContext.SessionState.Path.CurrentLocation; $prefix=[string]([char]27)+']9;9;'+$loc+[char]27+'\\'; if ($global:__AgentTerminalOriginalPrompt) { $prefix+(& $global:__AgentTerminalOriginalPrompt) } else { $prefix+'PS '+$loc+'> ' } }";

function configureShellIntegration(shell: ShellProfile, environment: { [key: string]: string | undefined }): string[] {
  environment.WT_SESSION ??= crypto.randomUUID();
  environment.TERM_PROGRAM = "AgentTerminal";
  if (shell.id === "powershell" || shell.id === "pwsh") {
    return [...shell.args, "-NoExit", "-Command", POWERSHELL_CWD_HOOK];
  }
  if (shell.id === "cmd") {
    environment.PROMPT = `$e]9;9;$P$e\\${environment.PROMPT ?? "$P$G"}`;
  }
  if (shell.id === "git-bash") {
    const reportCwd = 'printf "\\033]9;9;%s\\007" "$(cygpath -w "$PWD" -C ANSI)"';
    environment.PROMPT_COMMAND = environment.PROMPT_COMMAND ? `${environment.PROMPT_COMMAND};${reportCwd}` : reportCwd;
  }
  return shell.args;
}

function normalizeForComparison(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/\//g, "\\").replace(/^\\([a-zA-Z]:\\)/, "$1").toLowerCase();
}
