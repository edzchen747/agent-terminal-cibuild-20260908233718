import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTerminalModifiers, createRequestId, findHttpLinks, TERMINAL_ANSI_THEME } from "@agentterminal/protocol";
import type { TerminalModifier, TerminalSession } from "@agentterminal/protocol";
import type { HostConnection } from "./connection";
import { classifyGestureAxis, type GestureAxis } from "./gesture";
import { claimNativeInput, isCursorPositionReport, mobileTerminalKeydownInput, nativeTerminalInput } from "./terminalInput";
import type { TimedTerminalInput } from "./terminalInput";
import { shouldSendResize } from "./terminalResize";
import { TERMINAL_FONT_SIZE, calibratedSquishFontSize, squishAdvanceRatio, squishInverse as squishInverseValue, squishLineHeight as squishLineHeightValue, squishWidthPercent } from "./terminalSquish";
import { TERMINAL_FONT_FAMILY, preloadTerminalFonts } from "./terminalFonts";
import { activateTerminalCursor, deactivateTerminalCursor } from "./terminalCursor";
import { guardUtilityKeySelection } from "./utilityKeySelection";
import { createUtilityKeyPad, MODIFIER_HOLD_THRESHOLD_MS, type KeyPadResult, type UtilityKey } from "./utilityKeys";
import { systemHoldThresholdMs } from "./systemMetrics";
import "@xterm/xterm/css/xterm.css";

interface Props { connection: HostConnection; session: TerminalSession; active: boolean; fontWidthScale: number; }

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

