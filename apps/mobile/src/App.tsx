import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint
} from "@capacitor/barcode-scanner";
import type { DirectoryListing, HostSnapshot, PairingPayload, Platform, Project, TerminalSession } from "@agentterminal/protocol";
import { createRequestId, MAX_PROJECT_NAME_LENGTH, parsePairingPayload } from "@agentterminal/protocol";
import { HostConnection, type RemoteRegistrationState } from "./connection";
import { ConnectionNotification } from "./connection-notification";
import { notificationStateFor, type ConnectionNotificationState } from "./connectionPolicy";
import { deviceName } from "./device";
import { classifyGestureAxis, shouldBridgeTapClick, shouldBridgeTapControl, shouldSwallowTrailingClick } from "./gesture";
import { BackIcon, BookmarkIcon, ChevronIcon, ClockIcon, CloseIcon, EditIcon, FolderIcon, MoreIcon, PlusIcon, ScanIcon, SettingsIcon, TerminalIcon, WifiIcon } from "./icons";
import { MobileTerminal } from "./MobileTerminal";

type View = { type: "home" } | { type: "project"; projectId: string } | { type: "terminal"; sessionId: string; projectId: string };
const TERMINAL_FONT_WIDTH_KEY = "agent-terminal-font-width-percent";
const SWALLOW_CLICK_LINGER_MS = 600;
const SWALLOW_CLICK_DISTANCE_PX = 48;

interface ProjectDragState {
  projectId: string;
  pointerId: number;
  startY: number;
  deltaY: number;
  startIndex: number;
  targetIndex: number;
  didMove: boolean;
  centers: number[];
}

interface SwipeState {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  deltaX: number;
  horizontal: boolean;
}

