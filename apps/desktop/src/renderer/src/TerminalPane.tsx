import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { applyTerminalModifiers, findHttpLinks, streamByteLength, TERMINAL_ANSI_THEME, TERMINAL_SCROLLBACK_LINES, type TerminalModifier } from "@agentterminal/protocol";
import "@xterm/xterm/css/xterm.css";

interface Props { sessionId: string; visible: boolean; active: boolean; confirmExternalLinks: boolean; }

const isCursorPositionReport = (data: string) => /^\x1b\[\??\d+;\d+R$/.test(data);

type PendingItem =
  | { kind: "data"; data: string; offset: number }
  | { kind: "grid"; cols: number; rows: number; offset: number };

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

    // The PTY grid follows focus: a focused desktop window reasserts its own
    // dimensions (fit + resize), while an unfocused pane just follows the
    // grid announced by the host (target.grid), reflowing its history in
    // place. This is what keeps history intact as focus flips devices.
    const resize = (force = false) => {
      if (!activeRef.current) return;
      try {
        fit.fit();
        dbg(`resize session=${sessionId} cols=${terminal.cols} rows=${terminal.rows} force=${force}`);
        window.agentTerminal.resize(sessionId, terminal.cols, terminal.rows, force);
      } catch { /* hidden pane */ }
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
      // Only a focused window drives the PTY grid; taps elsewhere (e.g. an
      // inactive split pane) must not steal focus.
      if (activeRef.current) resize(true);
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    const dataSubscription = terminal.onData((data) => {
      if (isCursorPositionReport(data)) {
        // A newly created pane is attached before it becomes the active tab.
        // Forward terminal-generated CPR replies even while hidden; the tray
        // validates them against the shell's outstanding queries.
        try { fit.fit(); } catch { /* hidden pane */ }
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
    // Absolute stream position up to which this emulator's buffer is known to
    // be applied: any chunk (or grid epoch) at or below this offset is already
    // contained in the replayed segments.
    let appliedUpTo = 0;
    const pending: PendingItem[] = [];
    const applyItem = (item: PendingItem) => {
      if (item.kind === "grid") {
        // A grid change is never "covered" by anything but an equal grid
        // state: offsets only dedupe DATA chunks. Live clients must follow
        // every grid epoch even when stream offsets have advanced past it.
        if (item.cols !== terminal.cols || item.rows !== terminal.rows) {
          terminal.resize(item.cols, item.rows);
          dbg(`grid session=${sessionId} cols=${item.cols} rows=${item.rows} off=${item.offset} reflow`);
        } else {
          dbg(`grid session=${sessionId} cols=${item.cols} rows=${item.rows} off=${item.offset} same-grid`);
        }
        return;
      }
      if (item.offset < appliedUpTo) {
        dbg(`out session=${sessionId} off=${item.offset} len=${streamByteLength(item.data)} skipped(covered upTo=${appliedUpTo})`);
        return;
      }
      appliedUpTo = Math.max(appliedUpTo, item.offset + streamByteLength(item.data));
      dbg(`out session=${sessionId} off=${item.offset} len=${streamByteLength(item.data)} upTo=${appliedUpTo}`);
      terminal.write(item.data);
    };
    const offData = window.agentTerminal.onData((id, data, offset) => {
      if (id !== sessionId) return;
      if (replayingSessionBuffer || !initialized) {
        pending.push({ kind: "data", data, offset });
        return;
      }
      applyItem({ kind: "data", data, offset });
    });
    const offGrid = window.agentTerminal.onGrid((id, cols, rows, offset) => {
      if (id !== sessionId) return;
      if (replayingSessionBuffer || !initialized) {
        pending.push({ kind: "grid", cols, rows, offset });
        return;
      }
      applyItem({ kind: "grid", cols, rows, offset });
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
      if (item.kind === "grid") {
        // Grid notices are applied unless the replayed snapshot already
        // covered them; dropping them would leave the emulator on the grid
        // before the snapshot's last segment.
        if (item.offset >= appliedUpTo && (item.cols !== terminal.cols || item.rows !== terminal.rows)) {
          terminal.resize(item.cols, item.rows);
          dbg(`grid(snap) session=${sessionId} cols=${item.cols} rows=${item.rows} off=${item.offset} reflow`);
        }
        replayPending(index + 1);
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
    const attachment = (async () => {
      try { fit.fit(); } catch { /* hidden pane */ }
      dbg(`attach send session=${sessionId} cols=${terminal.cols} rows=${terminal.rows}`);
      const snapshot = await window.agentTerminal.attachSession(sessionId, terminal.cols, terminal.rows);
      if (disposed) {
        window.agentTerminal.detachSession(sessionId);
        return;
      }
      dbg(`buffer session=${sessionId} end=${snapshot.endOffset} segs=${snapshot.segments.map((s) => `${s.cols}x${s.rows}+${s.data.length}`).join(" ")}`);
      replayingSessionBuffer = true;
      const segments = snapshot.segments;
      const writeNext = (index = 0) => {
        if (disposed) return;
        const segment = segments[index];
        if (segment === undefined) {
          replayingSessionBuffer = false;
          appliedUpTo = Math.max(appliedUpTo, snapshot.endOffset);
          dbg(`replay done session=${sessionId} upTo=${appliedUpTo} pending=${pending.length}`);
          replayPending();
          return;
        }
        if (segment.cols !== terminal.cols || segment.rows !== terminal.rows) {
          terminal.resize(segment.cols, segment.rows);
        }
        terminal.write(segment.data, () => writeNext(index + 1));
      };
      writeNext();
    })().catch((cause) => {
      if (!disposed) {
        dbg(`attach session=${sessionId} failed: ${String(cause)}`);
        terminal.write(`\r\n\x1b[31mCould not attach terminal: ${String(cause)}\x1b[0m\r\n`);
      }
    });
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
      void attachment.then(() => window.agentTerminal.detachSession(sessionId));
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
