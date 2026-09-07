import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { applyTerminalModifiers, BASELINE_TERMINAL_ZOOM, CLOSED_FIND, ConsoleFrame, applyFindResults, closeFind, findCommandForKey, findDecorationsFor, findHttpLinks, findStatusLabel, openFind, setFindQuery, gridForContent, extrapolatedCell, nearestTerminalZoom, steppedTerminalZoom, streamByteLength, TERMINAL_SCROLLBACK_LINES, writeHostChunk, terminalZoomFontSize, xtermThemeFor, zoomedFontSize, type FindState, type Size, type TerminalModifier, type TerminalScheme } from "@agentterminal/protocol";
import { JournalMerge, planSegmentReplay } from "./terminal-stream";
import "@xterm/xterm/css/xterm.css";

interface Props { sessionId: string; visible: boolean; active: boolean; confirmExternalLinks: boolean; scheme: TerminalScheme; }

// The font size a 100% zoom paints at - the pane's baseline, and the size a
// desktop that is the session's only client sizes the PTY from.
const BASE_FONT_SIZE = 14;

// A zoom correction is a fixed point: raising the font size changes the
// measured cell size, which can call for another (smaller) correction. Cap
// the self-correcting loop per trigger so a pathological measurement cannot
// spin forever; two or three passes is the normal case.
const MAX_ZOOM_PASSES = 4;