export function App() {
  const [connection, setConnection] = useState<HostConnection | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "pairing" | "connecting" | "connected" | "error">("loading");
  const [error, setError] = useState("");
  const [remoteRegistration, setRemoteRegistration] = useState<RemoteRegistrationState>({ status: "unregistered" });
  const [manualCode, setManualCode] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [view, setView] = useState<View>({ type: "home" });
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectToRename, setProjectToRename] = useState<Project | null>(null);
  const [sessionToClose, setSessionToClose] = useState<TerminalSession | null>(null);
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);
  const [fontWidthPercent, setFontWidthPercent] = useState(100);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [projectDrag, setProjectDrag] = useState<ProjectDragState | null>(null);
  const [projectReordering, setProjectReordering] = useState(false);
  const [swipe, setSwipe] = useState<SwipeState | null>(null);
  const connectionRef = useRef<HostConnection | null>(null);
  connectionRef.current = connection;
  const screenAwakeRef = useRef(true);
  const navigationRef = useRef({ view, status, showCreateProject, projectToRename, sessionToClose, showTerminalSettings });
  navigationRef.current = { view, status, showCreateProject, projectToRename, sessionToClose, showTerminalSettings };
  const projectDragRef = useRef<ProjectDragState | null>(null);
  const projectElementsRef = useRef(new Map<string, HTMLElement>());
  const swipeRef = useRef<SwipeState | null>(null);
  const suppressSwipeClickRef = useRef(false);
  const swipeClickPageRef = useRef<number | null>(null);
  const swipeClickTimerRef = useRef<number | undefined>(undefined);
  const swallowTapClickRef = useRef(false);
  const swallowTapClickAtRef = useRef({ x: 0, y: 0 });
  const swallowTapClickTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    void Preferences.get({ key: TERMINAL_FONT_WIDTH_KEY }).then(({ value }) => {
      if (value === null) return;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) setFontWidthPercent(Math.max(65, Math.min(100, parsed)));
    });
  }, []);

  useEffect(() => {
    const ids = snapshot?.projects.map((project) => project.id) ?? [];
    // The snapshot is the host's canonical order. Reconcile local optimistic
    // drag state with it so reorders made in another client are applied here.
    setProjectOrder(ids);
  }, [snapshot?.projects]);

  const orderedProjects = useMemo(() => {
    const positions = new Map(projectOrder.map((id, index) => [id, index]));
    return [...(snapshot?.projects ?? [])].sort((left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }, [snapshot?.projects, projectOrder]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    const listener = CapacitorApp.addListener("backButton", () => {
      const navigation = navigationRef.current;
      if (navigation.showTerminalSettings) {
        setShowTerminalSettings(false);
        return;
      }
      if (navigation.projectToRename) {
        setProjectToRename(null);
        return;
      }
      if (navigation.sessionToClose) {
        setSessionToClose(null);
        return;
      }
      if (navigation.showCreateProject) {
        setShowCreateProject(false);
        return;
      }
      if (navigation.status !== "connected") return;
      if (navigation.view.type === "terminal") {
        setView({ type: "project", projectId: navigation.view.projectId });
        return;
      }
      if (navigation.view.type === "project") {
        setView({ type: "home" });
        return;
      }
      void stopConnectionNotification();
      void CapacitorApp.exitApp();
    });
    return () => { void listener.then((handle) => handle.remove()); };
  }, []);

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    let disposed = false;
    let disconnectListener: PluginListenerHandle | undefined;
    let timeoutListener: PluginListenerHandle | undefined;
    void ConnectionNotification.addListener("disconnectRequested", () => {
      connectionRef.current?.close();
      void stopConnectionNotification();
      setSnapshot(null);
      setError("Disconnected from the desktop by the notification.");
      setStatus("error");
    }).then((handle) => {
      if (disposed) void handle.remove();
      else disconnectListener = handle;
    });
    void ConnectionNotification.addListener("reconnectTimedOut", () => {
      connectionRef.current?.close();
      setSnapshot(null);
      setError("Could not reach the desktop within 30 seconds.");
      setStatus("error");
      void stopConnectionNotification();
    }).then((handle) => {
      if (disposed) void handle.remove();
      else timeoutListener = handle;
    });
    return () => {
      disposed = true;
      void disconnectListener?.remove();
      void timeoutListener?.remove();
    };
  }, []);

  useEffect(() => {
    // Freeze decorative CSS animations while the app is not visible so the
    // phone can idle: infinite spin/pulse/scan effects render nothing useful
    // once the screen it belongs to is hidden.
    const updateMotionClass = () => document.body.classList.toggle("economy-motion", document.hidden);
    document.addEventListener("visibilitychange", updateMotionClass);
    updateMotionClass();
    return () => {
      document.removeEventListener("visibilitychange", updateMotionClass);
      document.body.classList.remove("economy-motion");
    };
  }, []);

  useEffect(() => {
    if (Capacitor.getPlatform() === "android") {
      let disposed = false;
      let screenListener: PluginListenerHandle | undefined;
      const applyScreenAwake = (awake: boolean) => {
        if (disposed) return;
        screenAwakeRef.current = awake;
        connectionRef.current?.setScreenAwake(awake);
      };
      void ConnectionNotification.getScreenState().then(({ awake }) => applyScreenAwake(awake));
      void ConnectionNotification.addListener("screenState", ({ awake }) => applyScreenAwake(awake)).then((handle) => {
        if (disposed) void handle.remove();
        else screenListener = handle;
      });
      return () => {
        disposed = true;
        void screenListener?.remove();
      };
    }
    const update = () => {
      screenAwakeRef.current = !document.hidden;
      connectionRef.current?.setScreenAwake(screenAwakeRef.current);
    };
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const listener = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) connectionRef.current?.retryNow();
    });
    const handleOnline = () => {
      const current = connectionRef.current;
      if (!current) return;
      current.retryNow();
      if (!current.isConnected()) void updateConnectionNotification(current.host.name, notificationStateFor(true, false));
    };
    const handleOffline = () => {
      const current = connectionRef.current;
      if (!current) return;
      current.notifyNetworkLost();
      void updateConnectionNotification(current.host.name, notificationStateFor(false, false));
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      void listener.then((handle) => handle.remove());
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let current: HostConnection | null = null;
    void HostConnection.saved().then(async (host) => {
      if (disposed) return;
      if (!host) { setStatus("pairing"); return; }
      setStatus("connecting");
      current = new HostConnection(host);
      current.setScreenAwake(screenAwakeRef.current);
      setRemoteRegistration(current.remoteRegistrationState());
      current.startAutoReconnect();
      setConnection(current);
      void updateConnectionNotification(current.host.name, "reconnecting");
      try {
        const nextSnapshot = await current.connect();
        if (disposed) return;
        setSnapshot(nextSnapshot);
        await startConnectionNotification(current.host.name);
        setStatus("connected");
      } catch (cause) {
        if (disposed || current.isClosed()) return;
        if (isAuthorizationError(cause) || isEmbeddedNodeConfigurationError(cause)) {
          current.stopAutoReconnect();
          await stopConnectionNotification();
          setError(cause instanceof Error ? cause.message : "Could not connect to the saved desktop.");
          setStatus("error");
          return;
        }
        void updateConnectionNotification(current.host.name, notificationStateFor(navigator.onLine, false));
        setError("The desktop connection could not be opened. Retrying…");
        setStatus("connecting");
      }
    });
    return () => {
      disposed = true;
      current?.close();
    };
  }, []);

  useEffect(() => {
    if (!connection) return;
    const offSnapshot = connection.on("snapshot", setSnapshot);
    const offConnected = connection.on("connected", (nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setError("");
      setStatus("connected");
      void startConnectionNotification(connection.host.name);
    });
    const offHeartbeat = connection.on("heartbeat", () => {
      // The native service can detect a route loss while the WebSocket still
      // reports OPEN. A successful heartbeat is the authoritative recovery
      // signal for the notification in that case.
      setError("");
      setStatus("connected");
      void updateConnectionNotification(connection.host.name, "connected");
    });
    const offReconnecting = connection.on("reconnecting", ({ attempt }) => {
      setError(attempt === 1 ? "The desktop connection was lost. Reconnecting…" : "Still trying to reach the desktop…");
      setStatus("connecting");
      void updateConnectionNotification(connection.host.name, notificationStateFor(navigator.onLine, false));
    });
    const offReconnectFailed = connection.on("reconnectFailed", (cause) => {
      setSnapshot(null);
      setError(cause.message);
      setStatus("error");
      void stopConnectionNotification();
    });
    const offDisconnect = connection.on("disconnected", () => {
      setError("The desktop connection was lost. Reconnecting…");
      setStatus("connecting");
      void updateConnectionNotification(connection.host.name, notificationStateFor(navigator.onLine, false));
    });
    const offRemoteRegistration = connection.on("remoteRegistration", setRemoteRegistration);
    setRemoteRegistration(connection.remoteRegistrationState());
    return () => { offSnapshot(); offConnected(); offHeartbeat(); offReconnecting(); offReconnectFailed(); offDisconnect(); offRemoteRegistration(); };
  }, [connection]);

  async function pair(raw: string) {
    setStatus("connecting"); setError("");
    try {
      const payload: PairingPayload = parsePairingPayload(raw.trim());
      const platform = (Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web") as Platform;
      const next = await HostConnection.pair(payload, { id: crypto.randomUUID(), name: await deviceName(), platform });
      connection?.close();
      next.startAutoReconnect();
      next.setScreenAwake(screenAwakeRef.current);
      setConnection(next); setSnapshot(next.snapshot ?? null); setRemoteRegistration(next.remoteRegistrationState()); setStatus("connected"); setView({ type: "home" });
      await startConnectionNotification(next.host.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pairing failed."); setStatus("pairing");
    }
  }

  async function scan() {
    setError("");
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "Scan the QR code shown in Agent Terminal",
        cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
        scanOrientation: CapacitorBarcodeScannerScanOrientation.ADAPTIVE,
        cancelButtonAccessibilityLabel: "Cancel QR scan",
        // Use Android's native ML Kit QR decoder. Camera exposure and focus
        // remain fully native; the app does not manipulate either setting.
        android: Capacitor.getPlatform() === "android"
          ? { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.MLKIT }
          : undefined
      });
      const raw = result.ScanResult?.trim();
      if (!raw) throw new Error("No QR code was detected. Move the phone closer and keep the entire code in the frame.");
      await pair(raw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The camera could not scan the code.");
    }
  }

  async function forgetHost() {
    connection?.close(); await stopConnectionNotification(); await HostConnection.forget();
    setConnection(null); setSnapshot(null); setRemoteRegistration({ status: "unregistered" }); setError(""); setStatus("pairing"); setView({ type: "home" });
  }

  function openProject(projectId: string) {
    setSelectedProjectId(projectId);
    setSelectedSessionId((current) => snapshot?.sessions.some((session) => session.id === current && session.projectId === projectId) ? current : null);
    setView({ type: "project", projectId });
  }

  function openTerminal(session: TerminalSession) {
    setSelectedProjectId(session.projectId);
    setSelectedSessionId(session.id);
    setView({ type: "terminal", sessionId: session.id, projectId: session.projectId });
  }

  function navigateBack() {
    if (view.type === "terminal") setView({ type: "project", projectId: view.projectId });
    else if (view.type === "project") setView({ type: "home" });
  }

  function beginProjectDrag(event: ReactPointerEvent<HTMLElement>, projectId: string, index: number) {
    const centers = orderedProjects.map((project) => {
      const bounds = projectElementsRef.current.get(project.id)?.getBoundingClientRect();
      return bounds ? bounds.top + bounds.height / 2 : 0;
    });
    if (centers.some((center) => center === 0)) return;
    const next: ProjectDragState = { projectId, pointerId: event.pointerId, startY: event.clientY, deltaY: 0, startIndex: index, targetIndex: index, didMove: false, centers };
    projectDragRef.current = next;
    setProjectDrag(next);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }

  function moveProjectDrag(event: ReactPointerEvent<HTMLElement>) {
    const current = projectDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - current.startY;
    const didMove = current.didMove || Math.abs(deltaY) > 4;
    const draggedCenter = current.centers[current.startIndex]! + deltaY;
    const targetIndex = didMove
      ? current.centers.reduce((nearest, center, index) => Math.abs(center - draggedCenter) < Math.abs(current.centers[nearest]! - draggedCenter) ? index : nearest, current.startIndex)
      : current.startIndex;
    if (didMove) event.preventDefault();
    const next = { ...current, deltaY, didMove, targetIndex };
    projectDragRef.current = next;
    setProjectDrag(next);
  }

  function finishProjectDrag(event: ReactPointerEvent<HTMLElement>, commit: boolean) {
    const current = projectDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (commit && current.didMove && current.targetIndex !== current.startIndex && connection) {
      const ids = orderedProjects.map((project) => project.id);
      ids.splice(current.targetIndex, 0, ...ids.splice(current.startIndex, 1));
      setProjectReordering(true);
      setProjectOrder(ids);
      void connection.request({ type: "project.reorder", requestId: createRequestId(), projectIds: ids }).catch(() => {
        setProjectOrder(snapshot?.projects.map((project) => project.id) ?? []);
      });
      // Let the reordered layout paint once with transitions disabled before
      // restoring the normal sibling-shift animation for the next drag.
      window.requestAnimationFrame(() => setProjectReordering(false));
    }
    projectDragRef.current = null;
    setProjectDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  }

  function projectDragTransform(projectId: string, index: number): string | undefined {
    if (!projectDrag) return undefined;
    if (projectId === projectDrag.projectId) return `translate3d(0,${projectDrag.deltaY}px,0)`;
    const previous = projectDrag.centers[Math.max(0, projectDrag.startIndex - 1)]!;
    const next = projectDrag.centers[Math.min(projectDrag.centers.length - 1, projectDrag.startIndex + 1)]!;
    const step = Math.abs(next - previous) / (projectDrag.startIndex > 0 && projectDrag.startIndex < projectDrag.centers.length - 1 ? 2 : 1) || 87;
    if (projectDrag.startIndex < projectDrag.targetIndex && index > projectDrag.startIndex && index <= projectDrag.targetIndex) return `translate3d(0,-${step}px,0)`;
    if (projectDrag.startIndex > projectDrag.targetIndex && index >= projectDrag.targetIndex && index < projectDrag.startIndex) return `translate3d(0,${step}px,0)`;
    return undefined;
  }

  async function closeSession(session: TerminalSession) {
    if (!connection) return;
    await connection.request({ type: "session.close", requestId: createRequestId(), sessionId: session.id });
    setSessionToClose(null);
    setView({ type: "project", projectId: session.projectId });
  }

  if (status === "loading" || status === "connecting") return <Splash label={status === "loading" ? "Opening Agent Terminal" : error || "Connecting to desktop"} />;
  if (status === "pairing") return <PairScreen error={error} manualCode={manualCode} showManual={showManual} onManualCode={setManualCode} onShowManual={() => setShowManual(true)} onScan={() => void scan()} onPair={() => void pair(manualCode)} />;
  if (status === "error") return <ErrorScreen message={error} onRetry={() => window.location.reload()} onForget={() => void forgetHost()} />;
  if (!connection || !snapshot) return null;

  const requestedProjectId = view.type === "home" ? selectedProjectId : view.projectId;
  const activeProject = snapshot.projects.find((item) => item.id === requestedProjectId);
  const requestedSessionId = view.type === "terminal" ? view.sessionId : selectedSessionId;
  const activeSession = snapshot.sessions.find((item) => item.id === requestedSessionId && (!activeProject || item.projectId === activeProject.id));
  const pageCount = 1 + (activeProject ? 1 : 0) + (activeProject && activeSession ? 1 : 0);
  const currentPage = Math.min(view.type === "terminal" ? 2 : view.type === "project" ? 1 : 0, pageCount - 1);

  function beginSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    // A new pointer sequence is a fresh interaction. Do not let a delayed
    // compatibility click from an earlier page transition consume this one.
    if (swipeClickTimerRef.current !== undefined) window.clearTimeout(swipeClickTimerRef.current);
    swipeClickTimerRef.current = undefined;
    if (swallowTapClickTimerRef.current !== undefined) window.clearTimeout(swallowTapClickTimerRef.current);
    swallowTapClickTimerRef.current = undefined;
    swallowTapClickRef.current = false;
    suppressSwipeClickRef.current = false;
    swipeClickPageRef.current = null;
    // Start tracking every touch, including touches that begin on a button.
    // We only turn it into a pager gesture after movement is classified as
    // horizontal, so a normal button tap keeps its native click behavior.
    const target = event.target instanceof Element ? event.target : undefined;
    const terminalText = target?.closest(".xterm-accessibility-tree");
    const selection = document.getSelection();
    const draggingTerminalSelection = Boolean(terminalText && selection && !selection.isCollapsed && selection.anchorNode && terminalText.contains(selection.anchorNode));
    if (swipeRef.current || event.pointerType === "mouse" || draggingTerminalSelection) return;
    const next: SwipeState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startedAt: performance.now(), deltaX: 0, horizontal: false };
    swipeRef.current = next;
  }

  function moveSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    const current = swipeRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const rawX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (!current.horizontal) {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && selection.anchorNode instanceof Node && (event.target instanceof Element ? event.target.closest(".xterm-accessibility-tree")?.contains(selection.anchorNode) : false)) {
        swipeRef.current = null;
        setSwipe(null);
        return;
      }
      const axis = classifyGestureAxis(rawX, deltaY);
      if (axis === "pending") return;
      if (axis === "vertical") {
        swipeRef.current = null;
        setSwipe(null);
        return;
      }
    }
    const hasTarget = rawX > 0 ? currentPage > 0 : currentPage < pageCount - 1;
    const deltaX = hasTarget ? rawX : rawX * .14;
    const next = { ...current, horizontal: true, deltaX };
    swipeRef.current = next;
    setSwipe(next);
    event.preventDefault();
  }

  function finishSwipe(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const current = swipeRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const elapsed = Math.max(1, performance.now() - current.startedAt);
    const velocity = Math.abs(current.deltaX) / elapsed;
    const canNavigate = current.deltaX > 0 ? currentPage > 0 : currentPage < pageCount - 1;
    const commit = !cancelled && current.horizontal && canNavigate && (Math.abs(current.deltaX) > window.innerWidth * .22 || velocity > .55);
    const targetPage = commit ? currentPage + (current.deltaX < 0 ? 1 : -1) : currentPage;
    swipeRef.current = null;
    setSwipe(null);
    // Only a completed page transition needs to consume a compatibility click.
    // A short drag that snaps back must leave the next tap untouched. Keep the
    // guard scoped to the page the gesture started on so a delayed click from
    // that gesture cannot consume a control on the newly visible page.
    suppressSwipeClickRef.current = commit;
    swipeClickPageRef.current = commit ? currentPage : null;
    if (commit) {
      // A WebView may omit the compatibility click after a touch drag. Bound
      // the fallback guard so it can never consume a later real interaction.
      swipeClickTimerRef.current = window.setTimeout(() => {
        suppressSwipeClickRef.current = false;
        swipeClickPageRef.current = null;
        swipeClickTimerRef.current = undefined;
      }, 500);
    }
    if (targetPage === 0) setView({ type: "home" });
    else if (targetPage === 1 && activeProject) setView({ type: "project", projectId: activeProject.id });
    else if (targetPage === 2 && activeProject && activeSession) setView({ type: "terminal", projectId: activeProject.id, sessionId: activeSession.id });
    // Chromium's fling recognizer can swallow the click of a tap that follows
    // any touch drag, regardless of speed, for longer than a tap-pacing window.
    // Handle every taut tap from its pointer-up directly, so a control works on
    // the first attempt right after the user lets go.
    if (!cancelled) bridgeTapClick(event, current);
  }

  function bridgeTapClick(event: ReactPointerEvent<HTMLDivElement>, state: SwipeState) {
    // A taut tap may never deliver its click (Chromium eats the first click
    // after a dragged gesture to settle the fling). Running the control's
    // activation at pointer-up means the tap works immediately on let-go; the
    // guard below then drops the click the WebView emits if/when it recovers,
    // so the action still fires at most once.
    if (!shouldBridgeTapClick({
      eventType: event.type,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      horizontal: state.horizontal,
      now: performance.now(),
      startedAt: state.startedAt,
      movePx: Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
    })) return;
    const target = event.target instanceof Element ? event.target : undefined;
    if (!target) return;
    const control = target.closest("button, a, summary, label, [role=button], .sheet-backdrop");
    if (!(control instanceof HTMLElement)) return;
    // A click inside a bottom sheet is stopped by the sheet section; only a
    // tap on the backdrop itself dismisses it. Controls that own their pointer
    // sequence (terminal function keys, project reorder handles) already
    // activate without a click and a synthetic click would run them twice.
    if (!shouldBridgeTapControl({
      nearestControl: control.classList.contains("sheet-backdrop")
        ? "backdrop"
        : control.matches("a") ? "link" : control.matches("summary") ? "summary" : control.matches("label") ? "label" : control.matches("button") ? "button" : "roleButton",
      insideBottomSheet: Boolean(target.closest(".bottom-sheet")),
      insideExtraKeys: Boolean(target.closest(".extra-keys")),
      isDragHandle: control.matches(".mobile-project-drag")
    })) return;
    control.click();
    swallowTapClickRef.current = true;
    swallowTapClickAtRef.current = { x: event.clientX, y: event.clientY };
    if (swallowTapClickTimerRef.current !== undefined) window.clearTimeout(swallowTapClickTimerRef.current);
    swallowTapClickTimerRef.current = window.setTimeout(() => {
      swallowTapClickRef.current = false;
      swallowTapClickAtRef.current = { x: 0, y: 0 };
      swallowTapClickTimerRef.current = undefined;
    }, SWALLOW_CLICK_LINGER_MS);
  }

  function suppressSwipeClick(event: React.MouseEvent<HTMLDivElement>) {
    if (swallowTapClickRef.current) {
      const nearTap = Math.hypot(event.clientX - swallowTapClickAtRef.current.x, event.clientY - swallowTapClickAtRef.current.y) <= SWALLOW_CLICK_DISTANCE_PX;
      const swallow = shouldSwallowTrailingClick({ armed: swallowTapClickRef.current, nearTap });
      // The guard is one-shot: whether or not this is the click it waited
      // for, it never outlives this event. A far-away click is a fresh,
      // unrelated interaction that must pass through.
      swallowTapClickRef.current = false;
      swallowTapClickAtRef.current = { x: 0, y: 0 };
      if (swallowTapClickTimerRef.current !== undefined) window.clearTimeout(swallowTapClickTimerRef.current);
      swallowTapClickTimerRef.current = undefined;
      if (swallow) {
        // The browser click that trails a bridged tap (or the compatibility
        // click of the gesture itself). The synthetic click already ran the
        // control's action; swallow this one so it cannot fire twice.
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!suppressSwipeClickRef.current) return;
    const target = event.target instanceof Element ? event.target.closest(".mobile-page") : null;
    const pageIndex = target?.parentElement ? Array.prototype.indexOf.call(target.parentElement.children, target) : null;
    if (pageIndex !== swipeClickPageRef.current) {
      // A real tap on the newly visible page must pass through. Keep the guard
      // only for the compatibility click that still points at the page the
      // swipe started on.
      suppressSwipeClickRef.current = false;
      swipeClickPageRef.current = null;
      if (swipeClickTimerRef.current !== undefined) window.clearTimeout(swipeClickTimerRef.current);
      swipeClickTimerRef.current = undefined;
      return;
    }
    suppressSwipeClickRef.current = false;
    swipeClickPageRef.current = null;
    if (swipeClickTimerRef.current !== undefined) window.clearTimeout(swipeClickTimerRef.current);
    swipeClickTimerRef.current = undefined;
    event.preventDefault();
    event.stopPropagation();
  }

  return <div className="mobile-pager" onPointerDownCapture={beginSwipe} onTouchStartCapture={() => { suppressSwipeClickRef.current = false; swipeClickPageRef.current = null; if (swipeClickTimerRef.current !== undefined) window.clearTimeout(swipeClickTimerRef.current); swipeClickTimerRef.current = undefined; swallowTapClickRef.current = false; if (swallowTapClickTimerRef.current !== undefined) window.clearTimeout(swallowTapClickTimerRef.current); swallowTapClickTimerRef.current = undefined; }} onPointerMoveCapture={moveSwipe} onPointerUpCapture={(event) => finishSwipe(event)} onPointerCancelCapture={(event) => finishSwipe(event)} onClickCapture={suppressSwipeClick}>
    <div className={`mobile-page-track ${swipe?.horizontal ? "is-dragging" : ""}`} style={{ transform: `translate3d(calc(${-currentPage * 100}% + ${swipe?.deltaX ?? 0}px),0,0)` }}>
      <div className="mobile-page"><div className="mobile-app home-view">
        <RemoteRegistrationBanner state={remoteRegistration} onRetry={() => void connection.retryRemoteRegistration()} />
        <header className="home-header">
          <div><span className="eyebrow">Connected desktop</span><h1>{snapshot.host.name}</h1><span className="connection-label"><i /> Online · {snapshot.sessions.filter((s) => s.status === "running").length} sessions</span></div>
          <button className="round-button" onClick={() => void forgetHost()} title="Host options"><MoreIcon /></button>
        </header>
        <section className="home-content">
          <div className="section-title"><span>Projects</span><button onClick={() => setShowCreateProject(true)}><PlusIcon /> New</button></div>
          <div className="project-cards">
            {orderedProjects.map((project, index) => <ProjectCard key={project.id} elementRef={(element) => { if (element) projectElementsRef.current.set(project.id, element); else projectElementsRef.current.delete(project.id); }} project={project} sessions={snapshot.sessions.filter((session) => session.projectId === project.id)} dragging={project.id === projectDrag?.projectId} reordering={projectReordering} transform={projectDragTransform(project.id, index)} onDragStart={(event) => beginProjectDrag(event, project.id, index)} onDragMove={moveProjectDrag} onDragEnd={(event, commit) => finishProjectDrag(event, commit)} onClick={() => openProject(project.id)} onSession={openTerminal} />)}
          </div>
          {!snapshot.projects.length && <div className="mobile-empty"><FolderIcon /><h2>No projects yet</h2><p>Add a folder from your desktop to begin.</p></div>}
        </section>
        <nav className="bottom-nav"><button className="active"><FolderIcon /><span>Projects</span></button><button onClick={() => void scan()}><ScanIcon /><span>Pair</span></button><button onClick={() => void forgetHost()}><WifiIcon /><span>Host</span></button></nav>
      </div></div>
      {activeProject && <div className="mobile-page"><ProjectScreen project={activeProject} snapshot={snapshot} connection={connection} onBack={navigateBack} onRename={() => setProjectToRename(activeProject)} onOpen={openTerminal} /></div>}
      {activeProject && activeSession && <div className="mobile-page"><div className="mobile-app terminal-view">
        <MobileHeader title={activeSession.title} subtitle={activeProject.name} onBack={navigateBack} trailing={<div className="session-actions"><span className={`session-state ${activeSession.status}`}>{activeSession.status}</span><button className="terminal-settings-button" onClick={() => setShowTerminalSettings(true)} aria-label="Terminal display settings"><SettingsIcon /></button><button className="close-session-button" onClick={() => setSessionToClose(activeSession)} aria-label="Close terminal session" title="Close terminal session"><CloseIcon /></button></div>} />
        <MobileTerminal key={activeSession.id} active={view.type === "terminal"} fontWidthScale={fontWidthPercent / 100} connection={connection} session={activeSession} />
      </div></div>}
    </div>
    {showCreateProject && <CreateProjectSheet connection={connection} onClose={() => setShowCreateProject(false)} />}
    {projectToRename && activeProject?.id === projectToRename.id && <RenameProjectSheet project={activeProject} connection={connection} onClose={() => setProjectToRename(null)} />}
    {sessionToClose && activeSession?.id === sessionToClose.id && <CloseSessionSheet session={activeSession} onClose={() => setSessionToClose(null)} onConfirm={() => closeSession(activeSession)} />}
    {showTerminalSettings && <TerminalSettingsSheet value={fontWidthPercent} onChange={(value) => { setFontWidthPercent(value); void Preferences.set({ key: TERMINAL_FONT_WIDTH_KEY, value: String(value) }); }} onClose={() => setShowTerminalSettings(false)} />}
  </div>;
}

