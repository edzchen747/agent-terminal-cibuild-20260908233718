export type Modal = "pair" | "settings" | "devices" | "rename" | null;

export function nextModalOnEscape(modal: Modal, renaming: boolean): Modal {
  if (!modal) return modal;
  if (modal === "rename" && renaming) return modal;
  return modal === "pair" ? "devices" : null;
}

export function nextModalAfterPairing(current: Modal): Modal {
  return current === "pair" ? "devices" : current;
}
