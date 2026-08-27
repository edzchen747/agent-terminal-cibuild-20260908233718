import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ShellProfile } from "@agentterminal/protocol";

function commandExists(command: string): boolean {
  try {
    execFileSync("where.exe", [command], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function detectShells(): ShellProfile[] {
  const shells: ShellProfile[] = [];
  const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  if (fs.existsSync(powershell)) shells.push({ id: "powershell", name: "Windows PowerShell", executable: powershell, args: ["-NoLogo"] });
  if (commandExists("pwsh.exe")) shells.push({ id: "pwsh", name: "PowerShell 7", executable: "pwsh.exe", args: ["-NoLogo"] });
  shells.push({ id: "cmd", name: "Command Prompt", executable: comspec, args: [] });
  if (commandExists("wsl.exe")) shells.push({ id: "wsl", name: "WSL", executable: "wsl.exe", args: [] });

  const gitBash = [
    path.join(process.env.ProgramFiles ?? "", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe")
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (gitBash) shells.push({ id: "git-bash", name: "Git Bash", executable: gitBash, args: ["--login", "-i"] });
  return shells;
}

