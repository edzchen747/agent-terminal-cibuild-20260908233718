import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props { sessionId: string; active: boolean; }

export function TerminalPane({ sessionId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const resizeRef = useRef<() => void>(() => undefined);
  activeRef.current = active;

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
    let copyToastTimer: number | undefined;
    const copyToast = document.createElement("div");
    copyToast.className = "terminal-copy-toast";
    copyToast.textContent = "Copied";
    copyToast.setAttribute("role", "status");
    copyToast.setAttribute("aria-live", "polite");
    hostRef.current.appendChild(copyToast);

    const showCopyToast = () => {
      const selection = terminal.getSelectionPosition();
      const screen = hostRef.current?.querySelector<HTMLElement>(".xterm-screen");
      if (!selection || !screen || !hostRef.current) return;
      const hostRect = hostRef.current.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const viewportRow = selection.start.y - 1 - terminal.buffer.active.viewportY;
      const visibleRow = Math.max(0, Math.min(terminal.rows - 1, viewportRow));
      const cellWidth = screenRect.width / terminal.cols;
      const cellHeight = screenRect.height / terminal.rows;
      const selectionX = Math.max(0, selection.start.x - 1) * cellWidth;
      const left = Math.max(8, Math.min(screenRect.left - hostRect.left + selectionX, hostRect.width - 72));
      const top = Math.max(5, screenRect.top - hostRect.top + visibleRow * cellHeight - 31);
      copyToast.style.left = `${left}px`;
      copyToast.style.top = `${top}px`;
      copyToast.classList.remove("is-visible");
      requestAnimationFrame(() => copyToast.classList.add("is-visible"));
      if (copyToastTimer) window.clearTimeout(copyToastTimer);
      copyToastTimer = window.setTimeout(() => copyToast.classList.remove("is-visible"), 900);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const isCopy = event.ctrlKey && event.key.toLowerCase() === "c";
      if (!isCopy || !terminal.hasSelection()) return true;
      if (event.type === "keydown" && !event.repeat) {
        const selectedText = terminal.getSelection();
        void window.agentTerminal.copyText(selectedText).then(showCopyToast).catch(() => undefined);
      }
      return false;
    });
    const resize = () => {
      try { fit.fit(); window.agentTerminal.resize(sessionId, terminal.cols, terminal.rows); } catch { /* hidden pane */ }
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(hostRef.current);
    const handlePointerActivity = () => {
      if (activeRef.current) resize();
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    const dataSubscription = terminal.onData((data) => window.agentTerminal.write(sessionId, data));
    const offData = window.agentTerminal.onData((id, data) => { if (id === sessionId) terminal.write(data); });
    void window.agentTerminal.getBuffer(sessionId).then((buffer) => {
      if (buffer) terminal.write(buffer);
      resize();
      if (active) terminal.focus();
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("pointerdown", handlePointerActivity, true);
      dataSubscription.dispose();
      offData();
      if (copyToastTimer) window.clearTimeout(copyToastTimer);
      terminal.dispose();
      resizeRef.current = () => undefined;
    };
  }, [sessionId]);

  useEffect(() => {
    if (active) {
      resizeRef.current();
      hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    }
  }, [active]);

  return <div ref={hostRef} className={`terminal-pane ${active ? "is-active" : ""}`} />;
}
