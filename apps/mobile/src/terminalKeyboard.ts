/**
 * Detect whether the software keyboard is open from the visual viewport.
 *
 * When the keyboard slides in, `visualViewport.height` falls well short of
 * `window.innerHeight` (in `adjustResize` WebViews the layout is squeezed
 * into the residual area, so the visual viewport loses ~the keyboard
 * height). The threshold guards against the small deltas that status bars
 * or system chrome produce.
 */
export function keyboardOpenState(innerHeight: number, visualHeight: number, thresholdPx = 150): boolean {
  if (!(innerHeight > 0) || !(visualHeight > 0)) return false;
  return innerHeight - visualHeight >= thresholdPx;
}

/** The terminal area's size while the keyboard was closed, for the
 * layout-based fallback below: the tallest stable height plus the width it
 * was measured at. */
export interface KeyboardLayoutReference {
  width: number;
  height: number;
}

/**
 * Layout-based keyboard detection for `adjustResize` WebViews, where the
 * visual viewport shrinks WITH the window and the inner-height delta stays
 * ~0: the terminal area losing its keyboard-free height while its width is
 * unchanged means the keyboard inset stole the vertical space (a real
 * resize - rotation, tablet mode - moves the width too and is a hardware
 * change, not a keyboard).
 */
export function keyboardOpenByLayout(
  current: { width: number; height: number },
  reference: KeyboardLayoutReference | null,
  minDeltaPx = 120,
  widthTolerancePx = 8
): boolean {
  if (!reference || reference.height <= 0) return false;
  if (!(current.width > 0) || !(current.height > 1)) return false;
  const shrank = reference.height - current.height >= minDeltaPx;
  const widthStable = Math.abs(current.width - reference.width) <= widthTolerancePx;
  return shrank && widthStable;
}

/**
 * Track the keyboard-free reference while the keyboard is closed: the
 * tallest stable terminal-area size (a width move re-baselines, so a real
 * resize adopts the new size instead of looking like a keyboard).
 */
export function keyboardLayoutReference(
  current: { width: number; height: number },
  reference: KeyboardLayoutReference | null
): KeyboardLayoutReference {
  if (!reference) return { ...current };
  if (Math.abs(current.width - reference.width) <= 8) {
    return current.height > reference.height ? { ...current } : reference;
  }
  return { ...current };
}
