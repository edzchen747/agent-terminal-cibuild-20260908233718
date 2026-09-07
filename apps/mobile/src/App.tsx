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
import { createRequestId, isSessionActive, MAX_PROJECT_NAME_LENGTH, normalizeTerminalThemeSettings, parsePairingPayload, resolveTerminalScheme, sessionActivitySummary, terminalSchemesFor } from "@agentterminal/protocol";
import { HostConnection, type RemoteRegistrationState, type SavedHost, type SavedHostRecord } from "./connection";
import { ConnectionNotification } from "./connection-notification";
import { notificationStateFor, type ConnectionNotificationState } from "./connectionPolicy";
import { isRetryingSavedHost } from "./connectionFlow";
import { hostRowRegistrationStatus, hostRowStatusLabel, hostsPageCheckPlan, lastConnectedLabel, REGISTRATION_STATUS_LABELS, registrationDisplayStatusFor, type HostCheckState, type RegistrationDisplayStatus, sortHostsByLastConnected } from "./hostSelection";
import { readRegistrationVerdict, rememberRegistrationVerdict, type RegistrationVerdict } from "./registrationCache";
import { backButtonAction, pairScreenShowsBack, pairingReconnectStep, pairingRestoreDecision } from "./navigationPolicy";
import { deviceIdentity } from "./device";
import { classifyGestureAxis, shouldBridgeTapClick, shouldBridgeTapControl, shouldCommitSheetDismiss, shouldSwallowTrailingClick, SHEET_SLIDER_HORIZONTAL_BIAS, SWIPE_COMMIT_DISTANCE_RATIO, SWIPE_COMMIT_VELOCITY_PX_MS } from "./gesture";
import { shouldCommitBackSwipe } from "./backSwipe";
import { effectiveDefaultShell } from "./defaultShell";
import { BackIcon, BookmarkIcon, ChevronIcon, ClockIcon, CloseIcon, EditIcon, FolderIcon, MoreIcon, PlusIcon, RefreshIcon, ScanIcon, SettingsIcon, TerminalIcon, TrashIcon, WifiIcon } from "./icons";
import { MobileTerminal } from "./MobileTerminal";
import { FONT_WIDTH_MAX, FONT_WIDTH_MIN, FONT_WIDTH_STEP, normalizeFontWidthPercent } from "./fontWidth";
import { applyTheme, loadThemePreference, resolveTheme, saveThemePreference, SYSTEM_DARK_QUERY, THEME_LABELS, THEME_PREFERENCES, type ResolvedTheme, type ThemePreference } from "./theme";
import { syncSystemBars } from "./systemBars";
import { backProjectId, resolveViewGeometry } from "./projectNavigation";

type View = { type: "home" } | { type: "hosts" } | { type: "project"; projectId: string } | { type: "terminal"; sessionId: string; projectId: string };
// The bottom sheets of the connected pager. While one is set, that sheet is
// playing its slide-down exit and stays mounted until it finishes.
type SheetKind = "settings" | "terminalSettings" | "createProject" | "rename" | "closeSession";
const TERMINAL_FONT_WIDTH_KEY = "agent-terminal-font-width-percent";
const SWALLOW_CLICK_LINGER_MS = 600;
const SWALLOW_CLICK_DISTANCE_PX = 48;
// The sheet exit matches the .25s sheet transition in styles.css; the
// fallback covers the cases where transitions never run (screen off,
// reduced motion), so the sheet still unmounts.
const SHEET_EXIT_FALLBACK_MS = 400;
// The back-swipe exit matches the pager's 280ms track transition.
const BACK_SWIPE_EXIT_MS = 280;

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
  /** Whether an overlay sheet was active when this pointer went down. */
  overlay: boolean;
  /** Whether the marked-for-dismiss or scrollable region disallows the drag. */
  blocked: boolean;
  /** Whether the gesture is currently dragging a sheet downward. */
  sheetDragging: boolean;
  deltaY: number;
  /** Whether the pointer went down on the character-width range input. */
  onSlider: boolean;
}

// Remote access registration, matching the desktop's badge. The live
// connection carries its own enrollment verdict; while the phone has no
// internet that verdict is stale, so the badge shows "Offline" instead
// (the desktop does the same for its own connectivity reading).

