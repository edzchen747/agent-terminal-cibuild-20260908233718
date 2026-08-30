import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";

function fallbackDeviceName(): string {
  const platform = Capacitor.getPlatform();
  return platform === "android" ? "Android phone" : platform === "ios" ? "iPhone" : "Web client";
}

/**
 * Android WebViews report the hardware model in the user agent even when the
 * native device plugin is unavailable, e.g. "Mozilla/5.0 (Linux; Android 14;
 * Pixel 8 Build/...; wv)". This keeps names per-device without native code.
 */
function userAgentModel(): string | null {
  const match = navigator.userAgent.match(/Android \d+(?:\.\d+)?;\s*([^;)]+)/);
  return match?.[1]?.trim() || null;
}

/**
 * Resolve a readable name that tells this phone apart from others in the
 * desktop's device list. Prefers the user-assigned device name, then the
 * manufacturer + model on Android. iOS exposes no distinguishable model, so
 * only its assigned name can help.
 */
export async function deviceName(): Promise<string> {
  try {
    const info = await Device.getInfo();
    if (info.platform === "web") return "Web client";
    const assigned = info.name?.trim() ?? "";
    if (assigned && !/^sdk_gphone|^generic/i.test(assigned)) return assigned;
    if (info.platform === "android") {
      const combined = [info.manufacturer, info.model].filter(Boolean).join(" ").trim();
      if (combined) return combined;
    }
  } catch {
    // Fall through to the user-agent model below.
  }
  const model = userAgentModel();
  if (model && Capacitor.getPlatform() === "android") return model;
  return fallbackDeviceName();
}
