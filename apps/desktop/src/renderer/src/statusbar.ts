import type { AuthorizedDevice } from "@agentterminal/protocol";

/** One connected device as the status bar shows it. */
export interface StatusBarDevice {
  id: string;
  name: string;
  /**
   * The device is displaying one of the terminals this window is showing, so
   * the two are watching the same session (its dot fills in green).
   */
  sharesTerminal: boolean;
}

/** Shown in place of the device list when nothing is connected. */
export const NO_DEVICES_LABEL = "No devices connected";

/**
 * The devices currently holding a connection to this desktop, in pairing
 * order. Paired-but-offline devices stay out of the list (the Devices modal
 * is where the full roster lives), and a connected device is marked as
 * sharing a terminal when its viewport set overlaps the sessions this window
 * has on screen.
 */
export function connectedDevices(devices: readonly AuthorizedDevice[], openSessionIds: readonly string[]): StatusBarDevice[] {
  const open = new Set(openSessionIds);
  return devices.filter((device) => device.online).map((device) => ({
    id: device.id,
    name: device.name,
    sharesTerminal: (device.viewingSessionIds ?? []).some((sessionId) => open.has(sessionId)),
  }));
}
