import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthorizedDevice, Project } from "@agentterminal/protocol";

export interface StoredDevice extends AuthorizedDevice {
  tokenHash: string;
}

interface StoredState {
  host: { id: string; name: string };
  projects: Project[];
  devices: StoredDevice[];
  settings: { defaultShellId: string; port: number };
}

export class DesktopStore {
  private state: StoredState;

  constructor(private readonly filePath: string) {
    this.state = this.read();
  }

  private defaults(): StoredState {
    return {
      host: { id: crypto.randomUUID(), name: os.hostname() },
      projects: [],
      devices: [],
      settings: { defaultShellId: "powershell", port: 47831 }
    };
  }

  private read(): StoredState {
    try {
      return { ...this.defaults(), ...JSON.parse(fs.readFileSync(this.filePath, "utf8")) } as StoredState;
    } catch {
      const initial = this.defaults();
      this.write(initial);
      return initial;
    }
  }

  private write(next = this.state): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temporary, this.filePath);
  }

  get host(): StoredState["host"] { return this.state.host; }
  get projects(): Project[] { return [...this.state.projects]; }
  get devices(): StoredDevice[] { return [...this.state.devices]; }
  get settings(): StoredState["settings"] { return { ...this.state.settings }; }

  saveProject(project: Project): void {
    this.state.projects = [...this.state.projects.filter((item) => item.id !== project.id), project];
    this.write();
  }

  removeProject(projectId: string): void {
    this.state.projects = this.state.projects.filter((item) => item.id !== projectId);
    this.write();
  }

  authorizeDevice(device: AuthorizedDevice, token: string): void {
    const record: StoredDevice = { ...device, tokenHash: hashToken(token) };
    this.state.devices = [...this.state.devices.filter((item) => item.id !== device.id), record];
    this.write();
  }

  touchDevice(deviceId: string): void {
    const device = this.state.devices.find((item) => item.id === deviceId);
    if (device) {
      device.lastSeenAt = new Date().toISOString();
      this.write();
    }
  }

  revokeDevice(deviceId: string): void {
    this.state.devices = this.state.devices.filter((item) => item.id !== deviceId);
    this.write();
  }

  authenticate(deviceId: string, token: string): boolean {
    const expected = this.state.devices.find((item) => item.id === deviceId)?.tokenHash;
    if (!expected) return false;
    const actual = hashToken(token);
    return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }

  setDefaultShell(defaultShellId: string): void {
    this.state.settings.defaultShellId = defaultShellId;
    this.write();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

