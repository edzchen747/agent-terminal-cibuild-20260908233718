import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.agentterminal.mobile",
  appName: "Agent Terminal",
  webDir: "dist",
  server: { cleartext: true },
  android: { allowMixedContent: true },
  // Forward WebView console output ([ATSync] sync diagnostics) into logcat
  // even on release builds; the default ("debug") only logs on debug builds.
  loggingBehavior: "production"
};

export default config;