export function MobileTerminal({ connection, session, active, fontWidthScale }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const fontWidthScaleRef = useRef(fontWidthScale);
  fontWidthScaleRef.current = fontWidthScale;
  const a11yAdvanceRatioRef = useRef<number | undefined>(undefined);
  const resizeRef = useRef<(force?: boolean) => void>(() => undefined);
  const focusInputRef = useRef<() => void>(() => undefined);
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

  const sendKeyData = (data: string) => {
    if (!data || !activeRef.current) return;
    // Mirror the desktop write path, which reasserts its size with every
    // key. Force it: a plain resize sends nothing when the local fit is
    // unchanged, leaving the host at another client's PTY size.
    focusInputRef.current();
    resizeRef.current(true);
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
      const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: 1,
      scrollback: 5000,
      screenReaderMode: true,
      smoothScrollDuration: 75,
      theme: {
        // The same Windows Terminal "Campbell" palette the desktop terminal
        // uses, so the same session renders identically on every client.
        background: "#0C0C0C",
        foreground: "#CCCCCC",
        cursor: "#FFFFFF",
        cursorAccent: "#0C0C0C",
        selectionBackground: "#315b64aa",
        ...TERMINAL_ANSI_THEME
      }
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
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
    if (activeRef.current) focusInput();
    fit.fit();

    // The accessibility layer's rows must paint and anchor at the same advance
    // the squished canvas cells have. Rather than trusting the font metrics to
    // scale linearly between the canvas measurement and the screen-reader
    // layer, measure what this WebView actually reports: xterm paints the
    // accessibility container at cellWidth * cols (its own css-pixel cell
    // size), and a mirror span inside the accessibility tree yields the real
    // DOM advance at the base font size. The ratio reconciles the two so the
    // squished font size lands every accessibility character on its canvas
    // cell, whatever face or rounding the WebView applies to the layer.
    const calibrateAccessibilityMetrics = () => {
      const a11y = hostElement.querySelector<HTMLElement>(".xterm-accessibility");
      const tree = hostElement.querySelector<HTMLElement>(".xterm-accessibility-tree");
      if (!a11y || !tree || terminal.cols <= 0) return;
      const containerWidth = Number.parseFloat(a11y.style.width);
      if (!(containerWidth > 0)) return;
      const cellWidth = containerWidth / terminal.cols;
      const mirror = document.createElement("span");
      mirror.className = "xterm-char-measure-element";
      mirror.style.fontFamily = TERMINAL_FONT_FAMILY;
      mirror.style.fontSize = `${TERMINAL_FONT_SIZE}px`;
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
      hostElement.style.setProperty("--terminal-squish-font-size", calibratedSquishFontSize(fontWidthScaleRef.current, a11yAdvanceRatioRef.current));
    };
    calibrateAccessibilityMetrics();

    let resizeFrame: number | undefined;
    let forceResizePending = false;
    let lastSize = { cols: 0, rows: 0 };
    const resize = (force = false) => {
      if (!activeRef.current) {
        if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
        resizeFrame = undefined;
        forceResizePending = false;
        return;
      }
      if (force) {
        if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
        resizeFrame = undefined;
        forceResizePending = false;
        try {
          fit.fit();
          calibrateAccessibilityMetrics();
          if (shouldSendResize(true, terminal.cols, terminal.rows, lastSize)) {
            lastSize = { cols: terminal.cols, rows: terminal.rows };
            connection.send({ type: "session.resize", sessionId: session.id, cols: terminal.cols, rows: terminal.rows, force: true });
          }
        } catch {
          // The WebView can report an intermediate zero-sized layout while the keyboard opens.
        }
        return;
      }
      forceResizePending ||= force;
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (!activeRef.current) {
          forceResizePending = false;
          return;
        }
        const shouldForce = forceResizePending;
        forceResizePending = false;
        try {
          fit.fit();
          calibrateAccessibilityMetrics();
          if (shouldSendResize(shouldForce, terminal.cols, terminal.rows, lastSize)) {
            lastSize = { cols: terminal.cols, rows: terminal.rows };
            connection.send({ type: "session.resize", sessionId: session.id, cols: terminal.cols, rows: terminal.rows, force: shouldForce });
          }
        } catch {
          // The WebView can report an intermediate zero-sized layout while the keyboard opens.
        }
      });
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(() => resize());
    observer.observe(hostElement);
    const handlePointerActivity = (event: PointerEvent) => {
      if (!activeRef.current || !(event.target instanceof Node) || !hostElement.contains(event.target)) return;
      // Keep tap-to-refit, but do not turn the tap into cursor-key input.
      // PSReadLine treats those synthetic arrows as editing commands and can
      // ring the bell or corrupt the first real key at a line boundary.
      focusInput();
      resize(true);
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
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
      // The desktop write path attaches its cols/rows to every key, so the
      // host reasserts that client's size on every input. Remote input
      // carries no size, so force a session.resize on each key; a plain
      // resize would send nothing while our local fit is unchanged and the
      // host would keep another client's (or a lost) PTY size.
      resize(true);
      const result = keyPadRef.current!.consume(data);
      syncKeyPad();
      if (result.data) connection.send({ type: "session.input", sessionId: session.id, data: result.data });
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
        // Force, like every other input path, so the host reasserts this
        // client's size even when the local fit has not changed.
        resize(true);
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
    const pendingOutput: string[] = [];
    const output = connection.on("output", (event) => {
      if (event.sessionId !== session.id) return;
      if (initialized) terminal.write(event.data);
      else pendingOutput.push(event.data);
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
      focusInputRef.current();
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
        deltaY
      }));
    };
    const handleTouchEnd = () => {
      if (!activeRef.current) {
        clearLongPressTimer();
        resetTouch();
        return;
      }
      if (activeTouchId === undefined) return resetTouch();
      clearLongPressTimer();
      if (touchAxis === "horizontal" && !selectionGesture && !terminal.hasSelection() && !hasNativeSelection()) clearTouchSelection();
      resetTouch();
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
      resize();
      if (activeRef.current) focusInput();
    };
    const replayPendingOutput = (index = 0) => {
      if (disposed) return;
      const data = pendingOutput[index];
      if (data === undefined) {
        pendingOutput.length = 0;
        finishAttachment();
        return;
      }
      terminal.write(data, () => replayPendingOutput(index + 1));
    };
    const attachment = connection.request({ type: "session.attach", requestId: createRequestId(), sessionId: session.id, cols: terminal.cols, rows: terminal.rows }).then((message) => {
      if (disposed) return;
      if (message.type === "session.buffer") {
        terminal.write(message.data, () => {
          replayPendingOutput();
        });
      } else {
        replayPendingOutput();
      }
    }).catch((cause) => {
      if (!disposed) terminal.write(`\r\n\x1b[31mCould not attach terminal: ${String(cause)}\x1b[0m\r\n`);
    });
      cleanup = () => {
      disposed = true;
      void attachment.finally(() => connection.send({ type: "session.detach", requestId: createRequestId(), sessionId: session.id }));
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("pointerdown", handlePointerActivity, true);
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
      input.dispose(); output(); httpLinkProvider.dispose(); terminal.dispose(); terminalRef.current = null;
      resizeRef.current = () => undefined;
      focusInputRef.current = () => undefined;
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [connection, session.id]);

  useLayoutEffect(() => {
    // Adjusting the character-width slider changes this value on every tick
    // while the settings sheet is up. Refit so the squished columns stay
    // correct, but never steal focus from the sheet: refocusing the IME
    // field would pop Android's keyboard over the overlay.
    if (activeRef.current) resizeRef.current(true);
  }, [fontWidthScale]);

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
    // A fast pager swipe can leave the WebView's pointer-up processing with
    // focus on the page that was swiped from. Refocus once after that event
    // cycle has settled so the first terminal character is not dropped.
    focusInputRef.current();
    const focusFrame = window.requestAnimationFrame(() => {
      if (activeRef.current) focusInputRef.current();
    });
    resizeRef.current(true);
    return () => window.cancelAnimationFrame(focusFrame);
  }, [active]);

  function pressAccessibilityKey(key: UtilityKey) {
    if (!activeRef.current) return;
    // Tapping a non-modifier key fires a chord, so give a quick buzz;
    // modifiers only arm and wait, so they stay silent.
    if (!key.modifier) vibrate();
    applyKeyPadResult(keyPadRef.current!.press(key));
    focusInputRef.current();
  }

  function releaseAccessibilityKey(key: UtilityKey) {
    if (!activeRef.current) return;
    applyKeyPadResult(keyPadRef.current!.release(key.id));
    focusInputRef.current();
  }

  function cancelAccessibilityKey(key: UtilityKey) {
    if (!activeRef.current) return;
    // The platform took the gesture away (the finger slid off the key and
    // started scrolling or a system gesture): no pointerup will ever
    // arrive for that pointer. The key must not outlive the finger, so a
    // cancel ends with the same end-state as a release.
    applyKeyPadResult(keyPadRef.current!.cancel(key.id));
    focusInputRef.current();
  }

  const squishFontSize = calibratedSquishFontSize(fontWidthScale, a11yAdvanceRatioRef.current);
  const squishLineHeight = squishLineHeightValue(fontWidthScale);
  const squishInverse = squishInverseValue(fontWidthScale);
  return <div className="mobile-terminal-shell">
    <input ref={inputRef} className="mobile-terminal-input" type="text" inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-label="Terminal input" />
    <div ref={hostRef} className="mobile-terminal" style={{ width: squishWidthPercent(fontWidthScale), transform: `scaleX(${fontWidthScale})`, transformOrigin: "left center", "--terminal-squish-font-size": squishFontSize, "--terminal-squish-line-height": squishLineHeight, "--terminal-squish-inverse": `${squishInverse}` } as CSSProperties} />
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
