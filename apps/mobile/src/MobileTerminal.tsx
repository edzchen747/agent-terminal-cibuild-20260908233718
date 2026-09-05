import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { applyTerminalModifiers, createRequestId, findHttpLinks, gridForContent, streamByteLength, TERMINAL_SCROLLBACK_LINES, xtermThemeFor, zoomedFontSize } from "@agentterminal/protocol";
import type { Size, TerminalModifier, TerminalScheme, TerminalSession } from "@agentterminal/protocol";
import type { HostConnection } from "./connection";
import { classifyGestureAxis, commitTapOnGestureEnd, type GestureAxis } from "./gesture";
import { claimNativeInput, isCursorPositionReport, mobileTerminalKeydownInput, nativeTerminalInput } from "./terminalInput";
import type { TimedTerminalInput } from "./terminalInput";
import { announcedViewport, shouldSendResize } from "./terminalResize";
import { keyboardOpenByLayout, keyboardLayoutReference, keyboardOpenState, type KeyboardLayoutReference } from "./terminalKeyboard";
import { terminalFocusAction, type TerminalFocusAction } from "./terminalFocus";
import { TERMINAL_FONT_SIZE, calibratedSquishFontSize, squishAdvanceRatio, squishInverse as squishInverseValue, squishLineHeight as squishLineHeightValue, squishWidthPercent } from "./terminalSquish";
import { TERMINAL_FONT_FAMILY, preloadTerminalFonts } from "./terminalFonts";
import { activateTerminalCursor, deactivateTerminalCursor } from "./terminalCursor";
import { guardUtilityKeySelection } from "./utilityKeySelection";
import { createUtilityKeyPad, MODIFIER_HOLD_THRESHOLD_MS, type KeyPadResult, type UtilityKey } from "./utilityKeys";
import { systemHoldThresholdMs } from "./systemMetrics";
import "@xterm/xterm/css/xterm.css";

interface Props { connection: HostConnection; session: TerminalSession; active: boolean; fontWidthScale: number; scheme: TerminalScheme; }

// Mobile scroll sensitivity: the touch-drag handler synthesizes a pixel-unit
// wheel event whose deltaY is the raw per-event finger travel, so scrolling
// is 1:1 with finger movement. Multiply by this factor before dispatch so the
// terminal scrolls further per unit of travel. Raise for a snappier scroll,
// lower below 1 for a slower one. Mobile-only: the desktop pane never
// synthesizes these events.
const MOBILE_SCROLL_SENSITIVITY = 5;

// A zoom correction is a fixed point: raising the font size changes the
// measured cell size, which can call for another (smaller) correction. Cap
// the self-correcting loop per trigger so a pathological measurement cannot
// spin forever; two or three passes is the normal case.
const MAX_ZOOM_PASSES = 4;

// Start fetching the terminal font faces as soon as the app loads so xterm
// never measures with device fallback glyphs (see fonts.test.mjs).
void preloadTerminalFonts();

function openExternalLink(uri: string): void {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    const link = document.createElement("a");
    link.href = parsed.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.click();
  } catch {
    // Ignore malformed or unsupported terminal URLs.
  }
}

const ACCESSIBILITY_KEY_ROWS: UtilityKey[][] = [
  [
    { id: "esc", label: "Esc", value: "\x1b" },
    { id: "ctrl", label: "Ctrl", modifier: "ctrl" },
    { id: "alt", label: "Alt", modifier: "alt" },
    { id: "shift", label: "Shift", modifier: "shift" },
    { id: "tab", label: "Tab", value: "\t" },
    { id: "pipe", label: "|", value: "|" },
    { id: "tilde", label: "~", value: "~" }
  ],
  [
    { id: "page-up", label: "PgUp", value: "\x1b[5~" },
    { id: "page-down", label: "PgDn", value: "\x1b[6~" },
    { id: "word-left", label: "⌃←", value: "\x1b[1;5D" },
    { id: "left", label: "←", value: "\x1b[D" },
    { id: "up", label: "↑", value: "\x1b[A" },
    { id: "down", label: "↓", value: "\x1b[B" },
    { id: "right", label: "→", value: "\x1b[C" },
    { id: "word-right", label: "⌃→", value: "\x1b[1;5C" }
  ]
];