const isCursorPositionReport = (data: string) => /^\x1b\[\??\d+;\d+R$/.test(data);

// A Device Attributes reply (`ESC [ ? ... c` / `ESC [ > ... c`). Like a CPR
// it answers a query the shell issued, so it is forwarded whether or not this
// pane is the active tab and validated against the shell's outstanding
// queries by the tray - a replayed journal still carries the original query,
// and an unsolicited reply reaches the shell as typed input.
const isDeviceAttributesReport = (data: string) => /^\x1b\[[?>][\d;]*c$/.test(data);

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
  const resizeRef = useRef<(claim?: boolean) => void>(() => undefined);
  // The in-flight attach, so the join/leave effect below can sequence a
  // release after it: a release can never be sent before the claim that
  // attach may still be about to register (see the [visible] effect).
  const pendingAttachRef = useRef<Promise<void>>(Promise.resolve());
  const confirmExternalLinksRef = useRef(confirmExternalLinks);
  const schemeRef = useRef(scheme);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [linkOpening, setLinkOpening] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // A blocking "replaying" overlay covers the pane for the whole journal
  // replay: the buffer is reset and re-rendered segment by segment, and
  // showing that storm behind a spinner reads as loading, not activity.
  // false only when the pending drain completes (finishAttachment).
  const [replaying, setReplaying] = useState(true);
  // Find is per pane: each split searches its own buffer and keeps its own
  // bar, exactly as each keeps its own selection and zoom.
  const [findState, setFindState] = useState<FindState>(CLOSED_FIND);
  const searchRef = useRef<SearchAddon | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
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

  // Runs the query against this pane's buffer. `incremental` is set while the
  // user is still typing, which keeps the active match anchored where it is
  // instead of jumping the viewport on every keystroke; the arrows and Enter
  // pass it off so they actually step.
  const runSearch = (query: string, direction: "next" | "previous", incremental = false) => {
    const search = searchRef.current;
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      return;
    }
    const options = { incremental, decorations: findDecorationsFor(scheme) };
    if (direction === "previous") search.findPrevious(query, options);
    else search.findNext(query, options);
  };

  // Leaves find: the highlights go, and the shell gets the keyboard back.
  const dismissFind = () => {
    searchRef.current?.clearDecorations();
    setFindState(closeFind);
    terminalRef.current?.focus();
  };

  const changeFindQuery = (query: string) => {
    setFindState((state) => setFindQuery(state, query));
    runSearch(query, "next", true);
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      // Find highlights every match with a decoration, and xterm gates
      // registerDecoration (and therefore the addon's result counts) behind
      // this flag. Without it the first search throws.
      allowProposedApi: true,
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
    // Find searches this pane's own buffer; nothing about it crosses the host
    // connection, so two clients on the same session search independently.
    const search = new SearchAddon();
    terminal.loadAddon(search);
    searchRef.current = search;
    const searchResults = search.onDidChangeResults((event) => setFindState((state) => applyFindResults(state, event)));
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
    // The zoom readout. Unlike the copy toast it needs no measurement to
    // place - it is pinned to the top of the pane by CSS - so it can report
    // a zoom press that happens before the grid has been painted.
    let zoomToastTimer: number | undefined;
    const zoomToast = document.createElement("div");
    zoomToast.className = "terminal-zoom-toast";
    zoomToast.setAttribute("role", "status");
    zoomToast.setAttribute("aria-live", "polite");
    hostRef.current.appendChild(zoomToast);
    const showZoomToast = (percent: number) => {
      zoomToast.textContent = `${percent}%`;
      zoomToast.classList.add("is-visible");
      if (zoomToastTimer) window.clearTimeout(zoomToastTimer);
      zoomToastTimer = window.setTimeout(() => zoomToast.classList.remove("is-visible"), 1_100);
    };

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
    // Single rendering path (grid ownership): the host PTY grid is the
    // active client's own announced viewport, verbatim - a pane narrower
    // than the PTY simply zooms out, so it still renders the host grid
    // exactly and the raw journal replays 1:1 with no re-wrapping at the
    // pane's own size. The host grid is followed in EVERY mode.
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
    // The user's zoom, as a percentage of the baseline (see
    // terminal-zoom.ts), and the font size it paints at. Zoom asks the host
    // for a different GRID - fewer, bigger cells, or more, smaller ones -
    // rather than just repainting this pane at a different size, which no
    // other client could see.
    let zoomPercent: number = BASELINE_TERMINAL_ZOOM;
    const zoomFontSize = () => terminalZoomFontSize(BASE_FONT_SIZE, zoomPercent);
    // Measured cell sizes, keyed by the font size they were taken at, and
    // only ever recorded while the emulator is actually painting at a zoom
    // stop's own size. That exclusion is what keeps the announcement from
    // feeding back on itself: a pane rendering a grid it does not own is
    // painting at a fill-derived font size (see applyZoom), and announcing
    // from THAT cell would just re-announce the grid it was handed, locking
    // the pane to another client's size for good.
    const cellByFontSize = new Map<number, Size>();
    const captureZoomCell = () => {
      const fontSize = terminal.options.fontSize;
      if (fontSize === undefined || fontSize !== zoomFontSize()) return;
      const measured = cellSize();
      if (measured) cellByFontSize.set(fontSize, measured);
    };
    // The cell the current zoom stop actually renders at. Measured once the
    // stop has painted; until then - the frame between asking for a stop and
    // rendering it, and only then - extrapolated from the nearest stop that
    // has, so the pane can still propose a grid rather than stall.
    const zoomCell = (): Size | null => {
      const target = zoomFontSize();
      const measured = cellByFontSize.get(target);
      if (measured) return measured;
      let nearest: [number, Size] | null = null;
      for (const entry of cellByFontSize) {
        if (!nearest || Math.abs(entry[0] - target) < Math.abs(nearest[0] - target)) nearest = entry;
      }
      return nearest ? extrapolatedCell(nearest[1], nearest[0], target) : null;
    };
    const proposeGrid = () => {
      captureZoomCell();
      const content = contentBox();
      if (!content) return null;
      return gridForContent(content, zoomCell());
    };
    // Whether the emulator is showing the grid this pane last ASKED for.
    //
    // Deliberately compared against the last announcement rather than a
    // freshly proposed grid: between a pane resize and the host echoing the
    // new grid back, a fresh proposal already reflects the new box while the
    // emulator still holds the old grid, and reading that momentary
    // disagreement as "another client owns this" would drop the pane into
    // the fill search for a frame - the same unsteadiness zooming had. A
    // grid that comes back DIFFERENT from the one asked for is the real
    // signal that someone else owns it (and a replay's historical grids,
    // which the fill is equally right for).
    const paneOwnsGrid = () => terminal.cols === viewportCols && terminal.rows === viewportRows;
    // Announce, don't assert: the pane's proposed dimensions are its
    // viewport (W_i, H_i), recorded into the host's fallback pool whether
    // or not this pane owns the grid. A real interaction re-announces
    // (force), which both claims ownership and re-applies the size even
    // when the pane's own size has not changed. Never fit(): the emulator's
    // grid is the host's, not the container's.
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
    // Paint the grid the emulator is holding across the pane.
    //
    // When the pane owns that grid there is nothing to search for: the grid
    // WAS the count of whole cells that fit the content box at this stop's
    // font size, so painting at that font size fills the pane to within one
    // cell on each axis by construction. Running a fill on top of it is what
    // made zooming feel unsteady - each pass re-derived a fractional font
    // size from the sub-cell slack left over by the flooring, and xterm
    // requantises glyph advance and line height independently at every one
    // of those sizes, so the cell's shape, and the letterbox around it,
    // shifted on every step.
    //
    // A grid the pane does NOT own is the case the fill was written for: it
    // can be any size at all - a phone's 40x20 - so the font size genuinely
    // is a search for the fit, and stays a fixed point (a font-size change
    // moves the measured cell, so re-measure and correct again next frame,
    // capped at MAX_ZOOM_PASSES). It never touches the announcement, which
    // is derived only from measurements taken at a zoom stop's own size.
    const applyZoom = (passesLeft = MAX_ZOOM_PASSES) => {
      if (!visibleRef.current || passesLeft <= 0) return;
      if (paneOwnsGrid()) {
        // Assigning fontSize makes xterm remeasure and repaint, so only do
        // it when the size actually moves.
        const exact = zoomFontSize();
        if (terminal.options.fontSize !== exact) terminal.options.fontSize = exact;
        return;
      }
      const content = contentBox();
      const cell = cellSize();
      const next = zoomedFontSize(terminal.options.fontSize ?? BASE_FONT_SIZE, { cols: terminal.cols, rows: terminal.rows }, cell, content);
      if (next === null) return;
      terminal.options.fontSize = next;
      requestAnimationFrame(() => applyZoom(passesLeft - 1));
    };
    // Settle on a stop of the zoom ladder and re-announce. The pane's
    // rendering is deliberately NOT touched here: the announce asks the host
    // for a new grid, the host echoes it back to every client, and the fill
    // pass above then grows the font to paint that grid across this pane -
    // so a zoom takes the same path as any other resize, and a phone sharing
    // the session sees it too. The toast fires even when the zoom did not
    // move, so a press at either end of the ladder still reads as handled.
    const applyZoomPercent = (next: number) => {
      const settled = nearestTerminalZoom(next);
      showZoomToast(settled);
      if (settled === zoomPercent) return;
      zoomPercent = settled;
      dbg(`zoom session=${sessionId} percent=${settled}`);
      // Repaint at the new stop FIRST, then announce off a real measurement
      // of it a frame later: the grid this pane asks for has to be the cells
      // that fit at the size it is actually painting at, never an
      // extrapolation of them. Until the host echoes the new grid back the
      // emulator holds the old one at the new size, which the pane clips
      // rather than reflowing - one frame, and no re-wrap of the buffer.
      terminal.options.fontSize = zoomFontSize();
      requestAnimationFrame(() => {
        if (disposed) return;
        captureZoomCell();
        // Suppressed for the duration of a journal replay, exactly like a
        // click-claim: the pane's size is being driven by the replayed
        // segments. finishAttachment announces once the drain is done, so
        // the press is never simply lost.
        if (!merge.attached) return;
        // Zooming is an explicit interaction with THIS pane, so it claims
        // the PTY grid the way a click or a tab switch does.
        announceViewport(true);
      });
    };
    // Ctrl+-, Ctrl+= and Ctrl+0 are the pane's zoom out / in / reset.
    // Both the printable key and the physical code are accepted: "=" arrives
    // as "+" when shifted, "-" as "_", and the numpad reports neither (nor
    // even a digit for Numpad0 with NumLock off).
    const zoomIntent = (event: KeyboardEvent): number | null => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return null;
      if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return -1;
      if (event.key === "=" || event.key === "+" || event.code === "NumpadAdd") return 1;
      if (event.key === "0" || event.code === "Numpad0") return 0;
      return null;
    };
    // Every grid change and every stream write goes through `frame`, never
    // terminal.resize/write: growing the grid back after a smaller client
    // owned it reclaims scrollback that the console's repaint would then
    // paint its blank rows over, losing that history (see ConsoleFrame).
    const frame = new ConsoleFrame();
    const applyGridInPlace = (cols: number, rows: number) => {
      if (frame.applyGrid(terminal, cols, rows)) applyZoom();
    };

    const resize = (claim = false) => {
      if (!visibleRef.current) return;
      applyZoom();
      // Organic viewport announces are suppressed for the whole journal
      // replay: the ResizeObserver still fires as the replayed segments
      // resize the emulator, and announcing the container grid then would
      // stamp the PTY - and re-stamp every other client - mid-replay.
      // finishAttachment re-announces once the drain is done.
      if (!merge.attached) return;
      // A visible pane always announces, active or not: a visible-but-
      // inactive split pane stays in set S (a fallback owner candidate) but
      // only ever claims when told to (a real interaction, or becoming the
      // active pane) - never merely because it is visible.
      announceViewport(claim);
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

      // Zoom is claimed before the Ctrl-forwarding below, which would
      // otherwise turn these into control sequences for the shell.
      // preventDefault also stops WebView2 scaling the whole window.
      const zoom = zoomIntent(event);
      if (zoom !== null) {
        event.preventDefault();
        applyZoomPercent(zoom === 0 ? BASELINE_TERMINAL_ZOOM : steppedTerminalZoom(zoomPercent, zoom));
        return false;
      }

      // Ctrl+F opens this pane's find bar, seeded from the selection if there
      // is one. Ctrl+Shift+F is deliberately left alone so it falls through to
      // the forwarding below as a plain \x06: shells bind that key (bash's
      // forward-char, tmux prefixes), and claiming Ctrl+F outright would
      // otherwise put it out of reach entirely.
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        const selection = terminal.getSelection();
        setFindState((state) => openFind(state, selection));
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
    const handlePointerActivity = (event: PointerEvent) => {
      // A click on THIS pane is an interaction: force a viewport announce
      // so the host applies this pane's size to the PTY grid in a TUI
      // period even when the pane's own size did not change. Scoped to the
      // pane itself (not the whole window) so a click on the sidebar or
      // tab bar never claims the grid for whatever pane happens to be
      // active - matching the mobile client's own tap handling. Suppressed
      // while a journal replay is in flight (attach request, segment
      // writes, pending drain): the pane's size is being driven by the
      // replayed segments, and a click-claim would stamp the PTY - and
      // re-stamp every other client - mid-replay; finishAttachment
      // re-announces once the drain is done.
      if (!activeRef.current || !merge.attached || !(event.target instanceof Node) || !hostRef.current?.contains(event.target)) return;
      announceViewport(true);
    };
    window.addEventListener("pointerdown", handlePointerActivity, true);
    const inputDims = () => proposeGrid() ?? { cols: terminal.cols, rows: terminal.rows };
    const dataSubscription = terminal.onData((data) => {
      const dims = inputDims();
      if (isCursorPositionReport(data) || isDeviceAttributesReport(data)) {
        // A newly created pane is attached before it becomes the active tab.
        // Forward terminal-generated query replies even while hidden; the
        // tray validates them against the shell's outstanding queries.
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
      writeHostChunk(frame, terminal, data);
    });
    // The latest live grid that arrived while the replay/drain was still
    // running. `merge.attached` turns true only when the drain completes, so
    // a grid broadcast that lands mid-replay must not be applied in place:
    // the replay plan's own segment resizes execute interleaved with it
    // (xterm writes are async), and a plan resize that lands LATER would
    // stomp the live grid, leaving the pane at the last replayed segment's
    // grid - e.g. the phone's 73x24 - while the PTY is back at the
    // desktop's. Record it instead and settle it when the replay/drain ends
    // (runPlanOp's tail, before the live drain writes, and
    // finishAttachment, for grids that land mid-drain).
    let lastLiveGrid: { cols: number; rows: number } | null = null;
    const settleLiveGrid = () => {
      if (lastLiveGrid !== null) applyGridInPlace(lastLiveGrid.cols, lastLiveGrid.rows);
    };
    const offGrid = window.agentTerminal.onGrid((id, cols, rows) => {
      if (id !== sessionId) return;
      lastLiveGrid = { cols, rows };
      if (merge.attached) applyGridInPlace(cols, rows);
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
      setReplaying(false);
      // Settle any live grid that arrived after the plan settled (mid-drain):
      // the pane must end at the host's current grid, not the last replayed
      // segment's (see offGrid).
      settleLiveGrid();
      // The replay's announce gate has lifted: resync the container grid in
      // case it changed while the replay ran (its ResizeObserver fired but
      // announceViewport was suppressed). Opening the active tab is an
      // interaction, so the active pane claims here: its attach claim
      // predated the first paint (or was absent), and this is the pane's
      // real post-replay size. A same-size claim is a no-op at the host
      // (no second PTY resize, no extra reflow), so a well-measured
      // attach costs nothing.
      resizeRef.current(activeRef.current);
    };
    const replayPending = () => {
      if (disposed) return;
      const item = merge.nextQueued();
      if (item === null) {
        finishAttachment();
        return;
      }
      dbg(`pend session=${sessionId} off=${item.offset} len=${streamByteLength(item.data)} upTo=${merge.appliedUpTo}`);
      writeHostChunk(frame, terminal, item.data, () => replayPending());
    };
    // Full replay is needed only on initial attach (and reconnect): the
    // pane's size is at least the PTY's, so the segments replay 1:1 with no
    // re-wrapping at the pane's own grid.
    initialAttachPromise = (async () => {
      const proposed = proposeGrid();
      const dims = proposed ?? { cols: terminal.cols, rows: terminal.rows };
      viewportCols = dims.cols;
      viewportRows = dims.rows;
      // Reset the merge before the request goes out, never after the reply:
      // the host subscribes this window inside the lock that takes the
      // snapshot, so chunks past its end arrive while the reply is still in
      // flight and have to survive until the replay merges them.
      merge.restart();
      // Blur the terminal for the replay's whole duration (attach in
      // flight, segment writes, pending drain): the buffer is about to be
      // reset and re-rendered segment by segment, and a focused cursor over
      // a half-replayed buffer just flickers. finishAttachment hands focus
      // back when the drain completes.
      terminal.blur();
      setReplaying(true);
      dbg(`attach send session=${sessionId} viewport=${dims.cols}x${dims.rows}${proposed ? "" : " (unmeasured - claiming deferred to finishAttachment)"}`);
      // Claim the grid only for a pane that (a) was the active tab at
      // mount - a background or hidden tab must not steal it from the
      // client that is actually in use (an unclaimed attach is a pure
      // stream subscription - see attach_owner_grid_for); `visibleRef`
      // is defensive: `active` is only ever true while `visible` is
      // (App.tsx), but the claim itself must never outrun that invariant
      // - AND (b) with a MEASURED viewport. Before the first paint,
      // proposeGrid is null and `dims` is xterm's own unfitted grid,
      // not this pane's size: claiming it would resize the shared PTY to
      // a grid the pane never displayed. finishAttachment then claims
      // with the pane's real post-replay size.
      const claim = proposed !== null && visibleRef.current && activeRef.current;
      const snapshot = await window.agentTerminal.attachSession(sessionId, dims.cols, dims.rows, claim);
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
      // Execute the snapshot as a plan of ops (see planSegmentReplay): a
      // resize only when a segment's recorded grid differs from the
      // running one, so consecutive same-grid segments never re-flow the
      // buffer, and a zero-length segment still performs its swap.
      const plan = planSegmentReplay(segments, { cols: terminal.cols, rows: terminal.rows });
      const runPlanOp = (index = 0) => {
        if (disposed) return;
        const op = plan[index];
        if (op === undefined) {
          // Settle a live grid that arrived while the plan ran BEFORE the
          // drain: the queued chunks are live host output produced at the
          // host's CURRENT grid, so they must be written at that grid, not
          // the last replayed segment's (which the plan just left the
          // emulator at). finishAttachment settles it again for grids that
          // land mid-drain.
          settleLiveGrid();
          applyZoom();
          replayPending();
          return;
        }
        if (op.kind === "resize") {
          frame.applyGrid(terminal, op.cols, op.rows);
          applyZoom();
          runPlanOp(index + 1);
          return;
        }
        writeHostChunk(frame, terminal, op.data, () => runPlanOp(index + 1));
      };
      runPlanOp();
    })().catch((cause) => {
      // A rejected attach used to leave the pane queueing forever behind a
      // silent unhandled rejection - no output, no error, and no detach
      // either, since cleanup detaches only when this promise settles. Say
      // so in the pane the way the phone does.
      if (disposed) return;
      dbg(`attach session=${sessionId} failed: ${String(cause)}`);
      // A failed attach never drains the merge, so close the blur/focus
      // lifecycle explicitly and let the pane show its error.
      finishAttachment();
      terminal.write(`\r\n\x1b[31mCould not attach terminal: ${String(cause)}\x1b[0m\r\n`);
    });
    pendingAttachRef.current = initialAttachPromise;
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
      if (zoomToastTimer) window.clearTimeout(zoomToastTimer);
      httpLinkProvider.dispose();
      searchResults.dispose();
      search.dispose();
      searchRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      resizeRef.current = () => undefined;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      // A background pane's find bar would keep highlights on a buffer nobody
      // is looking at, and its input would still hold the keyboard.
      searchRef.current?.clearDecorations();
      setFindState(closeFind);
      terminalRef.current?.blur();
      return;
    }
    // Selecting this tab is an explicit open of THIS terminal, so the
    // announce claims the PTY grid: the phone may have owned it, and the
    // pane the user just brought to the front is the one that should size
    // the session now.
    resizeRef.current(true);
    terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!visible) {
      // Every session's pane stays mounted and subscribed for as long as
      // its project is open (App.tsx renders them all); only the viewport
      // - set S membership - follows visibility. A hidden pane releases
      // instead of detaching, so switching back needs no journal replay,
      // and ownership deterministically hands off to whichever other
      // client is still actually showing the session. Sequenced after the
      // in-flight attach: a release can never be overtaken by the claim
      // that attach may still be about to register.
      void pendingAttachRef.current.then(() => window.agentTerminal.releaseSessionViewport(sessionId));
      return;
    }
    // Becoming visible re-joins set S, claiming only if this is also the
    // active tab (a visible-but-inactive split pane joins unclaimed - see
    // the resize() comment above).
    const frame = window.requestAnimationFrame(() => resizeRef.current(activeRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [visible, sessionId]);

  // Opening the bar hands it the keyboard, and selects whatever query it was
  // seeded with so typing replaces it rather than appending to it.
  useEffect(() => {
    if (!findState.open) return;
    const input = findInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [findState.open]);

  // Repaint a live terminal when the shared scheme changes, so switching the
  // app between light and dark (or picking another scheme) recolors the open
  // sessions instead of waiting for a fresh one.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = xtermThemeFor(scheme);
    // Decoration colors are baked into each match when it is drawn, so a live
    // find has to be re-run for its highlights to follow the new scheme.
    if (findState.open && findState.query) runSearch(findState.query, "next", true);
  }, [scheme]);

  // The pane letterboxes the host grid, so its surround must be the scheme's
  // own background rather than a fixed black.
  return <div ref={hostRef} className={`terminal-pane ${visible ? "is-visible" : ""} ${active ? "is-active" : ""}`} style={{ "--terminal-bg": scheme.background } as CSSProperties}>
    {replaying && <div className="replay-overlay"><span className="replay-spinner" /><span>Loading terminal…</span></div>}
    {findState.open && <div className="terminal-find-bar" role="search" onMouseDown={(event) => event.stopPropagation()}>
      <input
        ref={findInputRef}
        type="text"
        className="terminal-find-input"
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        autoComplete="off"
        value={findState.query}
        onChange={(event) => changeFindQuery(event.target.value)}
        onKeyDown={(event) => {
          const command = findCommandForKey(event);
          if (command === "none") return;
          event.preventDefault();
          if (command === "close") dismissFind();
          else runSearch(findState.query, command);
        }}
      />
      <span className="terminal-find-count" role="status" aria-live="polite">{findStatusLabel(findState)}</span>
      <button type="button" aria-label="Previous match" disabled={findState.count === 0} onMouseDown={(event) => event.preventDefault()} onClick={() => runSearch(findState.query, "previous")}>↑</button>
      <button type="button" aria-label="Next match" disabled={findState.count === 0} onMouseDown={(event) => event.preventDefault()} onClick={() => runSearch(findState.query, "next")}>↓</button>
      <button type="button" aria-label="Close find" onClick={dismissFind}>✕</button>
    </div>}
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