export function App() {
  const [connection, setConnection] = useState<HostConnection | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "pairing" | "connecting" | "connected" | "error">("loading");
  const [error, setError] = useState("");
  // The desktop every connection attempt targets, kept so the connecting and
  // try-again screens can name it even after the connection object is gone.
  const [hostName, setHostName] = useState("");
  // The previously paired desktops shown on the hosts page, re-read each time
  // the page is entered so a freshly paired desktop shows up.
  const [hostRecords, setHostRecords] = useState<SavedHostRecord[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  // Background registration checks for every registered non-connected host,
  // run once per hosts-page opening: a row only shows Ready after its node
  // actually came back from the control plane.
  const [hostChecks, setHostChecks] = useState<Map<string, HostCheckState>>(() => new Map());
  const hostChecksStartedRef = useRef(false);
  // A manual refresh re-verifies every registered host and rewrites the
  // verdict cache; the header button spins while it runs.
  const [hostsRefreshing, setHostsRefreshing] = useState(false);
  // The user reached the pairing screen from the hosts page; back restores
  // the pre-pair status captured in prePairStatusRef.
  const [pairFromHosts, setPairFromHosts] = useState(false);
  // The user reached the pairing screen from the home view's bottom nav;
  // back returns to the home view.
  const [pairFromHome, setPairFromHome] = useState(false);
  const [remoteRegistration, setRemoteRegistration] = useState<RemoteRegistrationState>({ status: "unregistered" });
  // The phone's raw route state: while offline the registration verdict on
  // top is stale, so the badge falls back to "Offline" (desktop parity).
  const [online, setOnline] = useState(() => navigator.onLine);
  const [manualCode, setManualCode] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [view, setView] = useState<View>({ type: "home" });
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectToRename, setProjectToRename] = useState<Project | null>(null);
  const [sessionToClose, setSessionToClose] = useState<TerminalSession | null>(null);
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fontWidthPercent, setFontWidthPercent] = useState(FONT_WIDTH_MAX);
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia(SYSTEM_DARK_QUERY).matches);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [projectDrag, setProjectDrag] = useState<ProjectDragState | null>(null);
  const [projectReordering, setProjectReordering] = useState(false);
  const [swipe, setSwipe] = useState<SwipeState | null>(null);
  const [sheetDragY, setSheetDragY] = useState(0);
  // True while a finger actively drags a sheet down. Unlike sheetDragY this
  // clears at lift-off: a committed drag keeps its offset until the sheet's
  // exit animation has unmounted it, so the slide-down continues the drag.
  const [sheetDragging, setSheetDragging] = useState(false);
  // The sheet whose exit animation is running (see closeSheet).
  const [closingSheet, setClosingSheet] = useState<SheetKind | null>(null);
  const connectionRef = useRef<HostConnection | null>(null);
  connectionRef.current = connection;
  const screenAwakeRef = useRef(true);
  const deviceSleepingRef = useRef(false);
  const navigationRef = useRef({ view, status, showCreateProject, projectToRename, sessionToClose, showTerminalSettings, showSettings, pairFromHosts, pairFromHome, snapshot, hostsEmpty: false });
  navigationRef.current = { view, status, showCreateProject, projectToRename, sessionToClose, showTerminalSettings, showSettings, pairFromHosts, pairFromHome, snapshot, hostsEmpty: hostsLoaded && hostRecords.length === 0 };
  // The status and error message captured when the user leaves the hosts
  // page for the pairing screen, so pressing back restores the same screen
  // (the try-again screen with its original message when the hosts page was
  // reached from there).
  const prePairStatusRef = useRef<"connected" | "error">("connected");
  const prePairErrorRef = useRef("");
  // Mirror of the pairFromHosts flag for the connection event handlers
  // below: while the pairing screen is open from the hosts page, this
  // connection's events must not clobber the pairing status.
  const pairFromHostsRef = useRef(false);
  pairFromHostsRef.current = pairFromHosts;
  // Same hold for the bottom-nav path.
  const pairFromHomeRef = useRef(false);
  pairFromHomeRef.current = pairFromHome;
  // Live status/error for enterPairFromHosts, which the Android back-key
  // listener (registered once on mount) can reach with a stale closure:
  // the pre-pair capture must see the status the hosts page is showing,
  // not the first render's "loading".
  const statusRef = useRef(status);
  statusRef.current = status;
  const errorRef = useRef(error);
  errorRef.current = error;
  const projectDragRef = useRef<ProjectDragState | null>(null);
  const projectElementsRef = useRef(new Map<string, HTMLElement>());
  const swipeRef = useRef<SwipeState | null>(null);
  // The sheet whose exit is in flight, mirrored for the mount-time back-key
  // listener (closeSheet) which would otherwise see a stale state closure.
  const sheetClosingRef = useRef<SheetKind | null>(null);
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
      // Snap to the slider's step grid so a value saved at the old
      // 1%-granularity does not park the thumb between steps.
      if (Number.isFinite(parsed)) setFontWidthPercent(normalizeFontWidthPercent(parsed));
    });
  }, []);

  // The theme is a client-side preference: nothing about it reaches the paired
  // desktop, so this phone follows the palette saved here. The "system" choice
  // tracks the phone's own light/dark setting live.
  useEffect(() => {
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const apply = () => setSystemPrefersDark(query.matches);
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const resolvedTheme = resolveTheme(themePreference, systemPrefersDark);

  useEffect(() => {
    applyTheme(resolvedTheme);
    saveThemePreference(themePreference);
    // Android draws the app behind transparent system bars, so it has to be
    // told which way to paint their icons; nothing in the web layer reaches
    // them on its own.
    void syncSystemBars(resolvedTheme);
  }, [themePreference, resolvedTheme]);

  // The scheme pair is a host setting shared with the desktop; which of the
  // two this phone paints is decided by its own light/dark theme. A desktop
  // older than the setting sends no pair at all, so normalize before reading:
  // reaching straight into it blanks the whole app on the first snapshot.
  const terminalTheme = normalizeTerminalThemeSettings(snapshot?.terminalTheme);
  const terminalScheme = resolveTerminalScheme(
    resolvedTheme === "dark" ? terminalTheme.darkSchemeId : terminalTheme.lightSchemeId,
    resolvedTheme
  );

  // The terminal page paints the scheme background behind the letterboxed
  // grid, so the variable has to reach those rules too, not just the emulator.
  useEffect(() => {
    document.documentElement.style.setProperty("--terminal-bg", terminalScheme.background);
  }, [terminalScheme]);

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
      // Every back-key decision lives in navigationPolicy.backButtonAction so
      // the priority order and the pair-a-different-desktop path stay tested;
      // this switch only executes the chosen action.
      switch (backButtonAction({
        status: navigation.status,
        viewType: navigation.view.type,
        showTerminalSettings: navigation.showTerminalSettings,
        showSettings: navigation.showSettings,
        hasRenameSheet: navigation.projectToRename !== null,
        hasCloseSessionSheet: navigation.sessionToClose !== null,
        showCreateProject: navigation.showCreateProject,
        pairFromHosts: navigation.pairFromHosts,
        pairFromHome: navigation.pairFromHome,
        hostsEmpty: navigation.hostsEmpty
      })) {
        case "closeTerminalSettings":
          closeSheet("terminalSettings");
          return;
        case "closeSettings":
          closeSheet("settings");
          return;
        case "closeRenameSheet":
          closeSheet("rename");
          return;
        case "closeSessionSheet":
          closeSheet("closeSession");
          return;
        case "closeCreateProject":
          closeSheet("createProject");
          return;
        case "backFromPairing":
          backFromPairing();
          return;
        case "pairFromHosts":
          // The hosts page loaded with no paired desktops: open the pairing
          // screen (its back button restores the hosts page via the
          // pairFromHosts flag).
          enterPairFromHosts();
          return;
        case "navToProject": {
          // The action is only ever chosen for a terminal view; re-narrow here
          // because the switch does not carry the policy's viewType guard. The
          // session may have been moved to another project by a cd in the
          // shell, so back lands on the project it belongs to now.
          const terminalView = navigation.view;
          if (terminalView.type === "terminal") {
            setView({ type: "project", projectId: backProjectId(navigation.snapshot, terminalView) });
          }
          return;
        }
        case "navToHome":
          setView({ type: "home" });
          return;
        case "exitApp":
          void stopConnectionNotification();
          void CapacitorApp.exitApp();
          return;
        case "ignore":
          return;
      }
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
      const applyPowerState = (awake: boolean, sleeping: boolean) => {
        if (disposed) return;
        screenAwakeRef.current = awake;
        deviceSleepingRef.current = sleeping;
        connectionRef.current?.setScreenAwake(awake);
        connectionRef.current?.setDeviceSleeping(sleeping);
      };
      void ConnectionNotification.getScreenState().then(({ awake, sleeping }) => applyPowerState(awake, sleeping));
      void ConnectionNotification.addListener("screenState", ({ awake, sleeping }) => applyPowerState(awake, sleeping)).then((handle) => {
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
      deviceSleepingRef.current = false;
      connectionRef.current?.setScreenAwake(screenAwakeRef.current);
      connectionRef.current?.setDeviceSleeping(false);
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
      setOnline(true);
      const current = connectionRef.current;
      if (!current) return;
      current.retryNow();
      if (!current.isConnected()) void updateConnectionNotification(current.host.name, notificationStateFor(true, false), current.endpoint());
    };
    const handleOffline = () => {
      setOnline(false);
      const current = connectionRef.current;
      if (!current) return;
      current.notifyNetworkLost();
      void updateConnectionNotification(current.host.name, notificationStateFor(false, false), current.endpoint());
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      void listener.then((handle) => handle.remove());
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // The compatibility click that trails a bridged tap can outlive the view it
  // started in: tapping the "Hosts" nav button switches the view at pointer-up,
  // so the click the WebView emits afterwards lands on the newly mounted hosts
  // page ("Pair a new desktop" sits right where the finger let go) and would
  // fire it. Swallowing therefore happens at the document root, where it
  // survives the view swap; React attaches its listeners below the document,
  // so a stopped event never reaches them. The bridged tap's own synthetic
  // click is always dispatched before this guard arms, so it passes through.
  // This effect must stay above every early return below: a render that
  // returns early must run exactly the same hook sequence as a render that
  // reaches the pager, or React throws (fewer/more hooks) and blanks the app.
  useEffect(() => {
    const swallow = (event: MouseEvent) => {
      if (!swallowTapClickRef.current) return;
      const nearTap = Math.hypot(event.clientX - swallowTapClickAtRef.current.x, event.clientY - swallowTapClickAtRef.current.y) <= SWALLOW_CLICK_DISTANCE_PX;
      const swallowTrailing = shouldSwallowTrailingClick({ armed: true, nearTap });
      // The guard is one-shot: whether or not this is the click it waited
      // for, it never outlives this event. A far-away click is a fresh,
      // unrelated interaction that must pass through.
      swallowTapClickRef.current = false;
      swallowTapClickAtRef.current = { x: 0, y: 0 };
      if (swallowTapClickTimerRef.current !== undefined) window.clearTimeout(swallowTapClickTimerRef.current);
      swallowTapClickTimerRef.current = undefined;
      if (swallowTrailing) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", swallow, true);
    return () => document.removeEventListener("click", swallow, true);
  }, []);

  // Opens a live connection to the chosen desktop and runs the same
  // success/failure state machine as the launch path. An attempt that was
  // superseded (a newer selection, or the app going away) never touches
  // state.
  async function startHostConnection(host: SavedHost) {
    const next = new HostConnection(host);
    connectionRef.current = next;
    next.setScreenAwake(screenAwakeRef.current);
    next.setDeviceSleeping(deviceSleepingRef.current);
    setRemoteRegistration(next.remoteRegistrationState());
    next.startAutoReconnect();
    setConnection(next);
    setHostName(next.host.name);
    setStatus("connecting");
    void updateConnectionNotification(next.host.name, "reconnecting", next.endpoint());
    const stale = () => next.isClosed() || connectionRef.current !== next;
    try {
      const nextSnapshot = await next.connect();
      if (stale()) return;
      setSnapshot(nextSnapshot);
      await startConnectionNotification(next.host.name, next.endpoint());
      setStatus("connected");
      setView({ type: "home" });
    } catch (cause) {
      if (stale()) return;
      if (isAuthorizationError(cause) || isEmbeddedNodeConfigurationError(cause)) {
        next.stopAutoReconnect();
        await stopConnectionNotification();
        setError(cause instanceof Error ? cause.message : "Could not connect to the saved desktop.");
        setStatus("error");
        return;
      }
      void updateConnectionNotification(next.host.name, notificationStateFor(navigator.onLine, false), next.endpoint());
      setError("The desktop connection could not be opened. Retrying…");
      setStatus("connecting");
    }
  }

  useEffect(() => {
    let disposed = false;
    void HostConnection.saved().then(async (host) => {
      if (disposed) return;
      if (!host) { setStatus("pairing"); return; }
      void startHostConnection(host);
    });
    return () => {
      disposed = true;
      connectionRef.current?.close();
    };
  }, []);

  // Re-read the previously paired desktop list whenever the hosts page is
  // entered (or its background status changes), so a just-paired desktop
  // shows up when the user comes back from the pairing screen.
  useEffect(() => {
    if (view.type !== "hosts") return;
    let disposed = false;
    void HostConnection.savedHostRecords().then((records) => {
      if (!disposed) { setHostRecords(records); setHostsLoaded(true); }
    });
    return () => { disposed = true; };
  }, [view.type, status]);

  // Opening the hosts page verifies every registered host's phone-side node
  // against the control plane. The persisted enrollment flag is not trusted
  // (a node can be revoked or expire), so a row shows Ready only after its
  // check came back; hosts that were never registered stay LAN only without
  // ever starting a node. The node's own failure code is preserved: the
  // desktop's node resolved but refused the dial means it is registered and
  // simply down (Offline), anything else leaves the row at LAN only. The
  // live desktop is already verified by being connected, so it is skipped.
  // The native engine runs one node per host, so all checks run side by side
  // instead of one after another, and each verdict is cached per host for a
  // minute so revisiting the page does not re-ping hosts that were just
  // checked.
  useEffect(() => {
    if (view.type !== "hosts" || hostChecksStartedRef.current) return;
    hostChecksStartedRef.current = true;
    let disposed = false;
    void runHostChecks(false, () => !disposed).finally(() => {
      if (!disposed) hostChecksStartedRef.current = false;
    });
    return () => {
      disposed = true;
      hostChecksStartedRef.current = false;
    };
  }, [view.type]);

  // Shared by the page-open effect and the header's refresh button. With
  // `force` the one-minute verdict cache is bypassed, so every pending host
  // is re-verified against the control plane and each fresh verdict replaces
  // the cached one; a plain page open reuses live cache entries instead.
  // `isActive` drops results once the caller's page is gone.
  async function runHostChecks(force: boolean, isActive: () => boolean = () => true) {
    const records = await HostConnection.savedHostRecords();
    if (!isActive()) return;
    const cached = new Map<string, RegistrationVerdict>();
    if (!force) {
      for (const record of records) {
        const verdict = await readRegistrationVerdict("hostPing", record.id);
        if (verdict) cached.set(record.id, verdict);
      }
    }
    const plan = hostsPageCheckPlan({ records, liveHostId: connectionRef.current?.host.id, cached, force });
    for (const [hostId, state] of plan.states) {
      setHostChecks((current) => new Map(current).set(hostId, state));
    }
    await Promise.all(plan.toVerify.map(async (record) => {
      const verdict = await HostConnection.verifySavedHostRegistration(record);
      if (!isActive()) return;
      void rememberRegistrationVerdict("hostPing", record.id, verdict);
      setHostChecks((current) => new Map(current).set(record.id, verdict));
    }));
  }

  // The hosts header's refresh button: force a fresh verification round for
  // every registered non-connected host, refreshing the status cache too.
  function refreshHosts() {
    setHostsRefreshing(true);
    void runHostChecks(true).finally(() => setHostsRefreshing(false));
  }

  useEffect(() => {
    if (!connection) return;
    const pairingHolds = () => pairFromHostsRef.current || pairFromHomeRef.current;
    const offSnapshot = connection.on("snapshot", setSnapshot);
    const offConnected = connection.on("connected", (nextSnapshot) => {
      setSnapshot(nextSnapshot);
      if (pairingHolds()) return;
      setError("");
      setStatus("connected");
      void startConnectionNotification(connection.host.name, connection.endpoint());
    });
    const offHeartbeat = connection.on("heartbeat", () => {
      // The native service can detect a route loss while the WebSocket still
      // reports OPEN. A successful heartbeat is the authoritative recovery
      // signal for the notification in that case.
      if (pairingHolds()) return;
      setError("");
      setStatus("connected");
      void updateConnectionNotification(connection.host.name, "connected", connection.endpoint());
    });
    const offReconnecting = connection.on("reconnecting", ({ attempt }) => {
      if (pairingHolds()) return;
      setError(attempt === 1 ? "The desktop connection was lost. Reconnecting…" : "Still trying to reach the desktop…");
      setStatus("connecting");
      void updateConnectionNotification(connection.host.name, notificationStateFor(navigator.onLine, false), connection.endpoint());
    });
    const offReconnectFailed = connection.on("reconnectFailed", (cause) => {
      if (pairingHolds()) return;
      setSnapshot(null);
      setError(cause.message);
      setStatus("error");
      void stopConnectionNotification();
    });
    const offDisconnect = connection.on("disconnected", () => {
      if (pairingHolds()) return;
      setError("The desktop connection was lost. Reconnecting…");
      setStatus("connecting");
      void updateConnectionNotification(connection.host.name, notificationStateFor(navigator.onLine, false), connection.endpoint());
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
      const next = await HostConnection.pair(payload, await deviceIdentity(platform));
      connection?.close();
      next.startAutoReconnect();
      next.setScreenAwake(screenAwakeRef.current);
      next.setDeviceSleeping(deviceSleepingRef.current);
      // Pairing succeeded: HostConnection.pair persisted the newly paired
      // desktop as the launch default and added it to the previously paired
      // list; every other desktop stays listed.
      setConnection(next); setSnapshot(next.snapshot ?? null); setRemoteRegistration(next.remoteRegistrationState()); setStatus("connected"); setView({ type: "home" }); setHostName(next.host.name); setPairFromHosts(false); setPairFromHome(false);
      await startConnectionNotification(next.host.name, next.endpoint());
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

  // Open the hosts page. From home the live connection keeps running, so the
  // connected desktop's row shows its "connected" indicator. From the
  // try-again screen the dead attempt is dropped and the error status stays
  // put, so back from the page lands back on the try-again screen.
  function openHosts() {
    if (status === "error") {
      connectionRef.current?.close();
      connectionRef.current = null;
      setConnection(null);
      setSnapshot(null);
      setRemoteRegistration({ status: "unregistered" });
    }
    setView({ type: "hosts" });
  }

  // Stop the retry loop and land on the try-again screen. The saved desktop
  // record is kept, so "Try again" still targets it.
  function cancelConnection() {
    connectionRef.current?.close();
    connectionRef.current = null;
    setConnection(null); setSnapshot(null); setRemoteRegistration({ status: "unregistered" });
    setError("The connection was cancelled.");
    setStatus("error");
    void stopConnectionNotification();
  }

  // The hosts page's "Pair a new desktop" action. It captures the status and
  // the try-again message so back can restore them, clears the error so the
  // pairing screen opens clean (a failed connection must not be read as a
  // failed pairing), and no record changes happen on the way in: a pairing
  // only commits when it succeeds (HostConnection.pair).
  function enterPairFromHosts() {
    // status/error are read through refs: this function is reachable from
    // the mount-time back-key listener, whose closure would otherwise hold
    // the first render's status.
    prePairStatusRef.current = statusRef.current === "error" ? "error" : "connected";
    prePairErrorRef.current = errorRef.current;
    setError("");
    setPairFromHosts(true);
    setStatus("pairing");
  }

  // The home view's bottom-nav "Pair" button. The home view only renders
  // while connected, so back always returns to it: no pre-pair capture is
  // needed beyond pinning the restore ref to "connected".
  function enterPairFromHome() {
    prePairStatusRef.current = "connected";
    setError("");
    setPairFromHome(true);
    setStatus("pairing");
  }

  // Shared by the pairing screen's back button and the Android back key:
  // return to the page the pairing screen was opened from (the hosts page or
  // the home view). While the pairing screen was open the live
  // connection's events were held back (pairFromHostsRef / pairFromHomeRef),
  // so the restored status is re-evaluated from the connection's current
  // reality instead of trusting the captured one: a live desktop comes back
  // connected, a lost one is reconnected now, and a session that started on
  // the try-again screen goes back to it with its original message. The
  // branch choices themselves live in navigationPolicy so they stay tested;
  // this only executes the chosen branch.
  function backFromPairing() {
    setPairFromHosts(false);
    setPairFromHome(false);
    const live = connectionRef.current;
    const decision = pairingRestoreDecision({
      prePairStatus: prePairStatusRef.current,
      liveConnectionOpen: Boolean(live && !live.isClosed()),
      liveHasSnapshot: Boolean(live && live.snapshot)
    });
    if (decision === "restoreError") {
      setError(prePairErrorRef.current);
      setStatus("error");
      return;
    }
    if (decision === "connected") {
      setError("");
      setStatus("connected");
      return;
    }
    void HostConnection.saved().then((host) => {
      const step = pairingReconnectStep(host !== null);
      if (step === "startHostConnection" && host) void startHostConnection(host);
      else if (step === "stayOnPairing") setStatus("pairing");
    });
  }

  // Tapping a desktop on the hosts page switches to it. The chosen desktop
  // becomes the launch default right away, so a later "Try again" (which
  // reloads the app) targets it too; every other previously paired desktop
  // stays in the hosts list. Tapping the already-connected desktop is a
  // no-op.
  function selectHost(record: SavedHostRecord) {
    if (connection?.host.id === record.id) return;
    connection?.close();
    connectionRef.current = null;
    setConnection(null);
    setSnapshot(null);
    setRemoteRegistration({ status: "unregistered" });
    setError("");
    setView({ type: "home" });
    void stopConnectionNotification();
    void HostConnection.saveHost(record);
    void startHostConnection(record);
  }

  // Remove a desktop from the previously paired list. When the removed entry
  // is the launch default, the default is repointed to the most recently
  // connected survivor, or dropped when none remain (see
  // HostConnection.removeSavedHostRecord). A live session to the removed
  // desktop keeps running until the next launch; only the saved record is
  // removed.
  async function removeHost(record: SavedHostRecord) {
    setHostRecords(await HostConnection.removeSavedHostRecord(record.id));
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
    if (view.type === "terminal") {
      // A cd in the shell can move the session to another project; land on
      // the project it belongs to now instead of the one it was opened from.
      setView({ type: "project", projectId: backProjectId(snapshot, view) });
    }
    else if (view.type === "project") setView({ type: "home" });
    // The hosts page keeps the app status, so "home" lands on the home view
    // when connected and on the try-again screen when not. With a loaded,
    // empty list there is no useful back target - retrying with no saved
    // desktops would just reload the app into pairing - so back opens the
    // pairing screen instead; its own back button restores the hosts page.
    else if (view.type === "hosts") {
      if (hostsLoaded && hostRecords.length === 0) enterPairFromHosts();
      else setView({ type: "home" });
    }
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
    closeSheet("closeSession");
    setView({ type: "project", projectId: session.projectId });
  }

  // The home view, shared by the pager's live first page and the back-swipe
  // previews below: a preview instance sits in the zone's fill, where
  // pointer events are disabled, so its controls can never fire. Computed
  // before the early-return branches so they can hand their previews to the
  // zone without a use-before-declaration.
  const remoteStatus = registrationDisplayStatusFor(remoteRegistration.status, online);
  const remoteStatusLabel = REGISTRATION_STATUS_LABELS[remoteStatus];
  const homeView = connection && snapshot ? (
    <HomeScreen
      snapshot={snapshot}
      remoteRegistration={remoteRegistration}
      remoteStatus={remoteStatus}
      remoteStatusLabel={remoteStatusLabel}
      orderedProjects={orderedProjects}
      projectDrag={projectDrag}
      projectReordering={projectReordering}
      transformFor={projectDragTransform}
      cardElement={(projectId, element) => { if (element) projectElementsRef.current.set(projectId, element); else projectElementsRef.current.delete(projectId); }}
      onDragStart={beginProjectDrag}
      onDragMove={moveProjectDrag}
      onDragEnd={finishProjectDrag}
      onRetryRegistration={() => void connection.retryRemoteRegistration()}
      onOpenProject={openProject}
      onOpenSession={openTerminal}
      onShowSettings={() => setShowSettings(true)}
      onShowCreateProject={() => setShowCreateProject(true)}
      onPairNew={enterPairFromHome}
      onOpenHosts={openHosts}
    />
  ) : null;

  // The page a back swipe on the hosts page actually lands on (navigateBack):
  // the try-again screen when the hosts page was reached from there, the
  // pairing screen when no desktop is paired (back opens pairing there),
  // otherwise the home view.
  const hostsBackPreview = status === "error"
    ? <ErrorScreen message={error} hostName={hostName || undefined} onRetry={() => window.location.reload()} onConnectDifferent={openHosts} />
    : hostsLoaded && hostRecords.length === 0
      ? <PairScreen error={error} manualCode={manualCode} showManual={showManual} onManualCode={setManualCode} onShowManual={() => setShowManual(true)} onScan={() => void scan()} onPair={() => void pair(manualCode)} />
      : homeView;

  // The page a back swipe on the pairing screen actually lands on
  // (backFromPairing): the page it was opened from - the hosts page (or the
  // try-again screen when pairing started after a failed connection), or the
  // home view when the home bottom nav started it.
  const pairBackPreview = pairFromHosts
    ? prePairStatusRef.current === "error"
      ? <ErrorScreen message={prePairErrorRef.current} hostName={hostName || undefined} onRetry={() => window.location.reload()} onConnectDifferent={openHosts} />
      : <HostsPage records={hostRecords} loaded={hostsLoaded} connectedId={connection?.host.id ?? null} registration={remoteRegistration} online={online} checks={hostChecks} refreshing={hostsRefreshing} onBack={navigateBack} onSelect={(record) => selectHost(record)} onRemove={(record) => void removeHost(record)} onPairNew={enterPairFromHosts} onRefresh={() => void refreshHosts()} />
    : connection && snapshot ? homeView : <ErrorScreen message={error} hostName={hostName || undefined} onRetry={() => window.location.reload()} onConnectDifferent={openHosts} />;

  if (status === "loading" || status === "connecting") {
    // The cancel control only makes sense while a saved desktop connection is
    // being retried; a pairing attempt (connection is null) keeps the plain
    // splash so cancelling it cannot drop the user into the try-again page.
    const retryingSavedHost = isRetryingSavedHost(status, connection !== null);
    return <Splash label={status === "loading" ? "Opening Agent Terminal" : error || "Connecting to desktop"} hostName={retryingSavedHost ? hostName : undefined} onCancel={retryingSavedHost ? cancelConnection : undefined} />;
  }
  if (status === "pairing") {
    // From an empty hosts list, back has no useful destination (it would just
    // open the pairing screen again), so that pairing screen behaves like a
    // first launch: no back button and no back swipe. The branch choices
    // live in navigationPolicy.pairScreenShowsBack so they stay tested.
    const pairShowsBack = pairScreenShowsBack({ pairFromHosts, pairFromHome, hostsEmpty: hostsLoaded && hostRecords.length === 0 });
    return <PairScreen error={error} manualCode={manualCode} showManual={showManual} onManualCode={setManualCode} onShowManual={() => setShowManual(true)} onScan={() => void scan()} onPair={() => void pair(manualCode)} onBack={pairShowsBack ? backFromPairing : undefined} preview={pairShowsBack ? pairBackPreview : undefined} />;
  }
  if (view.type === "hosts" && (status === "connected" || status === "error")) {
    // Reached from home the live connection stays open and its row carries
    // the "connected" indicator; reached from the try-again screen the error
    // status is retained, so back returns there.
    return <HostsPage records={hostRecords} loaded={hostsLoaded} connectedId={connection?.host.id ?? null} registration={remoteRegistration} online={online} checks={hostChecks} refreshing={hostsRefreshing} onBack={navigateBack} onSelect={(record) => selectHost(record)} onRemove={(record) => void removeHost(record)} onPairNew={enterPairFromHosts} onRefresh={() => void refreshHosts()} preview={hostsBackPreview} />;
  }
  if (status === "error") return <ErrorScreen message={error} hostName={hostName || undefined} onRetry={() => window.location.reload()} onConnectDifferent={openHosts} />;
  if (!connection || !snapshot) return null;

  // The "hosts" case is unreachable here (the hosts branch returned above);
  // listing it keeps the union exhaustive for the type checker.
  const requestedProjectId = view.type === "home" || view.type === "hosts" ? selectedProjectId : view.projectId;
  const requestedSessionId = view.type === "terminal" ? view.sessionId : selectedSessionId;
  // A terminal view follows its session even when a cd in the shell moves it
  // to another project: the phone stays attached, and the project shown (and
  // navigated/backed into) is the one the session currently belongs to.
  const { activeProject, activeSession, pageCount, currentPage } = resolveViewGeometry(snapshot, {
    viewType: view.type,
    requestedProjectId,
    requestedSessionId
  });

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
    if (swipeRef.current || event.pointerType === "mouse") return;
    const sheetRoot = target?.closest(".sheet-backdrop");
    // While an overlay is open its content owns the pointer sequence. The
    // page pager must not navigate, and the sheet's own vertical swipe-down
    // dismissal is tracked instead. Taps are still tracked so a control in
    // the sheet keeps working when Chromium eats the first click after a drag.
    if (sheetRoot) {
      const busy = Boolean(target?.closest(".sheet-backdrop[data-busy]"));
      const scrollable = target ? sheetTargetScrollable(target, sheetRoot) : false;
      const next: SwipeState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startedAt: performance.now(), deltaX: 0, horizontal: false, overlay: true, blocked: busy || scrollable, sheetDragging: false, deltaY: 0, onSlider: Boolean(target?.closest('input[type="range"]')) };
      swipeRef.current = next;
      return;
    }
    if (showTerminalSettings || showSettings || projectToRename || sessionToClose || showCreateProject) return;
    const terminalText = target?.closest(".xterm-accessibility-tree");
    const selection = document.getSelection();
    const draggingTerminalSelection = Boolean(terminalText && selection && !selection.isCollapsed && selection.anchorNode && terminalText.contains(selection.anchorNode));
    if (draggingTerminalSelection) return;
    const next: SwipeState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startedAt: performance.now(), deltaX: 0, horizontal: false, overlay: false, blocked: false, sheetDragging: false, deltaY: 0, onSlider: false };
    swipeRef.current = next;
  }

  function moveSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    const current = swipeRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const rawX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (current.overlay) {
      if (current.blocked) return;
      if (!current.sheetDragging) {
        // A drag on the character-width slider is a thumb pull, not a swipe:
        // let it win on slight downward drift too, so only a clearly vertical
        // movement claims the sheet dismissal.
        const axis = classifyGestureAxis(rawX, deltaY, current.onSlider ? SHEET_SLIDER_HORIZONTAL_BIAS : undefined);
        if (axis === "pending") return;
        if (axis === "horizontal" || deltaY <= 0) {
          // A horizontal move starts no sheet drag and no page navigation.
          // An upward move does not dismiss; the sheet content is not a
          // scroll region here, so there is nothing to do with the gesture.
          swipeRef.current = null;
          setSwipe(null);
          return;
        }
        const next = { ...current, sheetDragging: true, deltaY };
        swipeRef.current = next;
        setSheetDragging(true);
        setSheetDragY(deltaY);
        return;
      }
      const next = { ...current, deltaY };
      swipeRef.current = next;
      setSheetDragY(Math.max(0, deltaY));
      event.preventDefault();
      return;
    }
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
    if (current.overlay) {
      swipeRef.current = null;
      setSwipe(null);
      setSheetDragging(false);
      if (current.sheetDragging && !cancelled && !current.blocked) {
        const elapsed = Math.max(1, performance.now() - current.startedAt);
        const distancePx = Math.max(0, event.clientY - current.startY);
        if (shouldCommitSheetDismiss({ cancelled, distancePx, velocityPxPerMs: distancePx / elapsed }) && !document.querySelector(".sheet-backdrop[data-busy]")) {
          dismissActiveSheet();
          squashSwipeClick(event);
          // The exit starts from where the finger let go: the drag offset is
          // released only when the sheet actually unmounts (finishSheetClose).
        } else {
          setSheetDragY(0);
        }
      } else {
        setSheetDragY(0);
      }
      // Taps inside the sheet still need the click bridge: a taut tap on a
      // sheet control is fired directly so it works right after a drag.
      if (!cancelled) bridgeTapClick(event, current);
      return;
    }
    const elapsed = Math.max(1, performance.now() - current.startedAt);
    const velocity = Math.abs(current.deltaX) / elapsed;
    const canNavigate = current.deltaX > 0 ? currentPage > 0 : currentPage < pageCount - 1;
    const commit = !cancelled && current.horizontal && canNavigate && (Math.abs(current.deltaX) > window.innerWidth * SWIPE_COMMIT_DISTANCE_RATIO || velocity > SWIPE_COMMIT_VELOCITY_PX_MS);
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
    // Trailing-click swallowing of bridged taps runs at the document root
    // (above), where it survives view swaps. This pager-level handler only
    // owns the post-swipe guard below.
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

  // Close request that plays the sheet's exit animation. Every close path
  // (a control in the sheet, a backdrop tap, the Android back key, a
  // swipe-down dismissal, a confirmed session close) goes through here: the
  // sheet stays mounted while it slides down, and finishSheetClose
  // unmounts it once the exit has finished.
  function closeSheet(kind: SheetKind) {
    // Sheets are mutually exclusive; a close already in flight must not be
    // restarted (a second request while a sheet is sliding down is a no-op
    // - the unmount in flight owns the cleanup).
    if (sheetClosingRef.current !== null) return;
    sheetClosingRef.current = kind;
    setClosingSheet(kind);
  }

  function finishSheetClose(kind: SheetKind) {
    if (sheetClosingRef.current !== kind) return;
    sheetClosingRef.current = null;
    setClosingSheet(null);
    switch (kind) {
      case "createProject": setShowCreateProject(false); break;
      case "rename": setProjectToRename(null); break;
      case "closeSession": setSessionToClose(null); break;
      case "terminalSettings": setShowTerminalSettings(false); break;
      case "settings": setShowSettings(false); break;
    }
    // The sheet is gone: release the drag offset a swipe-down dismissal
    // left behind, so the next sheet opens from its base position.
    setSheetDragY(0);
  }

  function dismissActiveSheet() {
    if (showSettings) { closeSheet("settings"); return; }
    if (showTerminalSettings) { closeSheet("terminalSettings"); return; }
    if (projectToRename) { closeSheet("rename"); return; }
    if (sessionToClose) { closeSheet("closeSession"); return; }
    if (showCreateProject) { closeSheet("createProject"); return; }
  }

  function squashSwipeClick(event: ReactPointerEvent<HTMLDivElement>) {
    // A drag that dismisses the sheet must not land a click on whatever
    // becomes exposed underneath. Swallow the compatibility click it trails.
    swallowTapClickRef.current = true;
    swallowTapClickAtRef.current = { x: event.clientX, y: event.clientY };
    if (swallowTapClickTimerRef.current !== undefined) window.clearTimeout(swallowTapClickTimerRef.current);
    swallowTapClickTimerRef.current = window.setTimeout(() => {
      swallowTapClickRef.current = false;
      swallowTapClickAtRef.current = { x: 0, y: 0 };
      swallowTapClickTimerRef.current = undefined;
    }, SWALLOW_CLICK_LINGER_MS);
  }

  return <div className={`mobile-pager ${sheetDragging ? "is-sheet-dragging" : ""}`} style={{ ["--sheet-drag-y" as string]: `${sheetDragY}px` } as React.CSSProperties} onPointerDownCapture={beginSwipe} onTouchStartCapture={() => { suppressSwipeClickRef.current = false; swipeClickPageRef.current = null; if (swipeClickTimerRef.current !== undefined) window.clearTimeout(swipeClickTimerRef.current); swipeClickTimerRef.current = undefined; swallowTapClickRef.current = false; if (swallowTapClickTimerRef.current !== undefined) window.clearTimeout(swallowTapClickTimerRef.current); swallowTapClickTimerRef.current = undefined; }} onPointerMoveCapture={moveSwipe} onPointerUpCapture={(event) => finishSwipe(event)} onPointerCancelCapture={(event) => finishSwipe(event)} onClickCapture={suppressSwipeClick}>
    <div className={`mobile-page-track ${swipe?.horizontal ? "is-dragging" : ""}`} style={{ transform: `translate3d(calc(${-currentPage * 100}% + ${swipe?.deltaX ?? 0}px),0,0)` }}>
      <div className="mobile-page">{homeView}</div>
      {activeProject && <div className="mobile-page"><ProjectScreen project={activeProject} snapshot={snapshot} connection={connection} onBack={navigateBack} onRename={() => setProjectToRename(activeProject)} onOpen={openTerminal} /></div>}
      {activeProject && activeSession && <div className="mobile-page"><div className="mobile-app terminal-view">
        <MobileHeader title={activeSession.title} subtitle={activeProject.name} onBack={navigateBack} trailing={<div className="session-actions"><span className={`session-state ${terminalStateOf(activeSession)}`}>{terminalStateOf(activeSession)}</span><button className="terminal-settings-button" onClick={() => setShowTerminalSettings(true)} aria-label="Terminal display settings"><SettingsIcon /></button><button className="close-session-button" onClick={() => setSessionToClose(activeSession)} aria-label="Close terminal session" title="Close terminal session"><CloseIcon /></button></div>} />
        <MobileTerminal key={activeSession.id} active={view.type === "terminal"} fontWidthScale={fontWidthPercent / 100} connection={connection} session={activeSession} scheme={terminalScheme} />
      </div></div>}
    </div>
    {(showCreateProject || closingSheet === "createProject") && (
      <CreateProjectSheet connection={connection} closing={closingSheet === "createProject"} onClose={() => closeSheet("createProject")} onClosed={() => finishSheetClose("createProject")} />
    )}
    {projectToRename && ((activeProject?.id === projectToRename.id) || closingSheet === "rename") && (
      <RenameProjectSheet project={projectToRename} connection={connection} closing={closingSheet === "rename"} onClose={() => closeSheet("rename")} onClosed={() => finishSheetClose("rename")} />
    )}
    {sessionToClose && ((activeSession?.id === sessionToClose.id) || closingSheet === "closeSession") && (
      <CloseSessionSheet session={sessionToClose} closing={closingSheet === "closeSession"} onClose={() => closeSheet("closeSession")} onConfirm={() => closeSession(sessionToClose)} onClosed={() => finishSheetClose("closeSession")} />
    )}
    {(showTerminalSettings || closingSheet === "terminalSettings") && (
      <TerminalSettingsSheet snapshot={snapshot} connection={connection} value={fontWidthPercent} onChange={(value) => { setFontWidthPercent(value); void Preferences.set({ key: TERMINAL_FONT_WIDTH_KEY, value: String(value) }); }} themePreference={themePreference} onThemeChange={setThemePreference} resolvedTheme={resolvedTheme} closing={closingSheet === "terminalSettings"} onClose={() => closeSheet("terminalSettings")} onClosed={() => finishSheetClose("terminalSettings")} />
    )}
    {(showSettings || closingSheet === "settings") && (
      <SettingsSheet snapshot={snapshot} connection={connection} fontWidthPercent={fontWidthPercent} onFontWidthChange={(value) => { setFontWidthPercent(value); void Preferences.set({ key: TERMINAL_FONT_WIDTH_KEY, value: String(value) }); }} themePreference={themePreference} onThemeChange={setThemePreference} resolvedTheme={resolvedTheme} closing={closingSheet === "settings"} onClose={() => closeSheet("settings")} onClosed={() => finishSheetClose("settings")} />
    )}
  </div>;
}

function sheetTargetScrollable(target: Element, sheetRoot: Element): boolean {
  // A swipe-down dismissal must never fight a native scroll inside the sheet.
  // Walk from the tap up to the sheet root: the first overflow-y auto/scroll
  // ancestor marks a scrolling section (the directory list) that keeps the
  // gesture, so it does not close the overlay. The character-width range
  // input has no scrollable ancestor, so a swipe down starting on it still
  // dismisses.
  let element: Element | null = target;
  while (element && element !== sheetRoot) {
    if (element instanceof HTMLElement) {
      const style = getComputedStyle(element);
      if (style.overflowY === "auto" || style.overflowY === "scroll") return true;
    }
    element = element.parentElement;
  }
  return false;
}

function RemoteRegistrationBanner({ state, onRetry }: { state: RemoteRegistrationState; onRetry: () => void }) {
  if (state.status !== "failed") return null;
  return <aside className="mobile-registration-banner" role="status">
    <span>{state.error ?? "Remote connection registration failed. LAN access is still available."}</span>
    <button onClick={onRetry}>Retry</button>
  </aside>;
}

async function startConnectionNotification(hostName: string, endpoint = "") {
  if (Capacitor.getPlatform() !== "android") return;
  try { await ConnectionNotification.start({ hostName, endpoint }); } catch { /* The connection still works if notifications are denied. */ }
}

async function updateConnectionNotification(hostName: string, state: ConnectionNotificationState, endpoint = "") {
  if (Capacitor.getPlatform() !== "android") return;
  try { await ConnectionNotification.update({ hostName, state, endpoint }); } catch { /* The service may be unavailable while Android recreates the app process. */ }
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
      {sessions.length ? <div className="session-list">{sessions.map((session) => <button key={session.id} onClick={() => onOpen(session)}><span className="session-icon"><TerminalIcon /></span><span><strong className="display-name" title={session.title}>{session.title}</strong><small>{session.status !== "running" ? `Exited · ${session.exitCode ?? "—"}` : session.activity === "active" ? "Running" : "Idle"}</small></span><i className={sessionDotClass(session)} /><ChevronIcon /></button>)}</div> : <div className="inline-empty">No open terminal sessions.</div>}
    </section>
  </div>;
}

/**
 * The status dot beside a terminal tab, on the project list and inside a
 * project alike. `running` colors it green; `is-active` blinks it while
 * the host reports the shell blocked on a foreground program.
 */
function sessionDotClass(session: TerminalSession): string {
  return `${session.status} ${isSessionActive(session) ? "is-active" : ""}`.trim();
}

/**
 * The chip in the terminal header. `status` alone only ever said
 * "running", which is true of a shell sitting at a prompt and of one
 * halfway through a build; the distinction is the point of the chip.
 */
function terminalStateOf(session: TerminalSession): "running" | "idle" | "exited" {
  if (session.status !== "running") return "exited";
  return isSessionActive(session) ? "running" : "idle";
}

function ProjectCard({ project, sessions, dragging, reordering, transform, elementRef, onDragStart, onDragMove, onDragEnd, onClick, onSession }: { project: Project; sessions: TerminalSession[]; dragging: boolean; reordering: boolean; transform?: string; elementRef: (element: HTMLElement | null) => void; onDragStart: (event: ReactPointerEvent<HTMLElement>) => void; onDragMove: (event: ReactPointerEvent<HTMLElement>) => void; onDragEnd: (event: ReactPointerEvent<HTMLElement>, commit: boolean) => void; onClick: () => void; onSession: (session: TerminalSession) => void }) {
  return <article ref={elementRef} className={`project-card ${dragging ? "is-dragging" : ""} ${reordering ? "is-reordering" : ""}`} style={{ transform }}><button className="project-card-main" onClick={onClick}><span className="card-folder"><FolderIcon /></span><span className="card-copy"><strong className="display-name" title={project.name}>{project.name}</strong><small>{project.path}</small></span><span className="card-persist">{project.persistent ? <BookmarkIcon /> : <ClockIcon />}</span><span className="mobile-project-drag" role="button" aria-label={`Reorder ${project.name}`} data-no-swipe onClick={(event) => event.stopPropagation()} onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={(event) => onDragEnd(event, true)} onPointerCancel={(event) => onDragEnd(event, false)}>⠿</span><ChevronIcon /></button>
    {!!sessions.length && <div className="card-sessions">{sessions.slice(0, 3).map((session) => <button key={session.id} onClick={() => onSession(session)}><TerminalIcon /><span className="display-name" title={session.title}>{session.title}</span><i className={sessionDotClass(session)} /></button>)}{sessions.length > 3 && <span className="more-sessions">+{sessions.length - 3}</span>}</div>}
  </article>;
}

/**
 * The home view (the pager's first page). One component so the pager's live
 * page and the back-swipe previews (hosts page, pairing screen) render
 * exactly the same thing: the preview instance sits in the zone's fill,
 * where pointer events are disabled, so its controls can never fire.
 */
function HomeScreen({ snapshot, remoteRegistration, remoteStatus, remoteStatusLabel, orderedProjects, projectDrag, projectReordering, transformFor, cardElement, onDragStart, onDragMove, onDragEnd, onRetryRegistration, onOpenProject, onOpenSession, onShowSettings, onShowCreateProject, onPairNew, onOpenHosts }: {
  snapshot: HostSnapshot;
  remoteRegistration: RemoteRegistrationState;
  remoteStatus: RegistrationDisplayStatus;
  remoteStatusLabel: string;
  orderedProjects: Project[];
  projectDrag: ProjectDragState | null;
  projectReordering: boolean;
  transformFor: (projectId: string, index: number) => string | undefined;
  cardElement: (projectId: string, element: HTMLElement | null) => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>, projectId: string, index: number) => void;
  onDragMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragEnd: (event: ReactPointerEvent<HTMLElement>, commit: boolean) => void;
  onRetryRegistration: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenSession: (session: TerminalSession) => void;
  onShowSettings: () => void;
  onShowCreateProject: () => void;
  onPairNew: () => void;
  onOpenHosts: () => void;
}) {
  return <div className="mobile-app home-view">
    <RemoteRegistrationBanner state={remoteRegistration} onRetry={onRetryRegistration} />
    <header className="home-header">
      <div><span className="eyebrow">Connected desktop</span><h1>{snapshot.host.name}</h1><span className="connection-label"><i /> Online · {sessionActivitySummary(snapshot.sessions).label}</span></div>
      <div className="home-header-actions"><span className={`mobile-remote-status is-${remoteStatus}`} role="status"><i />{remoteStatusLabel}</span><button className="round-button" onClick={onShowSettings} title="Settings" aria-label="App settings"><MoreIcon /></button></div>
    </header>
    <section className="home-content">
      <div className="section-title"><span>Projects</span><button onClick={onShowCreateProject}><PlusIcon /> New</button></div>
      <div className="project-cards">
        {orderedProjects.map((project, index) => <ProjectCard key={project.id} elementRef={(element) => cardElement(project.id, element)} project={project} sessions={snapshot.sessions.filter((session) => session.projectId === project.id)} dragging={project.id === projectDrag?.projectId} reordering={projectReordering} transform={transformFor(project.id, index)} onDragStart={(event) => onDragStart(event, project.id, index)} onDragMove={onDragMove} onDragEnd={onDragEnd} onClick={() => onOpenProject(project.id)} onSession={onOpenSession} />)}
      </div>
      {!snapshot.projects.length && <div className="mobile-empty"><FolderIcon /><h2>No projects yet</h2><p>Add a folder from your desktop to begin.</p></div>}
    </section>
    <nav className="bottom-nav"><button className="active"><FolderIcon /><span>Projects</span></button><button onClick={onPairNew}><ScanIcon /><span>Pair</span></button><button onClick={onOpenHosts}><WifiIcon /><span>Hosts</span></button></nav>
  </div>;
}

/**
 * Bottom-sheet chrome with the slide-up/slide-down animation: on mount the
 * sheet starts off-screen below the transparent scrim and slides up; while
 * `closing` is true it slides back down and fires `onClosed` once the exit
 * transition ends (a timer covers the cases where transitions never run)
 * so the parent can unmount it.
 */
function SheetChrome({ closing, busy, sheetClass, onDismiss, onClosed, children }: {
  closing: boolean;
  /** A request is in flight; a backdrop tap must not close the sheet. */
  busy?: boolean;
  sheetClass?: string;
  onDismiss: () => void;
  onClosed: () => void;
  children: React.ReactNode;
}) {
  const [entered, setEntered] = useState(false);
  const closedRef = useRef(false);
  useEffect(() => {
    // Two frames: the first paint holds the off-screen start position, the
    // second flips to open so the slide-up transition runs.
    let inner: number | undefined;
    const outer = window.requestAnimationFrame(() => { inner = window.requestAnimationFrame(() => setEntered(true)); });
    return () => {
      window.cancelAnimationFrame(outer);
      if (inner !== undefined) window.cancelAnimationFrame(inner);
    };
  }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      if (closedRef.current) return;
      closedRef.current = true;
      onClosed();
    }, SHEET_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [closing, onClosed]);
  return (
    <div
      className={`sheet-backdrop${entered ? " is-open" : ""}${closing ? " is-closing" : ""}`}
      data-busy={busy ? "" : undefined}
      onClick={busy || closing ? undefined : onDismiss}
    >
      <section
        className={`bottom-sheet${sheetClass ? ` ${sheetClass}` : ""}`}
        data-no-swipe
        onClick={(event) => event.stopPropagation()}
        onTransitionEnd={(event) => {
          // The sheet's own transform transition is the exit signal; the
          // backdrop's opacity end lands on the backdrop and a child's
          // transitionend bubbles up, so only the section itself counts.
          if (closing && !closedRef.current && event.target === event.currentTarget && event.propertyName === "transform") {
            closedRef.current = true;
            onClosed();
          }
        }}
      >
        <i className="sheet-handle" />
        {children}
      </section>
    </div>
  );
}

function TerminalSettingsSheet({ snapshot, connection, value, onChange, themePreference, onThemeChange, resolvedTheme, closing, onClose, onClosed }: { snapshot: HostSnapshot; connection: HostConnection; value: number; onChange: (value: number) => void; themePreference: ThemePreference; onThemeChange: (value: ThemePreference) => void; resolvedTheme: ResolvedTheme; closing: boolean; onClose: () => void; onClosed: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <SheetChrome closing={closing} busy={saving} sheetClass="terminal-settings-sheet" onDismiss={onClose} onClosed={onClosed}><span className="eyebrow">Terminal display</span><h2>Appearance</h2>
    <TerminalPreferences snapshot={snapshot} connection={connection} fontWidthPercent={value} onFontWidthChange={onChange} themePreference={themePreference} onThemeChange={onThemeChange} resolvedTheme={resolvedTheme} saving={saving} onSavingChange={setSaving} onError={setError} />
    {error && <div className="form-error">{error}</div>}
    <button className="mobile-primary full" onClick={onClose}>Done</button></SheetChrome>;
}

/** The slider and its live preview, in one box. */
function FontWidthControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="font-width-control">
    <label><span><strong>Terminal character width</strong><output>{value}%</output></span><input type="range" min={FONT_WIDTH_MIN} max={FONT_WIDTH_MAX} step={FONT_WIDTH_STEP} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>
    <div className="font-width-preview"><span className="font-width-preview-text" style={{ transform: `scaleX(${value / 100})` }}>MyProject&gt; npm run dev</span></div>
  </div>;
}

/**
 * Every terminal-facing preference, shared by the terminal page's sheet and
 * the home settings sheet so the two can never drift apart. The home sheet
 * adds only the settings that belong to it alone (the default shell).
 *
 * The scheme pair is a host setting, so changing it needs the connection and
 * reports progress up to whichever sheet is hosting this block.
 */
function TerminalPreferences({ snapshot, connection, fontWidthPercent, onFontWidthChange, themePreference, onThemeChange, resolvedTheme, saving, onSavingChange, onError }: { snapshot: HostSnapshot; connection: HostConnection; fontWidthPercent: number; onFontWidthChange: (value: number) => void; themePreference: ThemePreference; onThemeChange: (value: ThemePreference) => void; resolvedTheme: ResolvedTheme; saving: boolean; onSavingChange: (saving: boolean) => void; onError: (message: string) => void }) {
  const terminalTheme = normalizeTerminalThemeSettings(snapshot.terminalTheme);
  async function syncTerminalTheme(darkSchemeId: string, lightSchemeId: string) {
    onSavingChange(true); onError("");
    try {
      await connection.request({ type: "terminal.theme", requestId: createRequestId(), darkSchemeId, lightSchemeId });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not change the terminal colors.");
    } finally {
      onSavingChange(false);
    }
  }
  return <>
    <div className="settings-group">
      <div className="settings-field"><span><strong>Appearance</strong></span><div className="theme-choice" role="group" aria-label="Appearance">{THEME_PREFERENCES.map((preference) => <button key={preference} type="button" aria-pressed={themePreference === preference} onClick={() => onThemeChange(preference)}>{THEME_LABELS[preference]}</button>)}</div></div>
      <label className="settings-field"><span><strong>Terminal colors · Dark{resolvedTheme === "dark" && <i className="active-dot" title="Painting this phone now" />}</strong></span><select value={terminalTheme.darkSchemeId} disabled={saving} onChange={(event) => void syncTerminalTheme(event.target.value, terminalTheme.lightSchemeId)}>{terminalSchemesFor("dark").map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
      <label className="settings-field"><span><strong>Terminal colors · Light{resolvedTheme === "light" && <i className="active-dot" title="Painting this phone now" />}</strong></span><select value={terminalTheme.lightSchemeId} disabled={saving} onChange={(event) => void syncTerminalTheme(terminalTheme.darkSchemeId, event.target.value)}>{terminalSchemesFor("light").map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
    </div>
    <FontWidthControl value={fontWidthPercent} onChange={onFontWidthChange} />
  </>;
}

function SettingsSheet({ snapshot, connection, fontWidthPercent, onFontWidthChange, themePreference, onThemeChange, resolvedTheme, closing, onClose, onClosed }: { snapshot: HostSnapshot; connection: HostConnection; fontWidthPercent: number; onFontWidthChange: (value: number) => void; themePreference: ThemePreference; onThemeChange: (value: ThemePreference) => void; resolvedTheme: ResolvedTheme; closing: boolean; onClose: () => void; onClosed: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectedShellId = effectiveDefaultShell(snapshot.shells, snapshot.defaultShellId);
  async function syncDefaultShell(shellId: string) {
    setSaving(true); setError("");
    try {
      await connection.request({ type: "shell.default", requestId: createRequestId(), shellId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the default terminal.");
    } finally {
      setSaving(false);
    }
  }
  return <SheetChrome closing={closing} busy={saving} onDismiss={onClose} onClosed={onClosed}><span className="eyebrow">Settings</span><h2>Preferences</h2>
    <TerminalPreferences snapshot={snapshot} connection={connection} fontWidthPercent={fontWidthPercent} onFontWidthChange={onFontWidthChange} themePreference={themePreference} onThemeChange={onThemeChange} resolvedTheme={resolvedTheme} saving={saving} onSavingChange={setSaving} onError={setError} />
    <div className="settings-group">
      <label className="settings-field"><span><strong>Default terminal</strong></span><select value={selectedShellId} disabled={saving || !snapshot.shells.length} onChange={(event) => void syncDefaultShell(event.target.value)}>{snapshot.shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.name}</option>)}</select></label>
    </div>
    {!snapshot.shells.length && <div className="form-error">No terminal profiles are available on the desktop.</div>}
    {error && <div className="form-error">{error}</div>}
    <button className="mobile-primary full" onClick={onClose}>Done</button></SheetChrome>;
}

function CreateProjectSheet({ connection, closing, onClose, onClosed }: { connection: HostConnection; closing: boolean; onClose: () => void; onClosed: () => void }) {
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
  return <SheetChrome closing={closing} sheetClass="folder-picker-sheet" onDismiss={onClose} onClosed={onClosed}><span className="eyebrow">Desktop project</span><h2>Choose a folder</h2><p>Browse folders on {connection.host.name}, then add the current folder as a project.</p><label>Project name (optional)<input maxLength={MAX_PROJECT_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} placeholder={listing?.path.split(/[\\/]/).filter(Boolean).at(-1) || "Project name"} /></label><div className="folder-location"><button disabled={!listing?.parentPath || loading} onClick={() => void openFolder(listing?.parentPath)} aria-label="Parent folder"><BackIcon /></button><span>{listing?.path ?? "Opening desktop folders…"}</span></div><div className="folder-list" aria-busy={loading}>{loading ? <div className="folder-loading"><i className="loader" />Loading folders…</div> : listing?.directories.length ? listing.directories.map((directory) => <button key={directory.path} onClick={() => void openFolder(directory.path)}><FolderIcon /><span>{directory.name}</span><ChevronIcon /></button>) : <div className="folder-empty">This folder has no subfolders.</div>}</div>{error && <div className="form-error">{error}</div>}<button className="mobile-primary full" disabled={!listing || loading} onClick={() => void submit()}>Add this folder</button><button className="text-button" onClick={onClose}>Cancel</button></SheetChrome>;
}

function RenameProjectSheet({ project, connection, closing, onClose, onClosed }: { project: Project; connection: HostConnection; closing: boolean; onClose: () => void; onClosed: () => void }) {
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
  return <SheetChrome closing={closing} busy={saving} onDismiss={onClose} onClosed={onClosed}><span className="eyebrow">Project name</span><h2>Rename project</h2><p>The desktop folder stays at {project.path}. Leave the name blank to use the folder name.</p><label>Name<input autoFocus maxLength={MAX_PROJECT_NAME_LENGTH} value={name} onChange={(event) => setName(event.target.value)} /></label>{error && <div className="form-error">{error}</div>}<button className="mobile-primary full" disabled={saving} onClick={() => void submit()}>{saving ? "Renaming…" : "Save name"}</button><button className="text-button" disabled={saving} onClick={onClose}>Cancel</button></SheetChrome>;
}

function CloseSessionSheet({ session, closing, onClose, onConfirm, onClosed }: { session: TerminalSession; closing: boolean; onClose: () => void; onConfirm: () => Promise<void>; onClosed: () => void }) {
  // `closing` is the sheet's own exit animation; `busy` is the in-flight
  // session-close request (its backdrop tap is held back the same way).
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true); setError("");
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not close the terminal session."); setBusy(false); }
  }
  return <SheetChrome closing={closing} busy={busy} sheetClass="confirm-sheet" onDismiss={onClose} onClosed={onClosed}><span className="eyebrow">Close terminal</span><h2>End this session?</h2><p>This will terminate <strong title={session.title}>{session.title}</strong> and remove its tab from the desktop and phone.</p>{error && <div className="form-error">{error}</div>}<button className="danger-button" disabled={busy} onClick={() => void confirm()}>{busy ? "Closing…" : "Close terminal"}</button><button className="text-button" disabled={busy} onClick={onClose}>Cancel</button></SheetChrome>;
}

interface BackSwipeDragState {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  deltaX: number;
  horizontal: boolean;
}

/**
 * Wraps a full-screen view (the hosts page, the pairing screen) with a
 * back swipe: a rightward drag slides the view right, revealing `preview`
 * - the page the back gesture actually lands on - underneath it; a
 * committed release slides the view fully off and runs `onBack`. The
 * gesture is armed only while `onBack` is provided - exactly when the view
 * shows its back button - so a view with no back control (the first-launch
 * pairing screen) must not accept the gesture either.
 */
function BackSwipeZone({ onBack, preview, children }: { onBack: (() => void) | undefined; preview?: React.ReactNode; children: React.ReactNode }) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exiting, setExiting] = useState(false);
  const dragRef = useRef<BackSwipeDragState | null>(null);
  const exitingRef = useRef(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  // The committed swipe's trailing compatibility click must not fire a
  // control on the view the navigation lands on (the pager keeps the same
  // guard: the WebView can emit the click after the finger is already
  // gone, on whatever is underneath now).
  const swallowClickRef = useRef(false);
  const swallowClickAtRef = useRef({ x: 0, y: 0 });
  const swallowClickTimerRef = useRef<number | undefined>(undefined);
  const exitTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const swallow = (event: MouseEvent) => {
      if (!swallowClickRef.current) return;
      const nearTap = Math.hypot(event.clientX - swallowClickAtRef.current.x, event.clientY - swallowClickAtRef.current.y) <= SWALLOW_CLICK_DISTANCE_PX;
      const swallowTrailing = shouldSwallowTrailingClick({ armed: true, nearTap });
      // One-shot: whether or not this is the click it waited for, it never
      // outlives this event.
      swallowClickRef.current = false;
      swallowClickAtRef.current = { x: 0, y: 0 };
      if (swallowClickTimerRef.current !== undefined) window.clearTimeout(swallowClickTimerRef.current);
      swallowClickTimerRef.current = undefined;
      if (swallowTrailing) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", swallow, true);
    return () => {
      document.removeEventListener("click", swallow, true);
      if (swallowClickTimerRef.current !== undefined) window.clearTimeout(swallowClickTimerRef.current);
      if (exitTimerRef.current !== undefined) window.clearTimeout(exitTimerRef.current);
    };
  }, []);

  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current || exitingRef.current || !onBackRef.current) return;
    if (event.pointerType === "mouse") return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startedAt: performance.now(), deltaX: 0, horizontal: false };
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const rawX = event.clientX - current.startX;
    if (!current.horizontal) {
      const axis = classifyGestureAxis(rawX, event.clientY - current.startY);
      if (axis === "pending") return;
      if (axis === "vertical") {
        // The view's own vertical motion (its host list, the pairing copy)
        // wins; a scroll is not a back swipe.
        dragRef.current = null;
        return;
      }
      current.horizontal = true;
      setDragging(true);
    }
    // A leftward move has no forward target: resist it, mirroring the
    // pager's dead-zone feel, so the view never rubber-bands the wrong way.
    const deltaX = rawX > 0 ? rawX : rawX * 0.14;
    current.deltaX = deltaX;
    setDragX(deltaX);
    event.preventDefault();
  }

  function end(event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (cancelled) { setDragX(0); return; }
    const elapsed = Math.max(1, performance.now() - current.startedAt);
    const velocity = Math.abs(current.deltaX) / elapsed;
    if (!shouldCommitBackSwipe({ cancelled, deltaX: current.deltaX, widthPx: window.innerWidth, velocityPxPerMs: velocity })) {
      setDragX(0);
      return;
    }
    // Commit: slide the view fully off to the right and navigate once it
    // has left. The drag offset drops at the same time, so the exit
    // transition continues from where the finger let go.
    exitingRef.current = true;
    setExiting(true);
    setDragX(0);
    swallowClickRef.current = true;
    swallowClickAtRef.current = { x: event.clientX, y: event.clientY };
    if (swallowClickTimerRef.current !== undefined) window.clearTimeout(swallowClickTimerRef.current);
    swallowClickTimerRef.current = window.setTimeout(() => {
      swallowClickRef.current = false;
      swallowClickAtRef.current = { x: 0, y: 0 };
      swallowClickTimerRef.current = undefined;
    }, SWALLOW_CLICK_LINGER_MS);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = undefined;
      onBackRef.current?.();
    }, BACK_SWIPE_EXIT_MS);
  }

  return (
    <div
      className={`back-swipe-zone${dragging ? " is-dragging" : ""}${exiting ? " is-exiting" : ""}`}
      onPointerDownCapture={begin}
      onPointerMoveCapture={move}
      onPointerUpCapture={(event) => end(event, false)}
      onPointerCancelCapture={(event) => end(event, true)}
    >
      {/* The page the back swipe lands on, revealed under the sliding view.
          Inert (pointer-events: none) and decorative: the real navigation
          still runs from the sliding view's own controls, so the preview's
          controls can never fire. */}
      <div className="back-swipe-fill" aria-hidden={preview ? true : undefined}>{preview}</div>
      <div className="back-swipe-page" style={dragging ? { transform: `translate3d(${dragX}px,0,0)` } : undefined}>{children}</div>
    </div>
  );
}