function RemoteRegistrationBanner({ state, onRetry }: { state: RemoteRegistrationState; onRetry: () => void }) {
  if (state.status !== "failed") return null;
  return <aside className="mobile-registration-banner" role="status">
    <span>{state.error ?? "Remote connection registration failed. LAN access is still available."}</span>
    <button onClick={onRetry}>Retry</button>
  </aside>;
}

async function startConnectionNotification(hostName: string) {
  if (Capacitor.getPlatform() !== "android") return;
  try { await ConnectionNotification.start({ hostName }); } catch { /* The connection still works if notifications are denied. */ }
}

async function updateConnectionNotification(hostName: string, state: ConnectionNotificationState) {
  if (Capacitor.getPlatform() !== "android") return;
  try { await ConnectionNotification.update({ hostName, state }); } catch { /* The service may be unavailable while Android recreates the app process. */ }
}

async function stopConnectionNotification() {
  if (Capacitor.getPlatform() !== "android") return;
  try { await ConnectionNotification.stop(); } catch { /* Native plugin is unavailable on non-release web shells. */ }
}

function isAuthorizationError(cause: unknown): boolean {
  return cause instanceof Error && /not authorized|no longer authorized/i.test(cause.message);
}

function isEmbeddedNodeConfigurationError(cause: unknown): boolean {
  return cause instanceof Error && /update the (desktop|mobile) app|enrollment key was rejected|tsnet desktop host name|remote node is no longer registered/i.test(cause.message);
}

