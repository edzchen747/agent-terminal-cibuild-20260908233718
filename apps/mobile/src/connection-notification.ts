import { registerPlugin } from "@capacitor/core";

interface ConnectionNotificationPlugin {
  start(options: { hostName: string; endpoint?: string }): Promise<void>;
  update(options: { hostName: string; state: "connected" | "reconnecting" | "offline"; endpoint?: string }): Promise<void>;
  stop(): Promise<void>;
  getScreenState(): Promise<{ awake: boolean; sleeping: boolean }>;
  addListener(eventName: "screenState", listenerFunc: (data: { awake: boolean; sleeping: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: "disconnectRequested" | "reconnectTimedOut", listenerFunc: () => void): Promise<{ remove: () => Promise<void> }>;
}

export const ConnectionNotification = registerPlugin<ConnectionNotificationPlugin>("ConnectionNotification");
