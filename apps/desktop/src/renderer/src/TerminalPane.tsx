import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { applyTerminalModifiers, findHttpLinks, gridForContent, streamByteLength, TERMINAL_SCROLLBACK_LINES, xtermThemeFor, zoomedFontSize, type Size, type TerminalModifier, type TerminalScheme } from "@agentterminal/protocol";
import { JournalMerge } from "./terminal-stream";
import "@xterm/xterm/css/xterm.css";

interface Props { sessionId: string; visible: boolean; active: boolean; confirmExternalLinks: boolean; scheme: TerminalScheme; }

// The base (unzoomed) font size: the announced viewport is always computed
// from the cell metrics AT THIS SIZE (cached the first time they are
// measured), never from the live, possibly-zoomed ones - see zoomedFontSize.
const BASE_FONT_SIZE = 14;

// A zoom correction is a fixed point: raising the font size changes the
// measured cell size, which can call for another (smaller) correction. Cap
// the self-correcting loop per trigger so a pathological measurement cannot
// spin forever; two or three passes is the normal case.
const MAX_ZOOM_PASSES = 4;

const isCursorPositionReport = (data: string) => /^\x1b\[\??\d+;\d+R$/.test(data);

// Terminal sync diagnostics: mirrored to the host's sync log file (and the
// WebView2 console) so desktop decisions are captured in the same run as the
// journal and remote merges.
const dbg = (message: string) => {
  console.log("[ATSync]", message);
  window.agentTerminal.logDebug(`[ATSync] ${message}`);
};

export function TerminalPane({ sessionId, visible, active, confirmExternalLinks, scheme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const resizeRef = useRef<() => void>(() => undefined);
  const confirmExternalLinksRef = useRef(confirmExternalLinks);
  const schemeRef = useRef(scheme);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [linkOpening, setLinkOpening] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  activeRef.current = active;
  visibleRef.current = visible;
  confirmExternalLinksRef.current = confirmExternalLinks;
  schemeRef.current = scheme;

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
      fontSize: BASE_FONT_SIZE,
      lineHeight: 1,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      linkHandler: {
        activate: (_event, uri) => activateLink(uri)
      },
      // The scheme is resolved from the host's shared setting, so the phone
      // and this window render the same session in the same colors. Whole
      // schemes only: the surface and the 16 ANSI colors always travel
      // together (see terminal-themes.ts).
      theme: xtermThemeFor(schemeRef.current)
    });
    terminalRef.current = terminal;
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
    // The pane's content box: its border box minus the letterbox padding
    // that lives on `.terminal-pane`. `getComputedStyle` under this app's
    // `* { box-sizing: border-box }` reports the border box, which - unlike
    // the addon proposal this replaced - would otherwise count that padding
    // as usable and let a proposal land a whole row/col too generous.
    const contentBox = (): Size | null => {
      const pane = hostRef.current;
      if (!pane) return null;
      const style = window.getComputedStyle(pane);
      const rect = pane.getBoundingClientRect();
      return {
        width: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      };
    };
    // One cell in CSS pixels, read off the rendered grid at whatever font
    // size is currently applied (the same measurement the copy toast places
    // itself with). Null until the emulator has painted.
    const cellSize = (): Size | null => {
      const screen = hostRef.current?.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || terminal.cols < 1 || terminal.rows < 1) return null;
      const rect = screen.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      return { width: rect.width / terminal.cols, height: rect.height / terminal.rows };
    };
    // The cell size at BASE_FONT_SIZE, cached the first time it is
    // measurable. The announced viewport is always derived from this, never
    // from the live (possibly zoomed) cell size: if zooming in shrank the
    // announcement, it would shrink the host's minimum-boundary PTY grid,
    // which would call for more zoom - a ratchet that collapses the session.
    let baseCell: Size | null = null;
    const captureBaseCell = () => {
      if (terminal.options.fontSize !== BASE_FONT_SIZE) return;
      const measured = cellSize();
      if (measured) baseCell = measured;
    };
    const proposeGrid = () => {
      captureBaseCell();
      const content = contentBox();
      if (!content) return null;
      return gridForContent(content, baseCell);
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
      // A forced announce is interaction-driven (a click in the pane), so it
      // claims the PTY grid for this pane; a plain layout resize never does -
      // the host's grid-owner policy decides what an unclaimed announce may
      // change.
      window.agentTerminal.resize(sessionId, dims.cols, dims.rows, force);
    };
    // Fill the pane: raise or lower xterm's font size so the rendered grid
    // consumes as much of the content box as its aspect ratio allows, then
    // letterbox the rest (the pane aligns the grid to its top-left corner).
    // This only ever touches rendering (fontSize) - never the announcement
    // above, which is why it cannot ratchet. A font-size change moves the
    // measured cell size, so the correction is a fixed point: re-measure and
    // correct again next frame, capped at MAX_ZOOM_PASSES.
    const applyZoom = (passesLeft = MAX_ZOOM_PASSES) => {
      if (!visibleRef.current || passesLeft <= 0) return;
      const content = contentBox();
      const cell = cellSize();
      const next = zoomedFontSize(terminal.options.fontSize ?? BASE_FONT_SIZE, { cols: terminal.cols, rows: terminal.rows }, cell, content);
      if (next === null) return;
      terminal.options.fontSize = next;
      requestAnimationFrame(() => applyZoom(passesLeft - 1));
    };
    const applyGridInPlace = (cols: number, rows: number) => {
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.resize(cols, rows);
        applyZoom();
      }
    };

    const resize = () => {
      if (!visibleRef.current) return;
      applyZoom();
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

    let disposed = false;
    let initialAttachPromise: Promise<void> | undefined;
    // Offset bookkeeping for the replay/live merge: what the snapshot already
    // covers, and what arrived while the attach was in flight (see
    // terminal-stream.ts). The host subscribes this window inside the lock
    // that takes the snapshot, so chunks past its end can arrive before the
    // reply - they must be queued across that window and merged after the
    // replay, or a just-created tab renders its banner and first prompt as
    // a permanently blank screen.
    const merge = new JournalMerge((chunk) => {
      dbg(`out session=${sessionId} off=${chunk.offset} len=${streamByteLength(chunk.data)} skipped(covered upTo=${merge.appliedUpTo})`);
    });
    const offData = window.agentTerminal.onData((id, data, offset) => {
      if (id !== sessionId) return;
      if (merge.receive({ data, offset }) !== "write") return;
      dbg(`out session=${sessionId} off=${offset} len=${streamByteLength(data)} upTo=${merge.appliedUpTo}`);
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
      if (activeRef.current) terminal.focus();
    };
    const replayPending = () => {
      if (disposed) return;
      const item = merge.nextQueued();
      if (item === null) {
        finishAttachment();
        return;
      }
      dbg(`pend session=${sessionId} off=${item.offset} len=${streamByteLength(item.data)} upTo=${merge.appliedUpTo}`);
      terminal.write(item.data, () => replayPending());
    };
    // Full replay is needed only on initial attach (and reconnect): the
    // pane's size is at least the PTY's, so the segments replay 1:1 with no
    // re-wrapping at the pane's own grid.
    initialAttachPromise = (async () => {
      const dims = proposeGrid() ?? { cols: terminal.cols, rows: terminal.rows };
      viewportCols = dims.cols;
      viewportRows = dims.rows;
      // Reset the merge before the request goes out, never after the reply:
      // the host subscribes this window inside the lock that takes the
      // snapshot, so chunks past its end arrive while the reply is still in
      // flight and have to survive until the replay merges them.
      merge.restart();
      dbg(`attach send session=${sessionId} viewport=${dims.cols}x${dims.rows}`);
      // Claim the grid only when this pane was the active tab at mount: a
      // background or hidden tab must not steal it from the client that is
      // actually in use (an ownerless session still grants itself to the
      // first client that shows up).
      const snapshot = await window.agentTerminal.attachSession(sessionId, dims.cols, dims.rows, activeRef.current);
      if (disposed) {
        window.agentTerminal.detachSession(sessionId);
        return;
      }
      const segments = snapshot.segments;
      dbg(`buffer session=${sessionId} end=${snapshot.endOffset} segs=${segments.map((s) => `${s.cols}x${s.rows}+${s.data.length}`).join(" ")} queued=${merge.queuedCount}`);
      // The queue is deliberately kept: what it holds raced the reply and is
      // not in these segments. replayPending merges it in by offset.
      merge.openSnapshot(snapshot.endOffset);
      terminal.reset();
      const writeNext = (index = 0) => {
        if (disposed) return;
        const segment = segments[index];
        if (segment === undefined) {
          applyZoom();
          replayPending();
          return;
        }
        // Each segment is rendered at its recorded grid - the journal
        // replays 1:1 exactly the way the live clients applied it.
        if (segment.cols !== terminal.cols || segment.rows !== terminal.rows) {
          terminal.resize(segment.cols, segment.rows);
          applyZoom();
        }
        terminal.write(segment.data, () => writeNext(index + 1));
      };
      writeNext();
    })().catch((cause) => {
      // A rejected attach used to leave the pane queueing forever behind a
      // silent unhandled rejection - no output, no error, and no detach
      // either, since cleanup detaches only when this promise settles. Say
      // so in the pane the way the phone does.
      if (disposed) return;
      dbg(`attach session=${sessionId} failed: ${String(cause)}`);
      terminal.write(`\r\n\x1b[31mCould not attach terminal: ${String(cause)}\x1b[0m\r\n`);
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

  // Repaint a live terminal when the shared scheme changes, so switching the
  // app between light and dark (or picking another scheme) recolors the open
  // sessions instead of waiting for a fresh one.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = xtermThemeFor(scheme);
  }, [scheme]);

  // The pane letterboxes the host grid, so its surround must be the scheme's
  // own background rather than a fixed black.
  return <div ref={hostRef} className={`terminal-pane ${visible ? "is-visible" : ""} ${active ? "is-active" : ""}`} style={{ "--terminal-bg": scheme.background } as CSSProperties}>
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
