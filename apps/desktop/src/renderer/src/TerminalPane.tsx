import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTerminalModifiers, findHttpLinks, TERMINAL_ANSI_THEME, type TerminalModifier } from "@agentterminal/protocol";
import "@xterm/xterm/css/xterm.css";

interface Props { sessionId: string; visible: boolean; active: boolean; confirmExternalLinks: boolean; }

const isCursorPositionReport = (data: string) => /^\x1b\[\??\d+;\d+R$/.test(data);

export function TerminalPane({ sessionId, visible, active, confirmExternalLinks }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  const resizeRef = useRef<() => void>(() => undefined);
  const confirmExternalLinksRef = useRef(confirmExternalLinks);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [linkOpening, setLinkOpening] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  activeRef.current = active;
  confirmExternalLinksRef.current = confirmExternalLinks;

  useEffect(() => {
    setPendingUrl(null);
    setLinkError(null);
    setLinkOpening(false);
  }, [sessionId]);

  useEffect(() => {
    if (confirmExternalLinks) return;
    setPendingUrl(null);
    setLinkError(null);
  }, [confirmExternalLinks]);

  useEffect(() => {
    if (!pendingUrl) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !linkOpening) setPendingUrl(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [linkOpening, pendingUrl]);

  async function openPendingLink() {
    if (!pendingUrl || linkOpening) return;
    const url = pendingUrl;
    setLinkOpening(true);
    setLinkError(null);
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS links can be opened.");
      await window.agentTerminal.openExternalUrl(parsed.href);
      setPendingUrl(null);
    } catch (cause) {
      setLinkError(`Could not open this link: ${String(cause)}`);
    } finally {
      setLinkOpening(false);
    }
  }

  const activateLink = (uri: string) => {
    try {
      const parsed = new URL(uri);
      if (!["http:", "https:"].includes(parsed.protocol)) return;
      if (!confirmExternalLinksRef.current) {
        void window.agentTerminal.openExternalUrl(parsed.href).catch((cause) => {
          setLinkError(`Could not open this link: ${String(cause)}`);
          setPendingUrl(parsed.href);
        });
        return;
      }
      setLinkError(null);
      setPendingUrl(parsed.href);
    } catch {
      // Ignore malformed or unsupported terminal URLs.
    }
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1,
      scrollback: 10_000,
      linkHandler: {
        activate: (_event, uri) => activateLink(uri)
      },
      theme: {
        // Match the native Windows terminal (Windows Terminal's default
        // "Campbell" scheme) so shell output looks identical to the
        // original terminal. TERMINAL_ANSI_THEME carries the 16 ANSI
        // colors; keep it in sync with that scheme.
        background: "#0C0C0C",
        foreground: "#CCCCCC",
        cursor: "#FFFFFF",
        cursorAccent: "#0C0C0C",
        selectionBackground: "#FFFFFF",
        ...TERMINAL_ANSI_THEME
      }
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    const httpLinkProvider = terminal.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = terminal.buffer.active.getLine(y - 1);
        const links = findHttpLinks(line?.translateToString(true) ?? "");
        callback(links.map((link) => ({
          text: link.text,
          range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
          activate: () => activateLink(link.text)
        })));
      }
    });
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

    const resize = (force = false) => {
      try { fit.fit(); window.agentTerminal.resize(sessionId, terminal.cols, terminal.rows, force); } catch { /* hidden pane */ }
    };
    resizeRef.current = resize;

    const sendKeyboardInput = (data: string) => {
      if (!data) return;
      try { fit.fit(); } catch { /* hidden pane */ }
      window.agentTerminal.write(sessionId, data, terminal.cols, terminal.rows);
    };
    const keyInput = (event: KeyboardEvent): string | undefined => {
      if (!event.ctrlKey || event.metaKey) return undefined;
      const baseInput = ({
        Backspace: "\x7f",
        Delete: "\x1b[3~",
        Enter: "\r",
        Tab: "\t",
        ArrowUp: "\x1b[A",
        ArrowDown: "\x1b[B",
        ArrowRight: "\x1b[C",
        ArrowLeft: "\x1b[D",
        Home: "\x1b[H",
        End: "\x1b[F"
      } as Record<string, string>)[event.key] ?? (event.key.length === 1 ? event.key : undefined);
      if (!baseInput) return undefined;
      const modifiers = new Set<TerminalModifier>(["ctrl"]);
      if (event.altKey) modifiers.add("alt");
      if (event.shiftKey) modifiers.add("shift");
      return applyTerminalModifiers(baseInput, modifiers);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (!activeRef.current) return false;
      if (event.type !== "keydown") return true;
      const isCopy = event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c";
      if (isCopy && terminal.hasSelection()) {
        event.preventDefault();
        if (!event.repeat) {
          const selectedText = terminal.getSelection();
          void window.agentTerminal.copyText(selectedText).then(showCopyToast).catch(() => undefined);
        }
        return false;
      }

      // WebView2 can consume Ctrl shortcuts before xterm emits onData. Forward
      // the control sequence ourselves so Ctrl+D, Ctrl+C, Ctrl+Backspace, and
      // Ctrl+Arrow work consistently in every Windows shell.
      const data = keyInput(event);
      if (!data || (event.key.toLowerCase() === "v" && !event.altKey)) return true;
      event.preventDefault();
      sendKeyboardInput(data);
      return false;
    });

    const observer = new ResizeObserver(() => resize());
    observer.observe(hostRef.current);
    const handlePointerActivity = () => {
      if (activeRef.current) resize(true);
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    const dataSubscription = terminal.onData((data) => {
      if (isCursorPositionReport(data)) {
        // A newly created pane is attached before it becomes the active tab.
        // Forward terminal-generated CPR replies even while hidden; the tray
        // validates them against the shell's outstanding queries.
        window.agentTerminal.write(sessionId, data, terminal.cols, terminal.rows);
        return;
      }
      if (!activeRef.current) return;
      try { fit.fit(); } catch { /* hidden pane */ }
      window.agentTerminal.write(sessionId, data, terminal.cols, terminal.rows);
    });
    let initialized = false;
    let replayingSessionBuffer = false;
    let disposed = false;
    const pendingData: string[] = [];
    const offData = window.agentTerminal.onData((id, data) => {
      if (id !== sessionId) return;
      if (replayingSessionBuffer && isCursorPositionReport(data)) return;
      if (initialized) terminal.write(data);
      else pendingData.push(data);
    });
    const finishAttachment = () => {
      if (disposed) return;
      initialized = true;
      resize();
      if (activeRef.current) terminal.focus();
    };
    const replayPendingData = (index = 0) => {
      if (disposed) return;
      const data = pendingData[index];
      if (data === undefined) {
        pendingData.length = 0;
        finishAttachment();
        return;
      }
      terminal.write(data, () => replayPendingData(index + 1));
    };
    const attachment = window.agentTerminal.attachSession(sessionId).then((buffer) => {
      if (disposed) {
        window.agentTerminal.detachSession(sessionId);
        return;
      }
      if (buffer) {
        replayingSessionBuffer = true;
        terminal.write(buffer, () => {
          replayingSessionBuffer = false;
          replayPendingData();
        });
      } else {
        replayPendingData();
      }
    }).catch((cause) => {
      if (!disposed) terminal.write(`\r\n\x1b[31mCould not attach terminal: ${String(cause)}\x1b[0m\r\n`);
    });
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("pointerdown", handlePointerActivity, true);
      dataSubscription.dispose();
      offData();
      void attachment.then(() => window.agentTerminal.detachSession(sessionId));
      if (copyToastTimer) window.clearTimeout(copyToastTimer);
      httpLinkProvider.dispose();
      terminal.dispose();
      terminalRef.current = null;
      resizeRef.current = () => undefined;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      terminalRef.current?.blur();
      return;
    }
    resizeRef.current();
    terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => resizeRef.current());
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  return <div ref={hostRef} className={`terminal-pane ${visible ? "is-visible" : ""} ${active ? "is-active" : ""}`}>
    {pendingUrl && <div className="modal-backdrop link-confirm-backdrop" onMouseDown={() => { if (!linkOpening) setPendingUrl(null); }}>
      <section className="modal link-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="link-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-kicker">Agent Terminal</div>
        <h1 id="link-confirm-title">Open external link?</h1>
        <p className="link-confirm-url" title={pendingUrl}>{pendingUrl}</p>
        <p>This link will open in your system browser. Only continue if you trust the destination.</p>
        {linkError && <div className="form-error">{linkError}</div>}
        <div className="link-confirm-actions">
          <button className="link-cancel" disabled={linkOpening} onClick={() => setPendingUrl(null)}>Cancel</button>
          <button autoFocus className="primary" disabled={linkOpening} onClick={() => void openPendingLink()}>{linkOpening ? "Opening…" : "Open link"}</button>
        </div>
      </section>
    </div>}
  </div>;
}
