import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTerminalModifiers, createRequestId } from "@agentterminal/protocol";
import type { TerminalModifier, TerminalSession } from "@agentterminal/protocol";
import type { HostConnection } from "./connection";
import "@xterm/xterm/css/xterm.css";

interface Props { connection: HostConnection; session: TerminalSession; }

interface AccessibilityKey {
  id: string;
  label: string;
  modifier?: TerminalModifier;
  value?: string;
}

const ACCESSIBILITY_KEY_ROWS: AccessibilityKey[][] = [
  [
    { id: "ctrl", label: "Ctrl", modifier: "ctrl" },
    { id: "alt", label: "Alt", modifier: "alt" },
    { id: "shift", label: "Shift", modifier: "shift" },
    { id: "esc", label: "Esc", value: "\x1b" },
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
    { id: "word-right", label: "⌃→", value: "\x1b[1;5C" },
    { id: "backspace", label: "⌫", value: "\x7f" },
    { id: "enter", label: "Enter", value: "\r" }
  ]
];

export function MobileTerminal({ connection, session }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<(force?: boolean) => void>(() => undefined);
  const selectedKeysRef = useRef<AccessibilityKey[]>([]);
  const countdownTimerRef = useRef<number | undefined>(undefined);
  const [selectedKeyIds, setSelectedKeyIds] = useState<ReadonlySet<string>>(new Set());
  const [countdownVersion, setCountdownVersion] = useState(0);

  const activeModifiers = (keys = selectedKeysRef.current) => new Set(keys.flatMap((key) => key.modifier ? [key.modifier] : []));

  const clearSelectedKeys = () => {
    if (countdownTimerRef.current !== undefined) window.clearTimeout(countdownTimerRef.current);
    countdownTimerRef.current = undefined;
    selectedKeysRef.current = [];
    setSelectedKeyIds(new Set());
  };

  const executeChord = (keys: AccessibilityKey[]) => {
    const modifiers = activeModifiers(keys);
    const output = keys.flatMap((key) => key.value ? [applyTerminalModifiers(key.value, modifiers)] : []).join("");
    if (output) {
      resizeRef.current(true);
      connection.send({ type: "session.input", sessionId: session.id, data: output });
    }
  };

  const restartCountdown = (keys: AccessibilityKey[]) => {
    if (countdownTimerRef.current !== undefined) window.clearTimeout(countdownTimerRef.current);
    setCountdownVersion((version) => version + 1);
    if (!keys.length) {
      countdownTimerRef.current = undefined;
      return;
    }
    countdownTimerRef.current = window.setTimeout(() => {
      const pending = selectedKeysRef.current;
      if (pending.length > 1) executeChord(pending);
      clearSelectedKeys();
    }, 3000);
  };

  const consumeSelectedKeys = (value: string) => {
    const output = applyTerminalModifiers(value, activeModifiers());
    if (selectedKeysRef.current.length) clearSelectedKeys();
    return output;
  };

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Mono", "Roboto Mono", monospace',
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 5000,
      smoothScrollDuration: 75,
      theme: { background: "#080b0f", foreground: "#d7dce6", cursor: "#79ddc7", selectionBackground: "#315b64aa" }
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostElement);
    fit.fit();

    let resizeFrame: number | undefined;
    let forceResizePending = false;
    let lastSize = { cols: 0, rows: 0 };
    const resize = (force = false) => {
      if (force) {
        if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
        resizeFrame = undefined;
        forceResizePending = false;
        try {
          fit.fit();
          lastSize = { cols: terminal.cols, rows: terminal.rows };
          connection.send({ type: "session.resize", sessionId: session.id, cols: terminal.cols, rows: terminal.rows, force: true });
        } catch {
          // The WebView can report an intermediate zero-sized layout while the keyboard opens.
        }
        return;
      }
      forceResizePending ||= force;
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        const shouldForce = forceResizePending;
        forceResizePending = false;
        try {
          fit.fit();
          if (shouldForce || terminal.cols !== lastSize.cols || terminal.rows !== lastSize.rows) {
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
    const handlePointerActivity = () => resize(true);
    window.addEventListener("pointerdown", handlePointerActivity, true);
    const input = terminal.onData((data) => {
      resize(true);
      connection.send({ type: "session.input", sessionId: session.id, data: consumeSelectedKeys(data) });
    });
    let initialized = false;
    let disposed = false;
    const pendingOutput: string[] = [];
    const output = connection.on("output", (event) => {
      if (event.sessionId !== session.id) return;
      if (initialized) terminal.write(event.data);
      else pendingOutput.push(event.data);
    });

    const screen = hostElement.querySelector<HTMLElement>(".xterm-screen");
    let activeTouchId: number | undefined;
    let previousTouchY: number | undefined;
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
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        resetTouch();
        return;
      }
      const touch = event.touches.item(0);
      if (!touch) return;
      activeTouchId = touch.identifier;
      previousTouchY = touch.clientY;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (activeTouchId === undefined || previousTouchY === undefined || terminal.hasSelection()) return;
      const touch = findTouch(event.touches, activeTouchId);
      if (!touch) return;
      const deltaY = touch.clientY - previousTouchY;
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
    hostElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    hostElement.addEventListener("touchmove", handleTouchMove, { passive: false });
    hostElement.addEventListener("touchend", resetTouch, { passive: true });
    hostElement.addEventListener("touchcancel", resetTouch, { passive: true });

    const attachment = connection.request({ type: "session.attach", requestId: createRequestId(), sessionId: session.id, cols: terminal.cols, rows: terminal.rows }).then((message) => {
      if (disposed) return;
      if (message.type === "session.buffer") terminal.write(message.data);
      for (const data of pendingOutput) terminal.write(data);
      pendingOutput.length = 0;
      initialized = true;
      resize();
      terminal.focus();
    }).catch((cause) => {
      if (!disposed) terminal.write(`\r\n\x1b[31mCould not attach terminal: ${String(cause)}\x1b[0m\r\n`);
    });
    return () => {
      disposed = true;
      void attachment.finally(() => connection.send({ type: "session.detach", requestId: createRequestId(), sessionId: session.id }));
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("pointerdown", handlePointerActivity, true);
      hostElement.removeEventListener("touchstart", handleTouchStart);
      hostElement.removeEventListener("touchmove", handleTouchMove);
      hostElement.removeEventListener("touchend", resetTouch);
      hostElement.removeEventListener("touchcancel", resetTouch);
      if (countdownTimerRef.current !== undefined) window.clearTimeout(countdownTimerRef.current);
      input.dispose(); output(); terminal.dispose(); terminalRef.current = null;
      resizeRef.current = () => undefined;
    };
  }, [connection, session.id]);

  function pressAccessibilityKey(key: AccessibilityKey) {
    const current = selectedKeysRef.current;
    const isSelected = current.some((item) => item.id === key.id);
    const next = isSelected ? current.filter((item) => item.id !== key.id) : [...current, key];
    if (!current.length && !isSelected && key.value) {
      resizeRef.current(true);
      connection.send({ type: "session.input", sessionId: session.id, data: key.value });
    }
    selectedKeysRef.current = next;
    setSelectedKeyIds(new Set(next.map((item) => item.id)));
    restartCountdown(next);
    terminalRef.current?.focus();
  }

  return <div className="mobile-terminal-shell">
    <div ref={hostRef} className="mobile-terminal" />
    <div className="extra-keys" aria-label="Terminal function keys">
      {ACCESSIBILITY_KEY_ROWS.map((row, rowIndex) => <div className="key-row" key={rowIndex}>{row.map((key) => {
        const selected = selectedKeyIds.has(key.id);
        return <button
          key={key.id}
          type="button"
          aria-pressed={selected}
          className={selected ? "latched chord-pending" : ""}
          onPointerDown={(event) => {
            event.preventDefault();
            pressAccessibilityKey(key);
          }}
          onClick={(event) => {
            // Pointer taps are handled immediately above. Keep keyboard activation accessible.
            if (event.detail === 0) pressAccessibilityKey(key);
          }}
        ><span>{key.label}</span>{selected && <i key={countdownVersion} className="key-countdown" />}</button>;
      })}</div>)}
    </div>
  </div>;
}
