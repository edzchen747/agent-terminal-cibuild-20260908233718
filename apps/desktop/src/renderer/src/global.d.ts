import type { DesktopApi } from "../../shared/api";

declare global {
  interface Window { agentTerminal: DesktopApi; }
}

export {};

