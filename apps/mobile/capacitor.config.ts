import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.agentterminal.mobile",
  appName: "Agent Terminal",
  webDir: "dist",
  server: { cleartext: true },
  android: { allowMixedContent: true }
};

export default config;