function ProjectScreen({ project, snapshot, connection, onBack, onRename, onOpen }: { project: Project; snapshot: HostSnapshot; connection: HostConnection; onBack: () => void; onRename: () => void; onOpen: (session: TerminalSession) => void }) {
  const sessions = snapshot.sessions.filter((session) => session.projectId === project.id);
  const [changingPersistence, setChangingPersistence] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  async function createSession() {
    const response = await connection.request({ type: "session.create", requestId: createRequestId(), projectId: project.id });
    if (response.type === "snapshot") {
      const created = response.snapshot.sessions.filter((session) => session.projectId === project.id).at(-1);
      if (created) onOpen(created);
    }
  }
  async function togglePersistence() {
    setChangingPersistence(true); setPersistenceError("");
    try {
      await connection.request({ type: "project.persistence", requestId: createRequestId(), projectId: project.id, persistent: !project.persistent });
    } catch (cause) {
      setPersistenceError(cause instanceof Error ? cause.message : "Could not change the project.");
    } finally {
      setChangingPersistence(false);
    }
  }
  return <div className="mobile-app project-view">
    <MobileHeader title={project.name} subtitle={project.path} onBack={onBack} trailing={<><button className="header-edit-button" onClick={onRename} aria-label="Rename project"><EditIcon /></button>{project.persistent ? <BookmarkIcon className="saved-icon" /> : <ClockIcon className="temp-icon" />}</>} />
    <section className="project-hero"><div className="large-folder"><FolderIcon /></div><span>{project.persistent ? "Saved project" : "Temporary project"}</span><h1 className="display-name" title={project.name}>{project.name}</h1><p>{project.path}</p><div className="project-actions"><button className="mobile-primary" onClick={() => void createSession()}><PlusIcon /> New terminal</button><button className="mobile-secondary" disabled={changingPersistence} onClick={() => void togglePersistence()}>{project.persistent ? <ClockIcon /> : <BookmarkIcon />}{changingPersistence ? "Updating…" : project.persistent ? "Make temporary" : "Save project"}</button></div>{persistenceError && <div className="form-error project-error">{persistenceError}</div>}</section>
    <section className="session-section"><div className="section-title"><span>Sessions</span><small>{sessions.length}</small></div>
      {sessions.length ? <div className="session-list">{sessions.map((session) => <button key={session.id} onClick={() => onOpen(session)}><span className="session-icon"><TerminalIcon /></span><span><strong className="display-name" title={session.title}>{session.title}</strong><small>{session.status === "running" ? "Active now" : `Exited · ${session.exitCode ?? "—"}`}</small></span><i className={session.status} /><ChevronIcon /></button>)}</div> : <div className="inline-empty">No open terminal sessions.</div>}
    </section>
  </div>;
}

