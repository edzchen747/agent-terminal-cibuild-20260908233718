import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTerminalModifiers, findHttpLinks, streamByteLength, TERMINAL_ANSI_THEME, TERMINAL_SCROLLBACK_LINES, type TerminalModifier } from "@agentterminal/protocol";
import "@xterm/xterm/css/xterm.css";

interface Props { sessionId: string; visible: boolean; active: boolean; confirmExternalLinks: boolean; }

const isCursorPositionReport = (data: string) => /^\x1b\[\??\d+;\d+R$/.test(data);

interface PendingItem { data: string; offset: number; }

// Terminal sync diagnostics: mirrored to the host's sync log file (and the
// WebView2 console) so desktop decisions are captured in the same run as the
// journal and remote merges.
const dbg = (message: string) => {
  console.log("[ATSync]", message);
  window.agentTerminal.logDebug(`[ATSync] ${message}`);
};

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
      scrollback: TERMINAL_SCROLLBACK_LINES,
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

    // ---------------------------------------------------------------------
    // Single rendering path (minimum-boundary sizing): the host PTY grid is
    // the smallest announced viewport over the clients viewing the session,
    // and this pane is never narrower than the PTY - so the pane renders the
    // host grid exactly and letterboxes the surplus. The host grid is
    // followed in EVERY mode; the raw journal replays 1:1 with no
    // re-wrapping at the pane's own size.
    // ---------------------------------------------------------------------
    let viewportCols = 0;
    let viewportRows = 0;
    const proposeGrid = () => {
      try {
        const dims = fit.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) return { cols: dims.cols, rows: dims.rows };
      } catch { /* hidden pane */ }
      return null;
    };
    // Announce, don't assert: the pane's proposed dimensions are its
    // viewport (W_i, H_i) - the host takes the minimum over all announced
    // viewports in canonical mode. In a TUI period the interacting client
    // owns the grid, so a click re-announces (force) even when the pane's
    // own size has not changed: the host applies it to the PTY. Never
    // fit(): the emulator's grid is the host's, not the container's.
    const announceViewport = (force = false) => {
      const dims = proposeGrid();
      if (!dims) return;
      if (!force && dims.cols === viewportCols && dims.rows === viewportRows) return;
      viewportCols = dims.cols;
      viewportRows = dims.rows;
      dbg(`viewport session=${sessionId} cols=${dims.cols} rows=${dims.rows}${force ? " (forced)" : ""}`);
      window.agentTerminal.resize(sessionId, dims.cols, dims.rows);
    };
    const applyGridInPlace = (cols: number, rows: number) => {
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.resize(cols, rows);
      }
    };

    const resize = () => {
      if (!activeRef.current) return;
      announceViewport();
    };
    resizeRef.current = resize;
    const sendKeyboardInput = (data: string) => {
      if (!data) return;
      const dims = proposeGrid() ?? { cols: terminal.cols, rows: terminal.rows };
      window.agentTerminal.write(sessionId, data, dims.cols, dims.rows);
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
      // A click on the terminal area is an interaction: force a viewport
      // announce so the host applies this pane's size to the PTY grid in
      // a TUI period even when the pane's own size did not change.
      if (activeRef.current) announceViewport(true);
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    const inputDims = () => proposeGrid() ?? { cols: terminal.cols, rows: terminal.rows };
    const dataSubscription = terminal.onData((data) => {
      const dims = inputDims();
      if (isCursorPositionReport(data)) {
        // A newly created pane is attached before it becomes the active tab.
        // Forward terminal-generated CPR replies even while hidden; the tray
        // validates them against the shell's outstanding queries.
        window.agentTerminal.write(sessionId, data, dims.cols, dims.rows);
        return;
      }
      if (!activeRef.current) return;
      window.agentTerminal.write(sessionId, data, dims.cols, dims.rows);
    });

    let initialized = false;
    let replayingSessionBuffer = false;
    let disposed = false;
    // Absolute stream position up to which this emulator's buffer is known to
    // be applied: any chunk (or grid epoch) at or below this offset is already
    // contained in the replayed segments.
    let appliedUpTo = 0;
    let initialAttachPromise: Promise<void> | undefined;
    const pending: PendingItem[] = [];
    const offData = window.agentTerminal.onData((id, data, offset) => {
      if (id !== sessionId) return;
      if (replayingSessionBuffer || !initialized) {
        pending.push({ data, offset });
        return;
      }
      if (offset < appliedUpTo) {
        dbg(`out session=${sessionId} off=${offset} len=${streamByteLength(data)} skipped(covered upTo=${appliedUpTo})`);
        return;
      }
      appliedUpTo = Math.max(appliedUpTo, offset + streamByteLength(data));
      dbg(`out session=${sessionId} off=${offset} len=${streamByteLength(data)} upTo=${appliedUpTo}`);
      terminal.write(data);
    });
    const offGrid = window.agentTerminal.onGrid((id, cols, rows) => {
      if (id !== sessionId) return;
      applyGridInPlace(cols, rows);
      dbg(`grid session=${sessionId} cols=${cols} rows=${rows}`);
    });
    // TUI mode is classification only: it no longer switches the sizing or
    // render path under minimum-boundary sizing. The pane follows the host
    // grid in every mode.
    const offMode = window.agentTerminal.onTuiMode((id, mode, offset) => {
      if (id !== sessionId) return;
      dbg(`mode session=${sessionId} mode=${mode} off=${offset}`);
    });
    const finishAttachment = () => {
      if (disposed) return;
      initialized = true;
      if (activeRef.current) terminal.focus();
    };
    const replayPending = (index = 0) => {
      if (disposed) return;
      const item = pending[index];
      if (item === undefined) {
        pending.length = 0;
        finishAttachment();
        return;
      }
      if (item.offset < appliedUpTo) {
        dbg(`pend session=${sessionId} off=${item.offset} skipped(covered upTo=${appliedUpTo})`);
        replayPending(index + 1);
        return;
      }
      appliedUpTo = Math.max(appliedUpTo, item.offset + streamByteLength(item.data));
      dbg(`pend session=${sessionId} off=${item.offset} len=${streamByteLength(item.data)} upTo=${appliedUpTo}`);
      terminal.write(item.data, () => replayPending(index + 1));
    };
    // Full replay is needed only on initial attach (and reconnect): the
    // pane's size is at least the PTY's, so the segments replay 1:1 with no
    // re-wrapping at the pane's own grid.
    initialAttachPromise = (async () => {
      const dims = proposeGrid() ?? { cols: terminal.cols, rows: terminal.rows };
      viewportCols = dims.cols;
      viewportRows = dims.rows;
      dbg(`attach send session=${sessionId} viewport=${dims.cols}x${dims.rows}`);
      const snapshot = await window.agentTerminal.attachSession(sessionId, dims.cols, dims.rows);
      if (disposed) {
        window.agentTerminal.detachSession(sessionId);
        return;
      }
      const segments = snapshot.segments;
      dbg(`buffer session=${sessionId} end=${snapshot.endOffset} segs=${segments.map((s) => `${s.cols}x${s.rows}+${s.data.length}`).join(" ")}`);
      initialized = false;
      replayingSessionBuffer = true;
      pending.length = 0;
      appliedUpTo = Math.max(appliedUpTo, snapshot.endOffset);
      terminal.reset();
      const writeNext = (index = 0) => {
        if (disposed) return;
        const segment = segments[index];
        if (segment === undefined) {
          replayingSessionBuffer = false;
          replayPending();
          return;
        }
        // Each segment is rendered at its recorded grid - the journal
        // replays 1:1 exactly the way the live clients applied it.
        if (segment.cols !== terminal.cols || segment.rows !== terminal.rows) {
          terminal.resize(segment.cols, segment.rows);
        }
        terminal.write(segment.data, () => writeNext(index + 1));
      };
      writeNext();
    })();
    const statsTimer = window.setInterval(() => {
      if (disposed || !terminalRef.current) return;
      const buffer = terminal.buffer.active;
      dbg(`stats session=${sessionId} grid=${terminal.cols}x${terminal.rows} bufferLines=${buffer.length} baseY=${buffer.baseY} viewport=${buffer.viewportY}`);
    }, 5_000);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("pointerdown", handlePointerActivity, true);
      dataSubscription.dispose();
      offData();
      offGrid();
      offMode();
      void (initialAttachPromise ?? Promise.resolve()).then(() => window.agentTerminal.detachSession(sessionId));
      if (statsTimer !== undefined) window.clearInterval(statsTimer);
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
