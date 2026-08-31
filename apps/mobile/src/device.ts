import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { Preferences } from "@capacitor/preferences";
import type { DeviceIdentity, Platform } from "@agentterminal/protocol";

const DEVICE_IDENTITY_KEY = "agent-terminal-device-identity";

/**
 * The identity this install presents to every desktop: one stable id for the
 * life of the app, with a freshly resolved name each time. A stable id keeps
 * a re-pairing from orphaning the desktop's record of this phone (desktops
 * dedupe authorized devices by id), so every pairing and reconnection speaks
 * as the same device instead of minting a new one.
 */
export async function deviceIdentity(platform: Platform): Promise<DeviceIdentity> {
  return { id: await stableDeviceId(), name: await deviceName(), platform };
}

async function stableDeviceId(): Promise<string> {
  try {
    const { value } = await Preferences.get({ key: DEVICE_IDENTITY_KEY });
    if (value) return value;
  } catch {
    // Storage is unavailable: an in-memory id still pairs this session; it
    // just regenerates on the next launch.
  }
  const id = crypto.randomUUID();
  try {
    await Preferences.set({ key: DEVICE_IDENTITY_KEY, value: id });
  } catch {
    // An unpersisted id still works for this session; see above.
  }
  return id;
}

function fallbackDeviceName(): string {
  const platform = Capacitor.getPlatform();
  return platform === "android" ? "Android phone" : platform === "ios" ? "iPhone" : "Web client";
}

/**
 * Android WebViews report the hardware model in the user agent even when the
 * native device plugin is unavailable, e.g. "Mozilla/5.0 (Linux; Android 14;
 * Pixel 8 Build/...; wv)". This keeps names per-device without native code.
 */
export function userAgentModel(userAgent = navigator.userAgent): string | null {
  const match = userAgent.match(/Android \d+(?:\.\d+)?;\s*([^;)]+)/);
  const model = match?.[1]?.split(" Build")[0]?.trim();
  return model || null;
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
