import { EventEmitter } from "node:events";
import type { IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import type { Project, ShellProfile, TerminalSession } from "@agentterminal/protocol";

const MAX_SCROLLBACK_BYTES = 512_000;

interface ManagedSession {
  metadata: TerminalSession;
  process: IPty;
  buffer: string;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session.metadata }));
  }

  create(project: Project, shell: ShellProfile): TerminalSession {
    const id = crypto.randomUUID();
    const processEnv = { ...process.env } as { [key: string]: string | undefined };
    const terminal = pty.spawn(shell.executable, shell.args, {
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
    const managed: ManagedSession = { metadata, process: terminal, buffer: "" };
    this.sessions.set(id, managed);
    terminal.onData((data) => {
      managed.buffer = (managed.buffer + data).slice(-MAX_SCROLLBACK_BYTES);
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
    const session = this.require(sessionId);
    if (session.metadata.status === "running") session.process.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.require(sessionId);
    if (session.metadata.status === "running") {
      session.process.resize(Math.max(2, Math.min(cols, 500)), Math.max(1, Math.min(rows, 200)));
    }
  }

  close(sessionId: string): void {
    const session = this.require(sessionId);
    if (session.metadata.status === "running") session.process.kill();
    this.sessions.delete(sessionId);
    this.emit("changed");
  }

  buffer(sessionId: string): string {
    return this.require(sessionId).buffer;
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.metadata.status === "running") session.process.kill();
    }
    this.sessions.clear();
  }

  private require(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Terminal session not found.");
    return session;
  }
}