function ProjectCard({ project, sessions, dragging, reordering, transform, elementRef, onDragStart, onDragMove, onDragEnd, onClick, onSession }: { project: Project; sessions: TerminalSession[]; dragging: boolean; reordering: boolean; transform?: string; elementRef: (element: HTMLElement | null) => void; onDragStart: (event: ReactPointerEvent<HTMLElement>) => void; onDragMove: (event: ReactPointerEvent<HTMLElement>) => void; onDragEnd: (event: ReactPointerEvent<HTMLElement>, commit: boolean) => void; onClick: () => void; onSession: (session: TerminalSession) => void }) {
  return <article ref={elementRef} className={`project-card ${dragging ? "is-dragging" : ""} ${reordering ? "is-reordering" : ""}`} style={{ transform }}><button className="project-card-main" onClick={onClick}><span className="card-folder"><FolderIcon /></span><span className="card-copy"><strong className="display-name" title={project.name}>{project.name}</strong><small>{project.path}</small></span><span className="card-persist">{project.persistent ? <BookmarkIcon /> : <ClockIcon />}</span><span className="mobile-project-drag" role="button" aria-label={`Reorder ${project.name}`} data-no-swipe onClick={(event) => event.stopPropagation()} onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={(event) => onDragEnd(event, true)} onPointerCancel={(event) => onDragEnd(event, false)}>⠿</span><ChevronIcon /></button>
    {!!sessions.length && <div className="card-sessions">{sessions.slice(0, 3).map((session) => <button key={session.id} onClick={() => onSession(session)}><TerminalIcon /><span className="display-name" title={session.title}>{session.title}</span><i className={session.status} /></button>)}{sessions.length > 3 && <span className="more-sessions">+{sessions.length - 3}</span>}</div>}
  </article>;
}