function MobileHeader({ title, subtitle, onBack, trailing }: { title: string; subtitle: string; onBack: () => void; trailing?: React.ReactNode }) {
  return <header className="mobile-header"><button className="round-button" onClick={onBack}><BackIcon /></button><span><strong className="display-name" title={title}>{title}</strong><small title={subtitle}>{subtitle}</small></span><div className="header-trailing">{trailing}</div></header>;
}

function PairScreen({ error, manualCode, showManual, onManualCode, onShowManual, onScan, onPair, onBack, preview }: { error: string; manualCode: string; showManual: boolean; onManualCode: (value: string) => void; onShowManual: () => void; onScan: () => void; onPair: () => void; onBack?: () => void; preview?: React.ReactNode }) {
  // The back swipe mirrors the back button: it is offered only when the
  // screen shows one (reached from the hosts page or the home bottom nav).
  return <BackSwipeZone onBack={onBack} preview={preview}><div className="onboarding"><div className="ambient one"/><div className="ambient two"/><div className="onboarding-top">{onBack && <button className="round-button" onClick={onBack} aria-label="Back to try again"><BackIcon /></button>}<span className="logo"><TerminalIcon /></span><strong>Agent Terminal</strong></div><section className="pair-copy"><span className="eyebrow">Desktop, untethered</span><h1>Your Windows terminal.<br/><em>Now in your pocket.</em></h1><p>Scan once while both devices are on the same network to authorize this phone. Once paired, connect to your desktop from anywhere.</p></section><div className="scan-illustration"><span className="scan-corner tl"/><span className="scan-corner tr"/><span className="scan-corner bl"/><span className="scan-corner br"/><div className="qr-art"><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><div className="scan-line"/></div>{error && <div className="pair-error">{error}</div>}<section className="pair-actions"><button className="scan-button" onClick={onScan}><ScanIcon /> Authorize this phone</button>{showManual ? <div className="manual-pair"><textarea value={manualCode} onChange={(event) => onManualCode(event.target.value)} placeholder="Paste setup QR data"/><button onClick={onPair}>Authorize</button></div> : <button className="manual-link" onClick={onShowManual}>Enter setup data manually</button>}<small>Future connections work automatically from any network.</small></section></div></BackSwipeZone>;
}

