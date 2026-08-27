import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props { sessionId: string; active: boolean; }

export function TerminalPane({ sessionId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.18,
      scrollback: 10_000,
      theme: {
        background: "#090b10",
        foreground: "#d9deea",
        cursor: "#89e6d1",
        cursorAccent: "#090b10",
        selectionBackground: "#315b64aa",
        black: "#11141b", red: "#f07178", green: "#8bd49c", yellow: "#e5c07b",
        blue: "#7aa2f7", magenta: "#c099ff", cyan: "#79d4d4", white: "#d9deea",
        brightBlack: "#646b7a", brightRed: "#ff8b92", brightGreen: "#a5e8b3", brightYellow: "#f5d598",
        brightBlue: "#9ab7ff", brightMagenta: "#d5b3ff", brightCyan: "#9ce6e6", brightWhite: "#ffffff"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    const resize = () => {
      try { fit.fit(); window.agentTerminal.resize(sessionId, terminal.cols, terminal.rows); } catch { /* hidden pane */ }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostRef.current);
    const dataSubscription = terminal.onData((data) => window.agentTerminal.write(sessionId, data));
    const offData = window.agentTerminal.onData((id, data) => { if (id === sessionId) terminal.write(data); });
    void window.agentTerminal.getBuffer(sessionId).then((buffer) => {
      if (buffer) terminal.write(buffer);
      resize();
      if (active) terminal.focus();
    });
    return () => {
      observer.disconnect();
      dataSubscription.dispose();
      offData();
      terminal.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    if (active) hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
  }, [active]);

  return <div ref={hostRef} className={`terminal-pane ${active ? "is-active" : ""}`} />;
}

