import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createRequestId } from "@agentterminal/protocol";
import type { TerminalSession } from "@agentterminal/protocol";
import type { HostConnection } from "./connection";
import "@xterm/xterm/css/xterm.css";

interface Props { connection: HostConnection; session: TerminalSession; }
type Modifier = "ctrl" | "alt" | "shift";

export function MobileTerminal({ connection, session }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [modifiers, setModifiers] = useState<Set<Modifier>>(new Set());

  const applyModifiers = (value: string) => {
    let output = value;
    if (modifiers.has("shift") && output.length === 1) output = output.toUpperCase();
    if (modifiers.has("ctrl") && output.length === 1) output = String.fromCharCode(output.toUpperCase().charCodeAt(0) & 31);
    if (modifiers.has("alt")) output = `\x1b${output}`;
    if (modifiers.size) setModifiers(new Set());
    return output;
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Mono", "Roboto Mono", monospace',
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 5000,
      theme: { background: "#080b0f", foreground: "#d7dce6", cursor: "#79ddc7", selectionBackground: "#315b64aa" }
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    const resize = () => {
      try { fit.fit(); connection.send({ type: "session.resize", sessionId: session.id, cols: terminal.cols, rows: terminal.rows }); } catch { /* layout settling */ }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostRef.current);
    const input = terminal.onData((data) => connection.send({ type: "session.input", sessionId: session.id, data: applyModifiers(data) }));
    const output = connection.on("output", (event) => { if (event.sessionId === session.id) terminal.write(event.data); });
    void connection.request({ type: "session.attach", requestId: createRequestId(), sessionId: session.id, cols: terminal.cols, rows: terminal.rows }).then((message) => {
      if (message.type === "session.buffer") terminal.write(message.data);
      resize();
      terminal.focus();
    });
    return () => {
      connection.send({ type: "session.detach", requestId: createRequestId(), sessionId: session.id });
      observer.disconnect(); input.dispose(); output(); terminal.dispose(); terminalRef.current = null;
    };
  }, [connection, session.id]);

  function toggle(modifier: Modifier) {
    setModifiers((current) => {
      const next = new Set(current);
      if (next.has(modifier)) next.delete(modifier); else next.add(modifier);
      return next;
    });
    terminalRef.current?.focus();
  }

  function send(value: string) {
    connection.send({ type: "session.input", sessionId: session.id, data: applyModifiers(value) });
    terminalRef.current?.focus();
  }

  return <div className="mobile-terminal-shell">
    <div ref={hostRef} className="mobile-terminal" />
    <div className="extra-keys" aria-label="Terminal function keys">
      <div className="key-row">
        <button className={modifiers.has("ctrl") ? "latched" : ""} onClick={() => toggle("ctrl")}>Ctrl</button>
        <button className={modifiers.has("alt") ? "latched" : ""} onClick={() => toggle("alt")}>Alt</button>
        <button className={modifiers.has("shift") ? "latched" : ""} onClick={() => toggle("shift")}>Shift</button>
        <button onClick={() => send("\x1b")}>Esc</button><button onClick={() => send("\t")}>Tab</button>
        <button onClick={() => send("|")}>|</button><button onClick={() => send("~")}>~</button>
      </div>
      <div className="key-row">
        <button onClick={() => send("\x1b[1;5D")}>⌃←</button><button onClick={() => send("\x1b[D")}>←</button><button onClick={() => send("\x1b[A")}>↑</button><button onClick={() => send("\x1b[B")}>↓</button><button onClick={() => send("\x1b[C")}>→</button>
        <button onClick={() => send("\x1b[1;5C")}>⌃→</button><button onClick={() => send("\x7f")}>⌫</button><button onClick={() => send("\r")}>Enter</button>
      </div>
    </div>
  </div>;
}
