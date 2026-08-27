import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTerminalModifiers, createRequestId } from "@agentterminal/protocol";
import type { TerminalModifier, TerminalSession } from "@agentterminal/protocol";
import type { HostConnection } from "./connection";
import "@xterm/xterm/css/xterm.css";

interface Props { connection: HostConnection; session: TerminalSession; }

export function MobileTerminal({ connection, session }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const modifiersRef = useRef<ReadonlySet<TerminalModifier>>(new Set());
  const [modifiers, setModifiers] = useState<ReadonlySet<TerminalModifier>>(new Set());

  const consumeModifiers = (value: string) => {
    const activeModifiers = modifiersRef.current;
    const output = applyTerminalModifiers(value, activeModifiers);
    if (activeModifiers.size) {
      const cleared = new Set<TerminalModifier>();
      modifiersRef.current = cleared;
      setModifiers(cleared);
    }
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
    let lastSize = { cols: 0, rows: 0 };
    const resize = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        try {
          fit.fit();
          if (terminal.cols !== lastSize.cols || terminal.rows !== lastSize.rows) {
            lastSize = { cols: terminal.cols, rows: terminal.rows };
            connection.send({ type: "session.resize", sessionId: session.id, cols: terminal.cols, rows: terminal.rows });
          }
        } catch {
          // The WebView can report an intermediate zero-sized layout while the keyboard opens.
        }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostElement);
    const input = terminal.onData((data) => connection.send({ type: "session.input", sessionId: session.id, data: consumeModifiers(data) }));
    const output = connection.on("output", (event) => { if (event.sessionId === session.id) terminal.write(event.data); });

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
      const deltaY = previousTouchY - touch.clientY;
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

    void connection.request({ type: "session.attach", requestId: createRequestId(), sessionId: session.id, cols: terminal.cols, rows: terminal.rows }).then((message) => {
      if (message.type === "session.buffer") terminal.write(message.data);
      resize();
      terminal.focus();
    });
    return () => {
      connection.send({ type: "session.detach", requestId: createRequestId(), sessionId: session.id });
      observer.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      hostElement.removeEventListener("touchstart", handleTouchStart);
      hostElement.removeEventListener("touchmove", handleTouchMove);
      hostElement.removeEventListener("touchend", resetTouch);
      hostElement.removeEventListener("touchcancel", resetTouch);
      input.dispose(); output(); terminal.dispose(); terminalRef.current = null;
    };
  }, [connection, session.id]);

  function toggle(modifier: TerminalModifier) {
    const next = new Set(modifiersRef.current);
    if (next.has(modifier)) next.delete(modifier); else next.add(modifier);
    modifiersRef.current = next;
    setModifiers(next);
    terminalRef.current?.focus();
  }

  function send(value: string) {
    connection.send({ type: "session.input", sessionId: session.id, data: consumeModifiers(value) });
    terminalRef.current?.focus();
  }

  return <div className="mobile-terminal-shell">
    <div ref={hostRef} className="mobile-terminal" />
    <div className="extra-keys" aria-label="Terminal function keys">
      <div className="key-row">
        <button aria-pressed={modifiers.has("ctrl")} className={modifiers.has("ctrl") ? "latched" : ""} onClick={() => toggle("ctrl")}>Ctrl</button>
        <button aria-pressed={modifiers.has("alt")} className={modifiers.has("alt") ? "latched" : ""} onClick={() => toggle("alt")}>Alt</button>
        <button aria-pressed={modifiers.has("shift")} className={modifiers.has("shift") ? "latched" : ""} onClick={() => toggle("shift")}>Shift</button>
        <button onClick={() => send("\x1b")}>Esc</button><button onClick={() => send("\t")}>Tab</button>
        <button onClick={() => send("|")}>|</button><button onClick={() => send("~")}>~</button>
      </div>
      <div className="key-row">
        <button onClick={() => send("\x1b[5~")}>PgUp</button><button onClick={() => send("\x1b[6~")}>PgDn</button><button onClick={() => send("\x1b[1;5D")}>⌃←</button><button onClick={() => send("\x1b[D")}>←</button><button onClick={() => send("\x1b[A")}>↑</button><button onClick={() => send("\x1b[B")}>↓</button><button onClick={() => send("\x1b[C")}>→</button>
        <button onClick={() => send("\x1b[1;5C")}>⌃→</button><button onClick={() => send("\x7f")}>⌫</button><button onClick={() => send("\r")}>Enter</button>
      </div>
    </div>
  </div>;
}
