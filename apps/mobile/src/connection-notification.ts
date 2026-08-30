import { registerPlugin } from "@capacitor/core";

interface ConnectionNotificationPlugin {
  start(options: { hostName: string }): Promise<void>;
  update(options: { hostName: string; state: "connected" | "reconnecting" | "offline" }): Promise<void>;
  stop(): Promise<void>;
  addListener(eventName: "disconnectRequested" | "reconnectTimedOut", listenerFunc: () => void): Promise<{ remove: () => Promise<void> }>;
}

export const ConnectionNotification = registerPlugin<ConnectionNotificationPlugin>("ConnectionNotification");
