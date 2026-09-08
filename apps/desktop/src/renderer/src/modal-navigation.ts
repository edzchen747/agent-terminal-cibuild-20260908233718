export type Modal = "pair" | "settings" | "devices" | "bridges" | "bridgeDevice" | "rename" | null;

/**
 * The modal the devices button should open. With no paired devices the list
 * page is skipped and the pairing QR opens directly.
 */
export function deviceListEntryModal(deviceCount: number): Modal {
  return deviceCount > 0 ? "devices" : "pair";
}

/**
 * Where the pairing QR modal goes when it is closed without pairing: back to
 * the devices list when there is one to show, or straight to the app shell
 * when the list was empty (and skipped on the way in).
 */
export function pairModalEscapeTarget(deviceCount: number): Modal {
  return deviceCount > 0 ? "devices" : null;
}

export function nextModalOnEscape(modal: Modal, renaming: boolean, deviceCount: number): Modal {
  if (!modal) return modal;
  if (modal === "rename" && renaming) return modal;
  if (modal === "pair") return pairModalEscapeTarget(deviceCount);
  // A device's port list is a page inside the Port Bridge page, so escape
  // steps back to the list of devices rather than out to the terminal.
  if (modal === "bridgeDevice") return "bridges";
  return null;
}

/**
 * Pairing succeeded: dismiss the QR modal and any devices list page behind
 * it, returning the user to the app shell.
 */
export function nextModalAfterPairing(current: Modal): Modal {
  return current === "pair" ? null : current;
}