function TerminalSettingsSheet({ value, onChange, onClose }: { value: number; onChange: (value: number) => void; onClose: () => void }) {
  return <div className="sheet-backdrop" onClick={onClose}><section className="bottom-sheet terminal-settings-sheet" data-no-swipe onClick={(event) => event.stopPropagation()}><i className="sheet-handle" /><span className="eyebrow">Terminal display</span><h2>Fit more text</h2><p>Squish characters horizontally while keeping their height readable. The terminal refits to show more columns.</p><label className="font-width-control"><span><strong>Character width</strong><output>{value}%</output></span><input type="range" min="65" max="100" step="1" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label><div className="font-width-preview"><span className="font-width-preview-text" style={{ transform: `scaleX(${value / 100})` }}>C:\project&gt; npm run dev</span></div><button className="mobile-primary full" onClick={onClose}>Done</button></section></div>;
}

function CreateProjectSheet({ connection, onClose }: { connection: HostConnection; onClose: () => void }) {
  const [name, setName] = useState("");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function openFolder(path?: string) {
    setLoading(true); setError("");
    try {
      const response = await connection.request({ type: "directory.list", requestId: createRequestId(), ...(path ? { path } : {}) });
      if (response.type !== "directory.listing") throw new Error("The desktop did not return a folder listing.");
      setListing(response.listing);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not browse desktop folders.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void openFolder(); }, []);
  async function submit() {
    if (!listing) { setError("Choose a folder on the desktop."); return; }
    try { await connection.request({ type: "project.create", requestId: createRequestId(), name: name.trim() || listing.path.split(/[\\/]/).filter(Boolean).at(-1) || "Project", path: listing.path }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the project."); }
  }
  return <div className="sheet-backdrop" onClick={onClose}><section className="bottom-sheet folder-picker-sheet" onClick={(event) => event.stopPropagation()}><i className="sheet-handle" /><span className="eyebrow">Desktop project</span><h2>Choose a folder</h2><p>Browse folders on {connection.host.name}, then add the current folder as a project.</p><label>Project name (optional)<input maxLength={MAX_PROJECT_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} placeholder={listing?.path.split(/[\\/]/).filter(Boolean).at(-1) || "Project name"} /></label><div className="folder-location"><button disabled={!listing?.parentPath || loading} onClick={() => void openFolder(listing?.parentPath)} aria-label="Parent folder"><BackIcon /></button><span>{listing?.path ?? "Opening desktop folders…"}</span></div><div className="folder-list" aria-busy={loading}>{loading ? <div className="folder-loading"><i className="loader" />Loading folders…</div> : listing?.directories.length ? listing.directories.map((directory) => <button key={directory.path} onClick={() => void openFolder(directory.path)}><FolderIcon /><span>{directory.name}</span><ChevronIcon /></button>) : <div className="folder-empty">This folder has no subfolders.</div>}</div>{error && <div className="form-error">{error}</div>}<button className="mobile-primary full" disabled={!listing || loading} onClick={() => void submit()}>Add this folder</button><button className="text-button" onClick={onClose}>Cancel</button></section></div>;
}

function RenameProjectSheet({ project, connection, onClose }: { project: Project; connection: HostConnection; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    const nextName = name.trim();
    setSaving(true); setError("");
    try {
      await connection.request({ type: "project.rename", requestId: createRequestId(), projectId: project.id, name: nextName });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename the project.");
      setSaving(false);
    }
  }
  return <div className="sheet-backdrop" onClick={saving ? undefined : onClose}><section className="bottom-sheet" onClick={(event) => event.stopPropagation()}><i className="sheet-handle" /><span className="eyebrow">Project name</span><h2>Rename project</h2><p>The desktop folder stays at {project.path}. Leave the name blank to use the folder name.</p><label>Name<input autoFocus maxLength={MAX_PROJECT_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} /></label>{error && <div className="form-error">{error}</div>}<button className="mobile-primary full" disabled={saving} onClick={() => void submit()}>{saving ? "Renaming…" : "Save name"}</button><button className="text-button" disabled={saving} onClick={onClose}>Cancel</button></section></div>;
}

function CloseSessionSheet({ session, onClose, onConfirm }: { session: TerminalSession; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setClosing(true); setError("");
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not close the terminal session."); setClosing(false); }
  }
  return <div className="sheet-backdrop" onClick={closing ? undefined : onClose}><section className="bottom-sheet confirm-sheet" onClick={(event) => event.stopPropagation()}><i className="sheet-handle" /><span className="eyebrow">Close terminal</span><h2>End this session?</h2><p>This will terminate <strong title={session.title}>{session.title}</strong> and remove its tab from the desktop and phone.</p>{error && <div className="form-error">{error}</div>}<button className="danger-button" disabled={closing} onClick={() => void confirm()}>{closing ? "Closing…" : "Close terminal"}</button><button className="text-button" disabled={closing} onClick={onClose}>Cancel</button></section></div>;
}

function MobileHeader({ title, subtitle, onBack, trailing }: { title: string; subtitle: string; onBack: () => void; trailing?: React.ReactNode }) {
  return <header className="mobile-header"><button className="round-button" onClick={onBack}><BackIcon /></button><span><strong className="display-name" title={title}>{title}</strong><small title={subtitle}>{subtitle}</small></span><div className="header-trailing">{trailing}</div></header>;
}

function PairScreen({ error, manualCode, showManual, onManualCode, onShowManual, onScan, onPair }: { error: string; manualCode: string; showManual: boolean; onManualCode: (value: string) => void; onShowManual: () => void; onScan: () => void; onPair: () => void }) {
  return <div className="onboarding"><div className="ambient one"/><div className="ambient two"/><div className="onboarding-top"><span className="logo"><TerminalIcon /></span><strong>Agent Terminal</strong></div><section className="pair-copy"><span className="eyebrow">Desktop, untethered</span><h1>Your Windows terminal.<br/><em>Now in your pocket.</em></h1><p>Scan once to authorize this phone. It stays paired until you remove it from the desktop.</p></section><div className="scan-illustration"><span className="scan-corner tl"/><span className="scan-corner tr"/><span className="scan-corner bl"/><span className="scan-corner br"/><div className="qr-art"><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><div className="scan-line"/></div>{error && <div className="pair-error">{error}</div>}<section className="pair-actions"><button className="scan-button" onClick={onScan}><ScanIcon /> Authorize this phone</button>{showManual ? <div className="manual-pair"><textarea value={manualCode} onChange={(event) => onManualCode(event.target.value)} placeholder="Paste setup QR data"/><button onClick={onPair}>Authorize</button></div> : <button className="manual-link" onClick={onShowManual}>Enter setup data manually</button>}<small>Future connections work automatically from any network.</small></section></div>;
}

function Splash({ label }: { label: string }) { return <div className="splash"><span className="logo large"><TerminalIcon /></span><strong>Agent Terminal</strong><small>{label}…</small><i className="loader" /></div>; }
function ErrorScreen({ message, onRetry, onForget }: { message: string; onRetry: () => void; onForget: () => void }) { return <div className="error-screen"><span className="offline-icon"><WifiIcon /></span><h1>Desktop unavailable</h1><p>{message}</p><button className="mobile-primary full" onClick={onRetry}>Try again</button><button className="text-button" onClick={onForget}>Pair a different desktop</button></div>; }
