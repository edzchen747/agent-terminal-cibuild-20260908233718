/**
 * The utility key labels must never become a text selection. A long-press
 * on a label opens the browser's select-all/copy menu, which takes input
 * focus away from the terminal IME field and can leave a latched modifier
 * or a held key stuck. Keep the labels inert at both the CSS layer (the
 * stylesheet applies user-select) and the DOM layer (this guard prevents a
 * selection start regardless of platform quirks).
 */
export interface SelectionGuardEvent {
  preventDefault(): void;
}

const guardedElements = new WeakSet<HTMLElement>();

export function guardUtilityKeySelection(element: HTMLElement | null | undefined): void {
  if (!element || guardedElements.has(element)) return;
  guardedElements.add(element);
  element.style.userSelect = "none";
  element.style.setProperty("-webkit-user-select", "none");
  element.style.setProperty("-webkit-touch-callout", "none");
  element.addEventListener("selectstart", (event) => event.preventDefault());
}

export function blockUtilityKeySelectStart(event: SelectionGuardEvent): void {
  event.preventDefault();
}
