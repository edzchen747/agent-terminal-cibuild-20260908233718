import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";

function fallbackDeviceName(): string {
  const platform = Capacitor.getPlatform();
  return platform === "android" ? "Android phone" : platform === "ios" ? "iPhone" : "Web client";
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
      return fallbackDeviceName();
    }
    // iOS reports a hardware identifier in `model` (e.g. "iPhone13,4"); a
    // friendly "iPhone" label is the best we can do without the assigned name.
    return "iPhone";
  } catch {
    return fallbackDeviceName();
  }
}