export function MobileTerminal({ connection, session, active, fontWidthScale, scheme }: Props) {
  // Terminal sync diagnostics: [ATSync] lines go to the WebView console
  // (logcat tag: Capacitor/Console) and are mirrored to the host through the
  // live connection, where they land in the host's sync log file - so a
  // debug session correlates the phone-side merges even if logcat is lost.
  const syncDebug = (message: string) => {
    console.log("[ATSync]", message);
    try {
      connection.send({ type: "debug.diagnostics", message });
    } catch {
      // Bounds: the connection is down; the console copy still exists.
    }
  };
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const fontWidthScaleRef = useRef(fontWidthScale);
  fontWidthScaleRef.current = fontWidthScale;
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;
  const a11yAdvanceRatioRef = useRef<number | undefined>(undefined);
  const resizeRef = useRef<() => void>(() => undefined);
  const focusInputRef = useRef<() => void>(() => undefined);
  // Cursor-only twin of focusInputRef: entry and attach-complete keep the
  // xterm cursor cell live without focusing the IME field, so entering the
  // terminal view does not pop the Android soft keyboard. The keyboard now
  // follows an explicit tap of the terminal or a utility key instead.
  const activateCursorRef = useRef<() => void>(() => undefined);
  // Attach/keepalive owner: the view-activity gate below calls into the
  // session-join machinery defined inside the terminal effect.
  const startAttachmentRef = useRef<() => void>(() => undefined);
  const keyPadRef = useRef<ReturnType<typeof createUtilityKeyPad> | null>(null);
  // The utility-key hold boundary: the default until the Android system's
  // own long-press timeout arrives; the pad consults it on every release,
  // so an in-flight hold is unaffected when the value lands.
  const holdThresholdRef = useRef(MODIFIER_HOLD_THRESHOLD_MS);
  if (keyPadRef.current === null) keyPadRef.current = createUtilityKeyPad(undefined, () => holdThresholdRef.current);
  useEffect(() => {
    let cancelled = false;
    void systemHoldThresholdMs().then((threshold) => {
      if (!cancelled) holdThresholdRef.current = threshold;
    });
    return () => { cancelled = true; };
  }, []);
  const [latchedKeyIds, setLatchedKeyIds] = useState<ReadonlySet<string>>(new Set());
  const [heldKeyIds, setHeldKeyIds] = useState<ReadonlySet<string>>(new Set());

  const syncKeyPad = () => {
    const current = keyPadRef.current!.state();
    setLatchedKeyIds(new Set(current.latched));
    setHeldKeyIds(new Set(current.held));
    return current;
  };

  // Runs a terminalFocus verdict against the live refs: "input" focuses the
  // IME field (which is what pops the Android soft keyboard), "cursor" runs
  // only the xterm cursor hand-off, and "none" does nothing (the inactive
  // blur is the [active] effect's job, not a focus action).
  const applyFocusAction = (action: TerminalFocusAction) => {
    if (action === "input") focusInputRef.current();
    else if (action === "cursor") activateCursorRef.current();
  };

  const sendKeyData = (data: string) => {
    if (!data || !activeRef.current) return;
    // The grid is the minimum boundary over the viewing clients; typing
    // never asserts dimensions (that would only seize the grid).
    applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: true }));
    connection.send({ type: "session.input", sessionId: session.id, data });
  };

  const vibrate = () => {
    try {
      navigator.vibrate(20);
    } catch {
      // WebViews without the VIBRATE permission (or without hardware support)
      // reject the call; the key press still works silently.
    }
  };

  const applyKeyPadResult = (result: KeyPadResult) => {
    syncKeyPad();
    if (result.data) sendKeyData(result.data);
  };

  useLayoutEffect(() => {
    const hostElement = hostRef.current;
    const inputElement = inputRef.current;
    if (!hostElement || !inputElement) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void preloadTerminalFonts().then(() => {
      if (disposed) return;
      const focusInput = () => {
        inputElement.focus({ preventScroll: true });
        inputElement.setSelectionRange(inputElement.value.length, inputElement.value.length);
        // The xterm textarea is display:none and cannot be focused, so xterm
        // never sees a focus event and its cursor cell stays uninitialized.
        // Make it believe it owns focus while the IME field actually does.
        activateTerminalCursor(terminal.textarea);
      };
      focusInputRef.current = focusInput;
      const activateCursorOnly = () => {
        // Same cursor hand-off as focusInput without the IME focus: xterm
        // must still believe it owns focus or its cursor cell stays
        // uninitialized, but the keyboard must not open on its own.
        activateTerminalCursor(terminal.textarea);
      };
      activateCursorRef.current = activateCursorOnly;
      // The PTY grid follows focus: while the phone is the focused client,
      // this emulator's fitted dimensions ARE the host PTY grid. When the
      // desktop takes control, the host announces the new grid (session.grid)
      // and this emulator reflows its history in place, so nothing is lost.
      const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: 1,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      screenReaderMode: true,
      smoothScrollDuration: 75,
      // The scheme comes from the host's shared setting, so the same session
      // renders identically on this phone and on the desktop. Whole schemes
      // only: the surface and the 16 ANSI colors always travel together (see
      // terminal-themes.ts).
      theme: xtermThemeFor(schemeRef.current)
    });
    terminalRef.current = terminal;
    terminal.open(hostElement);
    const httpLinkProvider = terminal.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = terminal.buffer.active.getLine(y - 1);
        const links = findHttpLinks(line?.translateToString(true) ?? "");
        callback(links.map((link) => ({
          text: link.text,
          range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
          activate: () => openExternalLink(link.text)
        })));
      }
    });
    applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: false }));
    // No local fit: the emulator grid is the host's (the minimum boundary
    // over the viewing clients), not the container's.

    // The accessibility layer's rows must paint and anchor at the same advance
    // the squished canvas cells have. Rather than trusting the font metrics to
    // scale linearly between the canvas measurement and the screen-reader
    // layer, measure what this WebView actually reports: xterm paints the
    // accessibility container at cellWidth * cols (its own css-pixel cell
    // size), and a mirror span inside the accessibility tree yields the real
    // DOM advance at the terminal's CURRENT font size (zoom raises or lowers
    // it - see applyZoom below - so a hard-coded base size would drift once
    // zoomed). The ratio reconciles the two so the squished font size lands
    // every accessibility character on its canvas cell, whatever face or
    // rounding the WebView applies to the layer. cols is always the
    // ANNOUNCED host grid here - never a local fit - so the squish tracks
    // the columns actually rendered.
    const calibrateAccessibilityMetrics = () => {
      const a11y = hostElement.querySelector<HTMLElement>(".xterm-accessibility");
      const tree = hostElement.querySelector<HTMLElement>(".xterm-accessibility-tree");
      if (!a11y || !tree || terminal.cols <= 0) return;
      const containerWidth = Number.parseFloat(a11y.style.width);
      if (!(containerWidth > 0)) return;
      const cellWidth = containerWidth / terminal.cols;
      const currentFontSize = terminal.options.fontSize ?? TERMINAL_FONT_SIZE;
      const mirror = document.createElement("span");
      mirror.className = "xterm-char-measure-element";
      mirror.style.fontFamily = TERMINAL_FONT_FAMILY;
      mirror.style.fontSize = `${currentFontSize}px`;
      mirror.style.fontKerning = "none";
      mirror.style.whiteSpace = "pre";
      mirror.textContent = "W".repeat(32);
      tree.appendChild(mirror);
      // The wrapper scale composed with the accessibility layer's inverse is
      // net identity, so the mirror's transformed rect still reports its true
      // layout width and keeps the sub-pixel precision offsetWidth lacks.
      const domAdvance = mirror.getBoundingClientRect().width / 32;
      mirror.remove();
      a11yAdvanceRatioRef.current = squishAdvanceRatio(cellWidth, domAdvance);
      hostElement.style.setProperty("--terminal-squish-font-size", calibratedSquishFontSize(currentFontSize, fontWidthScaleRef.current, a11yAdvanceRatioRef.current));
    };
    calibrateAccessibilityMetrics();

    // Announce, don't assert: the container's fitted size is the announced
    // viewport (W_m, H_m); the host takes the minimum over every client and
    // the xterm grid is only ever resized from host announcements. The
    // software keyboard is an ordinary hardware inset: when it opens the
    // container shrinks, the announcement follows, and the host's minimum
    // boundary re-flows every client. While it is open the announced height
    // is one row short: the keyboard inset overlaps the measured fit's last
    // row, and a one-row ledger keeps the last visible line clear of the
    // keyboard.
    let layoutReference: KeyboardLayoutReference | null = null;
    const keyboardOpen = () => {
      if (keyboardOpenState(window.innerHeight, window.visualViewport?.height ?? window.innerHeight)) {
        return true;
      }
      const rect = hostElement.getBoundingClientRect();
      const current = { width: rect.width, height: rect.height };
      if (keyboardOpenByLayout(current, layoutReference)) {
        return true;
      }
      // Keyboard closed: track the tallest stable layout so a future open is
      // measured against the real keyboard-free height.
      layoutReference = keyboardLayoutReference(current, layoutReference);
      return false;
    };
    // The content box xterm can actually paint into: the host element's own
    // LAYOUT box (offsetWidth/offsetHeight - not getBoundingClientRect,
    // which reports the box AFTER the horizontal squish transform) minus the
    // letterbox padding on `.mobile-terminal`. That layout box is already
    // the wide, pre-squish one the width: squishWidthPercent() style below
    // sizes to, so measuring here keeps zoom and squish fully independent.
    const contentBox = (): Size | null => {
      const style = window.getComputedStyle(hostElement);
      const width = hostElement.offsetWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = hostElement.offsetHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (!(width > 0 && height > 0)) return null;
      return { width, height };
    };
    // One cell in that same pre-transform layout space, read off the
    // rendered grid at whatever font size is currently applied. Null until
    // the emulator has painted.
    const cellSize = (): Size | null => {
      const screen = hostElement.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || terminal.cols < 1 || terminal.rows < 1) return null;
      const width = screen.offsetWidth;
      const height = screen.offsetHeight;
      if (width < 1 || height < 1) return null;
      return { width: width / terminal.cols, height: height / terminal.rows };
    };
    // The cell size at TERMINAL_FONT_SIZE, cached the first time it is
    // measurable. The announced viewport is always derived from this, never
    // from the live (possibly zoomed) cell size: if zooming in shrank the
    // announcement, it would shrink the host's minimum-boundary PTY grid,
    // which would call for more zoom - a ratchet that collapses the session.
    let baseCell: Size | null = null;
    const captureBaseCell = () => {
      if (terminal.options.fontSize !== TERMINAL_FONT_SIZE) return;
      const measured = cellSize();
      if (measured) baseCell = measured;
    };
    const proposeGrid = () => {
      captureBaseCell();
      const content = contentBox();
      if (!content) return null;
      return gridForContent(content, baseCell);
    };
    const announcedGrid = () => {
      const dims = proposeGrid();
      if (!dims) return null;
      return announcedViewport(dims, keyboardOpen());
    };
    // Fill the shell: raise or lower xterm's font size so the rendered grid
    // consumes as much of the content box as its aspect ratio allows, then
    // letterbox the rest (the shell aligns the grid to its top-left corner).
    // Render-only - it never touches the announcement above, which is why it
    // cannot ratchet. A font-size change moves the measured cell size, so
    // the correction is a fixed point: re-measure and correct again next
    // frame, capped at MAX_ZOOM_PASSES.
    const applyZoom = (passesLeft = MAX_ZOOM_PASSES) => {
      if (!activeRef.current || passesLeft <= 0) return;
      const content = contentBox();
      const cell = cellSize();
      const next = zoomedFontSize(terminal.options.fontSize ?? TERMINAL_FONT_SIZE, { cols: terminal.cols, rows: terminal.rows }, cell, content);
      if (next === null) return;
      terminal.options.fontSize = next;
      calibrateAccessibilityMetrics();
      requestAnimationFrame(() => applyZoom(passesLeft - 1));
    };
    let resizeFrame: number | undefined;
    let lastSize = { cols: 0, rows: 0 };
    const resize = (force = false) => {
      if (!activeRef.current) return;
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (!activeRef.current) return;
        applyZoom();
        const dims = announcedGrid();
        if (!dims) return;
        // A tap is an interaction: force the announce so the host applies
        // this phone's size to the PTY grid in a TUI period even when the
        // terminal's own size did not change. Unforced announces (layout
        // observers) send only on a real change.
        if (force || shouldSendResize(dims.cols, dims.rows, lastSize)) {
          lastSize = { cols: dims.cols, rows: dims.rows };
          syncDebug(`resize session=${session.id} cols=${dims.cols} rows=${dims.rows}`);
          connection.send({ type: "session.resize", sessionId: session.id, cols: dims.cols, rows: dims.rows });
        }
      });
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(() => resize());
    observer.observe(hostElement);
    // Keyboard focus follows a committed tap only. pointerdown fires at the
    // start of every gesture - including the first moment of a swipe and of
    // a hold - and focusing the IME field is what pops the Android soft
    // keyboard, so record the candidate here and commit on pointer-up only
    // while the gesture still reads as a tap. Touch gestures commit through
    // the touch handlers (they own the long-press timer); mouse taps commit
    // here.
    let pendingTap: { pointerId: number; x: number; y: number; at: number; type: string } | undefined;
    const handlePointerActivity = (event: PointerEvent) => {
      if (!activeRef.current || !(event.target instanceof Node) || !hostElement.contains(event.target)) return;
      pendingTap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), type: event.pointerType };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const tap = pendingTap;
      pendingTap = undefined;
      // Touch pointers are tracked again by the touch handlers, which own
      // the long-press timer and commit their own taps.
      if (!tap || tap.pointerId !== event.pointerId || tap.type === "touch") return;
      if (!commitTapOnGestureEnd({
        pointerType: tap.type,
        movePx: Math.hypot(event.clientX - tap.x, event.clientY - tap.y),
        durationMs: performance.now() - tap.at
      })) return;
      // Keep tap-to-refit, but do not turn the tap into cursor-key input.
      // PSReadLine treats those synthetic arrows as editing commands and can
      // ring the bell or corrupt the first real key at a line boundary.
      applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: true }));
      resize(true);
    };
    const handlePointerCancel = (event: PointerEvent) => {
      // The platform took the gesture away; it can never still be a tap.
      if (pendingTap?.pointerId === event.pointerId) pendingTap = undefined;
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    const textarea = terminal.textarea;
    // Disable the IME's remembered text/autofill behavior. Android keyboards
    // otherwise keep a history in the textarea and replay it on backspace or
    // the first character after focus.
    textarea?.setAttribute("autocomplete", "off");
    textarea?.setAttribute("autocorrect", "off");
    textarea?.setAttribute("autocapitalize", "off");
    textarea?.setAttribute("readonly", "true");
    textarea?.setAttribute("tabindex", "-1");
    textarea?.setAttribute("aria-hidden", "true");
    // Keyboard input is owned by the dedicated IME field below. Keeping
    // xterm's textarea in the hit/focus path makes a terminal tap blur the IME
    // field and briefly dismiss Android's keyboard.
    if (textarea) textarea.style.display = "none";
    // Android WebViews may produce both an xterm key event and a native IME
    // event for one key, or only the native event. Hold xterm events briefly so
    // the native event can claim the input and prevent duplicate/phantom keys.
    const pendingTerminalInput: TimedTerminalInput[] = [];
    const pendingNativeInput: TimedTerminalInput[] = [];
    let nativeInputTimer: number | undefined;
    let terminalInputTimer: number | undefined;
    let lastNativeBeforeInput: { data: string; at: number } | undefined;
    const sendInput = (data: string) => {
      if (!data || !activeRef.current) return;
      // Every input carries the sender's viewport: in a TUI period the
      // client that is typing owns the grid and the host applies it at
      // once (canonical mode keeps the minimum boundary - typing never
      // resizes the shell).
      const dims = announcedGrid();
      const result = keyPadRef.current!.consume(data);
      syncKeyPad();
      if (result.data) connection.send({ type: "session.input", sessionId: session.id, data: result.data, cols: dims?.cols, rows: dims?.rows });
    };
    const flushPendingInput = () => {
      nativeInputTimer = undefined;
      terminalInputTimer = undefined;
      if (!activeRef.current) {
        pendingNativeInput.length = 0;
        pendingTerminalInput.length = 0;
        lastNativeBeforeInput = undefined;
        return;
      }
      const now = performance.now();

      for (const native of pendingNativeInput.splice(0)) {
        sendInput(claimNativeInput(native, pendingTerminalInput));
      }

      for (let index = pendingTerminalInput.length - 1; index >= 0; index -= 1) {
        const pending = pendingTerminalInput[index];
        if (pending && now - pending.at >= 35) {
          pendingTerminalInput.splice(index, 1);
          sendInput(pending.data);
        }
      }
      if (pendingNativeInput.length || pendingTerminalInput.length) {
        terminalInputTimer = window.setTimeout(flushPendingInput, 40);
      }
    };
    const queueNativeInput = (data: string) => {
      if (!data || !activeRef.current) return;
      pendingNativeInput.push({ data, at: performance.now() });
      if (nativeInputTimer !== undefined) return;
      nativeInputTimer = window.setTimeout(flushPendingInput, 20);
    };
    const queueTerminalInput = (data: string) => {
      if (!data || !activeRef.current) return;
      pendingTerminalInput.push({ data, at: performance.now() });
      if (terminalInputTimer === undefined) terminalInputTimer = window.setTimeout(flushPendingInput, 40);
    };
    const applyPhysicalModifiers = (data: string, event: KeyboardEvent) => {
      const modifiers = new Set<TerminalModifier>();
      if (event.ctrlKey) modifiers.add("ctrl");
      if (event.altKey) modifiers.add("alt");
      if (event.shiftKey) modifiers.add("shift");
      return applyTerminalModifiers(data, modifiers);
    };
    const handleNativeKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      const directInput = mobileTerminalKeydownInput(event);
      if (directInput) {
        event.preventDefault();
        queueTerminalInput(applyPhysicalModifiers(directInput, event));
      }
      if (event.keyCode !== 229 || event.isComposing) return;
      const valueBeforeKey = inputElement.value;
      window.setTimeout(() => {
        if (!activeRef.current || inputElement.value === valueBeforeKey) return;
        const valueAfterKey = inputElement.value;
        const data = valueAfterKey.startsWith(valueBeforeKey)
          ? valueAfterKey.slice(valueBeforeKey.length)
          : valueAfterKey;
        if (data) queueTerminalInput(data);
        inputElement.value = "";
      }, 0);
    };
    let initialized = false;
    const input = terminal.onData((data) => {
      if (isCursorPositionReport(data)) {
        // A replayed buffer can contain a CPR query for which the shell is
        // still waiting. Forward the xterm reply even during attach replay;
        // the desktop tracks outstanding CPR queries and rejects duplicates
        // from already-serviced history before they reach the shell.
        connection.send({ type: "session.input", sessionId: session.id, data });
        return;
      }
      if (activeRef.current) {
        connection.send({ type: "session.input", sessionId: session.id, data });
      }
    });
    const handleNativeBeforeInput = (event: Event) => {
      if (!activeRef.current) return;
      const inputEvent = event as InputEvent;
      const data = nativeTerminalInput(inputEvent, inputElement.value);
      if (!data || inputEvent.inputType === "insertCompositionText") return;
      lastNativeBeforeInput = { data, at: performance.now() };
      if (inputEvent.cancelable) event.preventDefault();
      queueNativeInput(data);
      if (inputEvent.cancelable) inputElement.value = "";
    };
    const handleNativeInput = (event: Event) => {
      if (!activeRef.current) return;
      const inputEvent = event as InputEvent;
      const now = performance.now();
      const data = nativeTerminalInput(inputEvent, inputElement.value);
      if (!data) return;
      if (lastNativeBeforeInput && now - lastNativeBeforeInput.at <= 120 && lastNativeBeforeInput.data === data) {
        lastNativeBeforeInput = undefined;
        if (!inputEvent.isComposing) window.setTimeout(() => { inputElement.value = ""; }, 0);
        return;
      }
      queueNativeInput(data);
      // Clear after the event chain has completed so xterm's composition
      // handler can read committed text, but Android cannot retain it for the
      // next character/backspace operation.
      if (!inputEvent.isComposing) window.setTimeout(() => { inputElement.value = ""; }, 0);
    };
    const handleCompositionEnd = (event: Event) => {
      const composition = event as CompositionEvent;
      const data = composition.data;
      if (data) {
        lastNativeBeforeInput = { data, at: performance.now() };
        queueNativeInput(data);
      }
      window.setTimeout(() => { inputElement.value = ""; }, 0);
    };
    inputElement.addEventListener("keydown", handleNativeKeyDown);
    inputElement.addEventListener("beforeinput", handleNativeBeforeInput, true);
    inputElement.addEventListener("input", handleNativeInput);
    inputElement.addEventListener("compositionend", handleCompositionEnd);
    // Every chunk carries its absolute offset in the host PTY stream. The
    // emulator tracks the stream position it has applied up to (`appliedUpTo`)
    // so chunks that are already inside a replayed journal snapshot are
    // dropped instead of double-printed: this is what makes attach racing /
    // reconnect catch-up lossless without deduplication heuristics.
    // Every chunk carries its absolute offset in the host PTY stream; grid
    // changes carry the offset where they took effect. The emulator tracks
    // the stream position it has applied up to (`appliedUpTo`) so chunks and
    // grid epochs already inside a replayed snapshot are dropped instead of
    // double-applied: this is what makes attach racing / reconnect catch-up
    // lossless across focus-driven grid switches.
    const pendingOutput: Array<
      | { kind: "data"; data: string; offset: number }
      | { kind: "grid"; cols: number; rows: number; offset: number }
    > = [];
    let replayingSessionBuffer = false;
    let appliedUpTo = 0;
    const applyItem = (item: { kind: "data"; data: string; offset: number } | { kind: "grid"; cols: number; rows: number; offset: number }) => {
      if (item.kind === "grid") {
        // A grid change is never "covered" by anything but an equal grid
        // state: offsets only dedupe DATA chunks. Live clients must follow
        // every grid epoch even when stream offsets have advanced past it.
        if (item.cols !== terminal.cols || item.rows !== terminal.rows) {
          terminal.resize(item.cols, item.rows);
          applyZoom();
          calibrateAccessibilityMetrics();
          syncDebug(`grid session=${session.id} cols=${item.cols} rows=${item.rows} off=${item.offset} reflow`);
        } else {
          syncDebug(`grid session=${session.id} cols=${item.cols} rows=${item.rows} off=${item.offset} same-grid skip`);
        }
        return;
      }
      if (item.offset < appliedUpTo) {
        syncDebug(`out session=${session.id} off=${item.offset} len=${streamByteLength(item.data)} skipped(already covered upTo=${appliedUpTo})`);
        return;
      }
      appliedUpTo = Math.max(appliedUpTo, item.offset + streamByteLength(item.data));
      syncDebug(`out session=${session.id} off=${item.offset} len=${streamByteLength(item.data)} upTo=${appliedUpTo}`);
      terminal.write(item.data);
    };
    const output = connection.on("output", (event) => {
      if (event.sessionId !== session.id) return;
      if (replayingSessionBuffer || !initialized) {
        pendingOutput.push({ kind: "data", data: event.data, offset: event.offset });
        return;
      }
      applyItem({ kind: "data", data: event.data, offset: event.offset });
    });
    const gridChange = connection.on("grid", (event) => {
      if (event.sessionId !== session.id) return;
      if (replayingSessionBuffer || !initialized) {
        pendingOutput.push({ kind: "grid", cols: event.cols, rows: event.rows, offset: event.offset });
        return;
      }
      applyItem({ kind: "grid", cols: event.cols, rows: event.rows, offset: event.offset });
    });
    // TUI mode from the host: classification only - it no longer changes
    // the sizing or render path (the client follows the host grid in every
    // mode). The journaled alt-screen isolation still applies per segment.
    const modeChange = connection.on("mode", (event) => {
      if (event.sessionId !== session.id) return;
      syncDebug(`mode session=${session.id} mode=${event.mode} off=${event.offset}`);
    });
    const connected = connection.on("connected", () => {
      // Reconnects re-attach only while the terminal page is the active
      // view: a background page must stay out of the host's viewport set.
      if (!activeRef.current) return;
      syncDebug(`connected session=${session.id} -> re-attach`);
      startAttachment();
    });

    const screen = hostElement.querySelector<HTMLElement>(".xterm-screen");
    let activeTouchId: number | undefined;
    let previousTouchY: number | undefined;
    let touchStartX: number | undefined;
    let touchStartY: number | undefined;
    let touchMoved = false;
    let touchAxis: GestureAxis = "pending";
    let selectionGesture = false;
    let scrollbarGesture = false;
    let longPressTimer: number | undefined;
    const findTouch = (touches: TouchList, identifier: number) => {
      for (let index = 0; index < touches.length; index += 1) {
        const touch = touches.item(index);
        if (touch?.identifier === identifier) return touch;
      }
      return undefined;
    };
    const resetTouch = () => {
      activeTouchId = undefined;
      previousTouchY = undefined;
      touchStartX = undefined;
      touchStartY = undefined;
      touchMoved = false;
      touchAxis = "pending";
      selectionGesture = false;
      scrollbarGesture = false;
    };
    const clearLongPressTimer = () => {
      if (longPressTimer !== undefined) window.clearTimeout(longPressTimer);
      longPressTimer = undefined;
    };
    const clearTouchSelection = () => {
      if (terminal.hasSelection()) terminal.clearSelection();
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && (selection.anchorNode === hostElement || hostElement.contains(selection.anchorNode))) {
        selection.removeAllRanges();
      }
    };
    const hasNativeSelection = () => {
      const selection = document.getSelection();
      return Boolean(selection && !selection.isCollapsed && selection.anchorNode && hostElement.contains(selection.anchorNode));
    };
    const selectWordAtTouch = (clientX: number, clientY: number) => {
      if (!activeRef.current) return false;
      const target = document.elementFromPoint(clientX, clientY);
      if (!(target instanceof Element) || !target.closest(".xterm-accessibility-tree")) return false;

      const documentWithCaret = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      const caret = documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
      const caretPosition = caret?.startContainer instanceof Text
        ? undefined
        : documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
      const position = caret?.startContainer instanceof Text
        ? { container: caret.startContainer, offset: caret.startOffset }
        : caretPosition
          ? { container: caretPosition.offsetNode, offset: caretPosition.offset }
          : undefined;
      if (!position || !(position.container instanceof Text)) return false;

      const text = position.container.textContent ?? "";
      if (!text.length) return false;
      let offset = Math.max(0, Math.min(position.offset, text.length - 1));
      const isWordCharacter = (character: string) => /\S/.test(character);
      if (!isWordCharacter(text[offset] ?? "") && offset > 0) offset -= 1;
      let start = offset;
      let end = Math.min(text.length, offset + 1);
      if (isWordCharacter(text[offset] ?? "")) {
        while (start > 0 && isWordCharacter(text[start - 1] ?? "")) start -= 1;
        while (end < text.length && isWordCharacter(text[end] ?? "")) end += 1;
      }
      if (end <= start) return false;

      const selection = document.getSelection();
      if (!selection) return false;
      const range = document.createRange();
      range.setStart(position.container, start);
      range.setEnd(position.container, end);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (!activeRef.current) {
        resetTouch();
        return;
      }
      if (event.touches.length !== 1) {
        resetTouch();
        return;
      }
      const touch = event.touches.item(0);
      if (!touch) return;
      // No focus here: a touchdown is the start of a gesture that may turn
      // out to be a swipe or a hold, and focusing the IME field is what
      // pops the soft keyboard. A committed tap focuses on touchend.
      activeTouchId = touch.identifier;
      previousTouchY = touch.clientY;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchMoved = false;
      touchAxis = "pending";
      selectionGesture = terminal.hasSelection();
      scrollbarGesture = event.target instanceof Element && Boolean(event.target.closest(".scrollbar.vertical"));
      clearLongPressTimer();
      if (!selectionGesture && !scrollbarGesture) {
        longPressTimer = window.setTimeout(() => {
          longPressTimer = undefined;
          if (activeRef.current && activeTouchId === touch.identifier && !touchMoved && !terminal.hasSelection() && selectWordAtTouch(touch.clientX, touch.clientY)) {
            selectionGesture = true;
          }
        }, 500);
      }
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (!activeRef.current) {
        clearLongPressTimer();
        resetTouch();
        return;
      }
      if (activeTouchId === undefined || previousTouchY === undefined) return;
      const touch = findTouch(event.touches, activeTouchId);
      if (!touch) return;
      if (scrollbarGesture) return;
      const deltaX = touchStartX === undefined ? 0 : touch.clientX - touchStartX;
      const totalDeltaY = touchStartY === undefined ? 0 : touch.clientY - touchStartY;
      const deltaY = touch.clientY - previousTouchY;
      if (touchAxis === "pending") {
        // Lock intent once using total movement. A small accumulated sideways
        // drift must not turn a vertical terminal scroll into page navigation.
        touchAxis = classifyGestureAxis(deltaX, totalDeltaY);
      }
      if (touchAxis !== "pending" && !touchMoved) {
        touchMoved = true;
        clearLongPressTimer();
      }
      if (touchAxis === "pending") return;
      if (touchAxis === "horizontal") {
        // A drag that starts on the accessibility text can otherwise leave a
        // native/xterm selection behind, disabling the next long-press word
        // selection. Horizontal page navigation owns this gesture, except
        // when the user is dragging an existing native selection handle.
        if (!selectionGesture && !terminal.hasSelection() && !hasNativeSelection()) clearTouchSelection();
        previousTouchY = touch.clientY;
        return;
      }
      if (selectionGesture || terminal.hasSelection()) return;
      previousTouchY = touch.clientY;
      if (Math.abs(deltaY) < 0.5) return;

      event.preventDefault();
      screen?.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaMode: 0,
        deltaY: deltaY * MOBILE_SCROLL_SENSITIVITY
      }));
    };
    const handleTouchEnd = (event: TouchEvent) => {
      if (!activeRef.current) {
        clearLongPressTimer();
        resetTouch();
        return;
      }
      if (activeTouchId === undefined) return resetTouch();
      const ended = event.changedTouches.item(0);
      // Only a committed tap may bring up the keyboard. The long-press timer
      // still pending means the finger stayed put and was released inside
      // the hold window: a fired timer was a word-selection hold and a
      // cleared one a swipe.
      const wasTap = ended?.identifier === activeTouchId && commitTapOnGestureEnd({
        pointerType: "touch",
        movePx: ended ? Math.hypot(ended.clientX - (touchStartX ?? 0), ended.clientY - (touchStartY ?? 0)) : 0,
        durationMs: 0,
        touchLongPressPending: longPressTimer !== undefined
      });
      clearLongPressTimer();
      if (touchAxis === "horizontal" && !selectionGesture && !terminal.hasSelection() && !hasNativeSelection()) clearTouchSelection();
      resetTouch();
      if (wasTap) {
        applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: true }));
        resize(true);
      }
    };
    const handleTouchCancel = () => {
      clearLongPressTimer();
      if (touchAxis === "horizontal" && !selectionGesture && !terminal.hasSelection() && !hasNativeSelection()) clearTouchSelection();
      resetTouch();
    };
    hostElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    hostElement.addEventListener("touchmove", handleTouchMove, { passive: false });
    hostElement.addEventListener("touchend", handleTouchEnd, { passive: true });
    hostElement.addEventListener("touchcancel", handleTouchCancel, { passive: true });

    const finishAttachment = () => {
      if (disposed) return;
      initialized = true;
      applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: false }));
    };
    const replayPendingOutput = (index = 0) => {
      if (disposed) return;
      const item = pendingOutput[index];
      if (item === undefined) {
        pendingOutput.length = 0;
        finishAttachment();
        return;
      }
      if (item.kind === "grid") {
        // Grid notices are applied whenever the grid differs from the
        // emulator's current one; snapshot epochs already contained in the
        // replayed segments result in a same-grid no-op, stale ones cannot
        // corrupt anything because the call is idempotent per grid state.
        // cols is the announced host grid, so the accessibility squish is
        // recalibrated against the columns actually rendered.
        if (item.cols !== terminal.cols || item.rows !== terminal.rows) {
          terminal.resize(item.cols, item.rows);
          applyZoom();
          calibrateAccessibilityMetrics();
          syncDebug(`pend grid session=${session.id} cols=${item.cols} rows=${item.rows} off=${item.offset} reflow`);
        }
        replayPendingOutput(index + 1);
        return;
      }
      if (item.offset < appliedUpTo) {
        // Already covered by the journal snapshot; drop it.
        syncDebug(`pend session=${session.id} off=${item.offset} skipped(covered upTo=${appliedUpTo})`);
        replayPendingOutput(index + 1);
        return;
      }
      appliedUpTo = Math.max(appliedUpTo, item.offset + streamByteLength(item.data));
      syncDebug(`pend session=${session.id} off=${item.offset} len=${streamByteLength(item.data)} upTo=${appliedUpTo}`);
      terminal.write(item.data, () => replayPendingOutput(index + 1));
    };
    let attachmentPromise: Promise<unknown> | undefined;
    const startAttachment = () => {
      // Runs on mount and again on every reconnect: the host journal is the
      // source of truth, so the emulator resets and replays the full stream
      // segmented by grid epochs. Live output and grid changes received
      // during that window are queued and merged exactly after the snapshot
      // ends (offsets make the merge precise across grid switches).
      if (disposed || attachmentPromise !== undefined) return;
      initialized = false;
      replayingSessionBuffer = false;
      pendingOutput.length = 0;
      appliedUpTo = 0;
      const attachDims = announcedGrid() ?? { cols: terminal.cols, rows: terminal.rows };
      syncDebug(`attach send session=${session.id} cols=${attachDims.cols} rows=${attachDims.rows}`);
      connection.request({
        type: "session.attach",
        requestId: createRequestId(),
        sessionId: session.id,
        cols: attachDims.cols,
        rows: attachDims.rows
      }).then((message) => {
        attachmentPromise = undefined;
        if (disposed) return;
        if (message.type !== "session.buffer") {
          syncDebug(`attach session=${session.id} replied ${message.type}`);
          pendingOutput.length = 0;
          finishAttachment();
          return;
        }
        terminal.reset();
        replayingSessionBuffer = true;
        const segments = message.segments;
        syncDebug(`buffer session=${session.id} end=${message.endOffset} segs=${segments.map((s) => `${s.cols}x${s.rows}+${s.data.length}`).join(" ")}`);
        const writeNext = (index = 0) => {
          if (disposed) return;
          const segment = segments[index];
          if (segment === undefined) {
            replayingSessionBuffer = false;
            appliedUpTo = Math.max(appliedUpTo, message.endOffset);
            applyZoom();
            calibrateAccessibilityMetrics();
            syncDebug(`replay done session=${session.id} upTo=${appliedUpTo} pending=${pendingOutput.length}`);
            replayPendingOutput();
            return;
          }
          // Under minimum-boundary sizing every segment renders at its
          // recorded grid: the journal replays 1:1, never re-wrapped at
          // this client's own size.
          if (segment.cols !== terminal.cols || segment.rows !== terminal.rows) {
            terminal.resize(segment.cols, segment.rows);
            applyZoom();
          }
          terminal.write(segment.data, () => writeNext(index + 1));
        };
        writeNext();
      }).catch((cause) => {
        attachmentPromise = undefined;
        syncDebug(`attach session=${session.id} failed: ${String(cause)}`);
        if (!disposed) terminal.write(`\r\n\x1b[31mCould not attach terminal: ${String(cause)}\x1b[0m\r\n`);
      });
    };
    // Attachment and viewport keepalive follow the visible view (see the
    // active-gating effect below), not the mount lifecycle: the pager keeps
    // this page mounted after the user leaves the terminal, and an attached,
    // pinging page would keep the phone in the host's viewport set S with
    // stale dimensions - the PTY would never un-clamp after an exit.
    // The machine is created inside the font-preload gate, so hand the
    // owner over AND start when the view is already active: the gating
    // effect below can run before the fonts resolve (its ref is still the
    // initial no-op), which would otherwise leave the terminal blank.
    startAttachmentRef.current = startAttachment;
    if (activeRef.current) startAttachment();
    const statsTimer = window.setInterval(() => {
      if (disposed || !terminalRef.current) return;
      const buffer = terminal.buffer.active;
      syncDebug(`stats session=${session.id} grid=${terminal.cols}x${terminal.rows} bufferLines=${buffer.length} baseY=${buffer.baseY} viewport=${buffer.viewportY}`);
    }, 5_000);
      cleanup = () => {
      disposed = true;
      startAttachmentRef.current = () => undefined;
      void (attachmentPromise ?? Promise.resolve())
        .finally(() => connection.send({ type: "session.detach", requestId: createRequestId(), sessionId: session.id }))
        .catch(() => undefined);
      connection.stopViewportKeepalive();
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("pointerdown", handlePointerActivity, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      inputElement.removeEventListener("keydown", handleNativeKeyDown);
      inputElement.removeEventListener("beforeinput", handleNativeBeforeInput, true);
      inputElement.removeEventListener("input", handleNativeInput);
      inputElement.removeEventListener("compositionend", handleCompositionEnd);
      if (nativeInputTimer !== undefined) window.clearTimeout(nativeInputTimer);
      if (terminalInputTimer !== undefined) window.clearTimeout(terminalInputTimer);
      hostElement.removeEventListener("touchstart", handleTouchStart);
      hostElement.removeEventListener("touchmove", handleTouchMove);
      hostElement.removeEventListener("touchend", handleTouchEnd);
      hostElement.removeEventListener("touchcancel", handleTouchCancel);
      clearLongPressTimer();
      if (statsTimer !== undefined) window.clearInterval(statsTimer);
      connected(); gridChange(); modeChange(); input.dispose(); output(); httpLinkProvider.dispose(); terminal.dispose(); terminalRef.current = null;
      resizeRef.current = () => undefined;
      focusInputRef.current = () => undefined;
      activateCursorRef.current = () => undefined;
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [connection, session.id]);

  // Set S membership follows the visible view. The pager keeps this page
  // mounted (for swipe-back) after the user leaves the terminal view, so the
  // attach + viewport keepalive run only while the terminal page is the
  // active page: leaving detaches (or the keepalive would keep the phone in
  // the host's viewport set S with stale dimensions and the PTY would never
  // reset), and returning re-attaches and replays the journal (§4.2 rejoin).
  // Foregrounding the app also re-attaches: the host's 2 s watchdog evicts
  // the viewport while the app is hidden, and a bare keepalive restart never
  // re-registers it.
  useEffect(() => {
    if (!active) {
      connection.stopViewportKeepalive();
      connection.send({ type: "session.detach", requestId: createRequestId(), sessionId: session.id });
      return;
    }
    startAttachmentRef.current();
    connection.startViewportKeepalive();
    const handleVisibility = () => {
      if (document.hidden) {
        connection.stopViewportKeepalive();
      } else {
        connection.startViewportKeepalive();
        startAttachmentRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [active, connection, session.id]);

  useLayoutEffect(() => {
    // Adjusting the character-width slider changes this value on every tick
    // while the settings sheet is up. Re-announce so the squished columns
    // stay correct, but never steal focus from the sheet: refocusing the IME
    // field would pop Android's keyboard over the overlay.
    if (activeRef.current) resizeRef.current();
  }, [fontWidthScale]);

  // Repaint a live terminal when the shared scheme changes, so switching this
  // phone between light and dark (or the desktop picking another scheme)
  // recolors the open session instead of waiting for a fresh one.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = xtermThemeFor(scheme);
  }, [scheme]);

  useLayoutEffect(() => {
    if (!activeRef.current) {
      // Dropping a finger on a bare page change would otherwise keep a held
      // modifier engaged (and its chord alive) for the next session.
      applyKeyPadResult(keyPadRef.current!.reset());
      terminalRef.current?.clearSelection();
      const selection = document.getSelection();
      const hostElement = hostRef.current;
      if (selection && hostElement && !selection.isCollapsed && (selection.anchorNode === hostElement || hostElement.contains(selection.anchorNode))) {
        selection.removeAllRanges();
      }
      deactivateTerminalCursor(terminalRef.current?.textarea ?? null);
      terminalRef.current?.blur();
      inputRef.current?.blur();
      return;
    }
    // Entering the view must not open the soft keyboard (see
    // terminalFocus.ts): keep the cursor cell live without focusing the
    // IME field, re-asserted once after a fast swipe's pointer-up cycle
    // has settled. Taps on the terminal or a utility key are explicit input
    // gestures, so they still focus the IME field and pop the keyboard.
    applyFocusAction(terminalFocusAction({ active: true, explicitInput: false }));
    const cursorFrame = window.requestAnimationFrame(() => {
      applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: false }));
    });
    resizeRef.current();
    return () => window.cancelAnimationFrame(cursorFrame);
  }, [active]);

  function pressAccessibilityKey(key: UtilityKey) {
    if (!activeRef.current) return;
    // Tapping a non-modifier key fires a chord, so give a quick buzz;
    // modifiers only arm and wait, so they stay silent.
    if (!key.modifier) vibrate();
    applyKeyPadResult(keyPadRef.current!.press(key));
    applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: true }));
  }

  function releaseAccessibilityKey(key: UtilityKey) {
    if (!activeRef.current) return;
    applyKeyPadResult(keyPadRef.current!.release(key.id));
    applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: true }));
  }

  function cancelAccessibilityKey(key: UtilityKey) {
    if (!activeRef.current) return;
    // The platform took the gesture away (the finger slid off the key and
    // started scrolling or a system gesture): no pointerup will ever
    // arrive for that pointer. The key must not outlive the finger, so a
    // cancel ends with the same end-state as a release.
    applyKeyPadResult(keyPadRef.current!.cancel(key.id));
    applyFocusAction(terminalFocusAction({ active: activeRef.current, explicitInput: true }));
  }

  const currentFontSize = terminalRef.current?.options.fontSize ?? TERMINAL_FONT_SIZE;
  const squishFontSize = calibratedSquishFontSize(currentFontSize, fontWidthScale, a11yAdvanceRatioRef.current);
  const squishLineHeight = squishLineHeightValue(fontWidthScale);
  const squishInverse = squishInverseValue(fontWidthScale);
  return <div className="mobile-terminal-shell">
    <input ref={inputRef} className="mobile-terminal-input" type="text" inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-label="Terminal input" />
    <div ref={hostRef} className="mobile-terminal" style={{ width: squishWidthPercent(fontWidthScale), transform: `scaleX(${fontWidthScale})`, transformOrigin: "left center", "--terminal-bg": scheme.background, "--terminal-squish-font-size": squishFontSize, "--terminal-squish-line-height": squishLineHeight, "--terminal-squish-inverse": `${squishInverse}` } as CSSProperties} />
    <div className="extra-keys" data-no-swipe aria-label="Terminal function keys" ref={(element) => guardUtilityKeySelection(element)}>
      {ACCESSIBILITY_KEY_ROWS.map((row, rowIndex) => <div className="key-row" key={rowIndex}>{row.map((key) => {
        const latched = latchedKeyIds.has(key.id);
        const held = heldKeyIds.has(key.id);
        return <button
          key={key.id}
          type="button"
          aria-pressed={latched || held}
          className={`${latched ? "latched chord-pending" : ""}${held ? " held" : ""}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            pressAccessibilityKey(key);
          }}
          onPointerUp={() => releaseAccessibilityKey(key)}
          onPointerCancel={() => cancelAccessibilityKey(key)}
          onClick={(event) => {
            // Pointer taps are handled above. Keep keyboard activation accessible:
            // a keyboard click has detail 0 and no pointer hold, so press and
            // release in one activation.
            if (event.detail === 0) {
              if (!key.modifier) vibrate();
              applyKeyPadResult(keyPadRef.current!.press(key));
              applyKeyPadResult(keyPadRef.current!.release(key.id));
            }
          }}
        ><span>{key.label}</span></button>;
      })}</div>)}
    </div>
  </div>;
}