function Splash({ label, hostName, onCancel }: { label: string; hostName?: string; onCancel?: () => void }) {
  const status = label.endsWith("…") ? label : `${label}…`;
  return <div className="splash"><span className="logo large"><TerminalIcon /></span><strong>Agent Terminal</strong>{hostName && <span className="splash-host">Connecting to {hostName}</span>}<small>{status}</small><i className="loader" />{onCancel && <button className="text-button" onClick={onCancel}>Cancel</button>}</div>;
}
function HostsPage({ records, loaded, connectedId, registration, online, checks, refreshing, onBack, onSelect, onRemove, onPairNew, onRefresh, preview }: { records: SavedHostRecord[]; loaded: boolean; connectedId: string | null; registration: RemoteRegistrationState; online: boolean; checks: ReadonlyMap<string, HostCheckState>; refreshing: boolean; onBack: () => void; onSelect: (record: SavedHostRecord) => void; onRemove: (record: SavedHostRecord) => void; onPairNew: () => void; onRefresh: () => void; preview?: React.ReactNode }) {
  const ordered = sortHostsByLastConnected(records);
  return <BackSwipeZone onBack={onBack} preview={preview}><div className="mobile-app hosts-page">
    <MobileHeader title="Hosts" subtitle={loaded ? `${records.length} paired desktop${records.length === 1 ? "" : "s"}` : "Previously paired desktops"} onBack={onBack} trailing={loaded ? <button className="round-button hosts-refresh" onClick={onRefresh} disabled={refreshing} aria-label="Refresh host statuses" title="Refresh host statuses">{refreshing ? <i className="loader" /> : <RefreshIcon />}</button> : undefined} />
    <section className="hosts-section">
      {!loaded ? <div className="hosts-loading"><i className="loader" />Loading paired desktops…</div>
      : !ordered.length ? <div className="hosts-empty">No paired desktops yet. Pair one below to connect your desktop.</div>
      : <div className="host-list">
        {ordered.map((record) => {
          const isCurrent = record.id === connectedId;
          // The live connection owns the verdict for the connected desktop
          // (it is verified by being connected). Every other registered host
          // must have its own background check come back before the row may
          // show Ready; a host that was never registered shows LAN only
          // immediately.
          const registrationStatus = hostRowRegistrationStatus({
            remoteEnrolled: record.remoteEnrolled,
            isCurrent,
            liveStatus: registrationDisplayStatusFor(registration.status, online),
            check: checks.get(record.id)
          });
          const label = hostRowStatusLabel(registrationStatus, isCurrent);
          return (
            <div key={record.id} className={`host-row${isCurrent ? " is-connected" : ""}`}>
              <button className="host-main" onClick={() => onSelect(record)} aria-label={isCurrent ? `Connected to ${record.name}` : `Connect to ${record.name}`}>
                <span className="host-avatar"><TerminalIcon /></span>
                <span className="host-copy">
                  <strong className="display-name" title={record.name}>{record.name}</strong>
                  <small className={isCurrent ? "is-connected" : ""}>{isCurrent ? "Connected now" : `Last connected ${lastConnectedLabel(record.lastConnectedAt)}`}</small>
                </span>
                <span className={`host-registration is-${registrationStatus}`}><i />{label}</span>
                <i className={`host-status${isCurrent ? " is-online" : ""}`} />
                <ChevronIcon />
              </button>
              <button className="host-remove" onClick={() => onRemove(record)} aria-label={`Remove ${record.name}`} title="Remove desktop"><TrashIcon /></button>
            </div>
          );
        })}
      </div>}
    </section>
    <footer className="hosts-actions"><button className="mobile-primary full" onClick={onPairNew}><PlusIcon /> Pair a new desktop</button></footer>
  </div></BackSwipeZone>;
}

function ErrorScreen({ message, hostName, onRetry, onConnectDifferent }: { message: string; hostName?: string; onRetry: () => void; onConnectDifferent: () => void }) { return <div className="error-screen"><span className="offline-icon"><WifiIcon /></span><h1>Desktop unavailable</h1>{hostName && <p className="error-host">Trying to connect to <strong>{hostName}</strong></p>}<p>{message}</p><button className="mobile-primary full" onClick={onRetry}>Try again</button><button className="text-button" onClick={onConnectDifferent}>Connect to a different desktop</button></div>; }
