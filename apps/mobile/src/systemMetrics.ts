import { Capacitor, registerPlugin } from "@capacitor/core";
import { MODIFIER_HOLD_THRESHOLD_MS } from "./utilityKeys";

interface SystemMetricsPlugin {
  longPressTimeoutMs(): Promise<{ longPressTimeoutMs: number }>;
}

const NativeSystemMetrics = registerPlugin<SystemMetricsPlugin>("SystemMetrics");

/**
 * The duration that counts as a detected utility-key hold. On Android the
 * system's own long-press detection timeout (the config_longPressTimeout
 * resource, read natively by the SystemMetrics plugin) sets the boundary,
 * so the keyboard's hold behavior matches platform convention. Web builds
 * and native builds without the plugin fall back to the default constant.
 */
export async function systemHoldThresholdMs(): Promise<number> {
  if (!Capacitor.isNativePlatform()) return MODIFIER_HOLD_THRESHOLD_MS;
  try {
    const { longPressTimeoutMs } = await NativeSystemMetrics.longPressTimeoutMs();
    if (Number.isFinite(longPressTimeoutMs) && longPressTimeoutMs > 0) return Math.round(longPressTimeoutMs);
  } catch {
    // The plugin is missing (older native build) or unavailable: fall back.
  }
  return MODIFIER_HOLD_THRESHOLD_MS;
}
