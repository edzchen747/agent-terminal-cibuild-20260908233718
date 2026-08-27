import { registerPlugin } from "@capacitor/core";

interface ConnectionNotificationPlugin {
  start(options: { hostName: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(eventName: "disconnectRequested", listenerFunc: () => void): Promise<{ remove: () => Promise<void> }>;
}

export const ConnectionNotification = registerPlugin<ConnectionNotificationPlugin>("ConnectionNotification");
