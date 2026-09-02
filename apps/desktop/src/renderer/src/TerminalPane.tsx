import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTerminalModifiers, findHttpLinks, streamByteLength, TERMINAL_ANSI_THEME, TERMINAL_SCROLLBACK_LINES, type TerminalModifier, type TuiMode } from "@agentterminal/protocol";
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
  const resizeRef = useRef<(force?: boolean) => void>(() => undefined);
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
    // Dual-path rendering (distinguished by the host's TUI mode, which
    // the stream-signal classifier reports):
    //  - CANONICAL (viewport mode): the session grid is frozen; this pane
    //    renders the journal at its OWN size by re-parsing it at a single
    //    grid (reset + full replay, coalesced). Idempotent and lossless,
    //    no reflow, no host resize - resizing a million times is a re-render.
    //  - INLINE / FULLSCREEN (focus mode): the focused window's size IS the
    //    PTY grid; the pane calls fit() and pushes the dimensions to the
    //    host (SIGWINCH), and the TUI repaints natively across the new grid.
    // ---------------------------------------------------------------------
    let tuiMode: TuiMode = "canonical";
    let sessionGrid = { cols: 0, rows: 0 };
    let viewportGrid = { cols: 0, rows: 0 };
    let refreshing = false;
    let refreshQueued = false;
    let refreshLoopPromise = Promise.resolve();
    const proposeGrid = () => {
      try {
        const dims = fit.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) return { cols: dims.cols, rows: dims.rows };
      } catch { /* hidden pane */ }
      return null;
    };
    const scheduleRefresh = () => {
      refreshQueued = true;
      if (!refreshing) void refreshLoop();
    };
    const refreshLoop = () => {
      if (refreshing) return refreshLoopPromise;
      refreshing = true;
      refreshLoopPromise = (async () => {
        try {
          while (refreshQueued) {
            refreshQueued = false;
            await refreshOnce();
          }
        } finally {
          refreshing = false;
        }
      })();
      return refreshLoopPromise;
    };
    const refreshOnce = async () => {
      if (disposed) return;
      const dims = proposeGrid();
      if (dims) viewportGrid = dims;
      if (!(viewportGrid.cols > 0)) return;
      const requestGrid = sessionGrid.cols > 0 ? sessionGrid : viewportGrid;
      dbg(`reparse send session=${sessionId} viewport=${viewportGrid.cols}x${viewportGrid.rows} sessionGrid=${requestGrid.cols}x${requestGrid.rows}`);
      const snapshot = await window.agentTerminal.attachSession(sessionId, requestGrid.cols, requestGrid.rows);
      if (disposed) {
        window.agentTerminal.detachSession(sessionId);
        return;
      }
      const lastSegment = snapshot.segments.at(-1);
      if (lastSegment) sessionGrid = { cols: lastSegment.cols, rows: lastSegment.rows };
      initialized = false;
      replayingSessionBuffer = true;
      pending.length = 0;
      appliedUpTo = Math.max(appliedUpTo, snapshot.endOffset);
      terminal.reset();
      if (viewportGrid.cols !== terminal.cols || viewportGrid.rows !== terminal.rows) {
        terminal.resize(viewportGrid.cols, viewportGrid.rows);
      }
      const flat = snapshot.segments.map((segment) => segment.data).join("");
      dbg(`reparse session=${sessionId} viewport=${viewportGrid.cols}x${viewportGrid.rows} sessionGrid=${sessionGrid.cols}x${sessionGrid.rows} bytes=${flat.length} end=${snapshot.endOffset} pending=${pending.length}`);
      await new Promise<void>((resolve) => terminal.write(flat, () => resolve()));
      replayingSessionBuffer = false;
      replayPending();
    };
    // TUI path: assert our dimensions to the host (SIGWINCH on the PTY).
    const announceViewport = () => {
      try {
        fit.fit();
        dbg(`resize(tui) session=${sessionId} cols=${terminal.cols} rows=${terminal.rows}`);
        window.agentTerminal.resize(sessionId, terminal.cols, terminal.rows, true);
      } catch { /* hidden pane */ }
    };
    const applyGridInPlace = (cols: number, rows: number) => {
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.resize(cols, rows);
      }
    };

    const resize = (force = false) => {
      if (!activeRef.current) return;
      if (tuiMode !== "canonical") {
        // TUI focus mode: push our dimensions so the TUI repaints (SIGWINCH).
        announceViewport();
        return;
      }
      const dims = proposeGrid();
      if (!dims) return;
      if (dims.cols !== viewportGrid.cols || dims.rows !== viewportGrid.rows) {
        viewportGrid = dims;
        scheduleRefresh();
      }
      dbg(`viewport session=${sessionId} cols=${dims.cols} rows=${dims.rows} force=${force}`);
    };
    resizeRef.current = resize;

    const sendKeyboardInput = (data: string) => {
      if (!data) return;
      if (tuiMode !== "canonical") {
        try { fit.fit(); } catch { /* hidden pane */ }
        window.agentTerminal.write(sessionId, data, terminal.cols, terminal.rows);
        return;
      }
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
      // Only a focused window drives the PTY grid; taps elsewhere (e.g. an
      // inactive split pane) must not steal focus.
      if (activeRef.current) resize(true);
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    const inputDims = () => tuiMode !== "canonical"
      ? { cols: terminal.cols, rows: terminal.rows }
      : (proposeGrid() ?? { cols: terminal.cols, rows: terminal.rows });
    const dataSubscription = terminal.onData((data) => {
      if (isCursorPositionReport(data)) {
        // A newly created pane is attached before it becomes the active tab.
        // Forward terminal-generated CPR replies even while hidden; the tray
        // validates them against the shell's outstanding queries.
        if (tuiMode !== "canonical") { try { fit.fit(); } catch { /* hidden pane */ } }
        const dims = inputDims();
        window.agentTerminal.write(sessionId, data, dims.cols, dims.rows);
        return;
      }
      if (!activeRef.current) return;
      if (tuiMode !== "canonical") { try { fit.fit(); } catch { /* hidden pane */ } }
      const dims = inputDims();
      window.agentTerminal.write(sessionId, data, dims.cols, dims.rows);
    });

    let initialized = false;
    let replayingSessionBuffer = false;
    let disposed = false;
    // Absolute stream position up to which this emulator's buffer is known to
    // be applied: any chunk (or grid epoch) at or below this offset is already
    // contained in the replayed segments.
    let appliedUpTo = 0;
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
      sessionGrid = { cols, rows };
      if (tuiMode !== "canonical") {
        applyGridInPlace(cols, rows);
        dbg(`grid(tui) session=${sessionId} cols=${cols} rows=${rows}`);
      } else {
        dbg(`grid session=${sessionId} cols=${cols} rows=${rows} recorded`);
      }
    });
    // TUI mode flips the render path. On entry to inline/fullscreen, the
    // focused pane announces its size so the TUI opens at the right
    // dimensions; on exit to canonical, the pane returns to viewport
    // rendering, re-parsing the journal at its own grid (which also heals
    // any primary history after the TUI).
    const offMode = window.agentTerminal.onTuiMode((id, mode, offset) => {
      if (id !== sessionId) return;
      tuiMode = mode;
      dbg(`mode session=${sessionId} mode=${mode} off=${offset}`);
      if (mode === "canonical") {
        scheduleRefresh();
      } else if (activeRef.current) {
        announceViewport();
      }
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
    void refreshLoop();
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
      void refreshLoopPromise.then(() => window.agentTerminal.detachSession(sessionId));
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
