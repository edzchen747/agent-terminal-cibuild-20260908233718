import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import QRCode from "qrcode";
import { encodePairingPayload, MAX_PROJECT_NAME_LENGTH, normalizeTerminalThemeSettings, resolveTerminalScheme, terminalSchemesFor } from "@agentterminal/protocol";
import type { Project, TerminalSession } from "@agentterminal/protocol";
import type { DesktopState } from "../../shared/api";
import { BookmarkIcon, ClockIcon, CloseIcon, EditIcon, FolderIcon, MenuIcon, MoreIcon, PhoneIcon, PlusIcon, SeparateIcon, SettingsIcon, SideBySideIcon, SplitViewIcon, StackedIcon, SwapIcon, TerminalIcon, TrashIcon, WifiIcon } from "./icons";
import { projectPersistenceAction, projectRowOpensOnKey } from "./persistence";
import { projectDragTransform, reorderBlock, shouldCommitProjectReorder } from "./project-drag";
import { departedProjects, PROJECT_LEAVE_MS, projectListEntries, type LeavingProject } from "./project-leave";
import { pruneRememberedActiveSessions, rememberProjectActiveSession, resolveProjectActiveSession } from "./active-tab";
import { shellSwitchSessionOrder, shellSwitchSplitGroups } from "./shell-switch";
import { clampSplitRatio, findSplitGroup, isSplitEdgeHintVisible, loadSplitPreferences, moveSessionBlock, normalizeSplitOrder, pairSessionsInOrder, reconcileSplitGroups, replaceSessionInOrder, saveSplitPreferences } from "./split-tabs";
import type { SplitGroup, SplitLayout } from "./split-tabs";
import { deviceListEntryModal, nextModalAfterPairing, nextModalOnEscape, pairModalEscapeTarget, type Modal } from "./modal-navigation";
import { connectedDevices, NO_DEVICES_LABEL } from "./statusbar";
import { effectiveAutoCollapse, isNarrowLayout, loadSidebarPreferences, NARROW_SIDEBAR_WIDTH, saveSidebarPreferences, sidebarOpenAfterAutoCollapseToggle, sidebarOpenAfterNarrowLayout, shouldCollapseSidebar } from "./sidebar";
import { applyTheme, loadThemePreference, resolveTheme, saveThemePreference, SYSTEM_DARK_QUERY, THEME_LABELS, THEME_PREFERENCES, type ThemePreference } from "./theme";
import { TerminalPane } from "./TerminalPane";

interface TabDragState {
  sessionId: string;
  pointerId: number;
  startX: number;
  deltaX: number;
  startIndex: number;
  targetIndex: number;
  didMove: boolean;
  centers: number[];
}

type SplitDropSide = "left" | "right" | null;

type SplitMenu =
  | { kind: "picker"; x: number; y: number; anchorId: string; replaceId?: string }
  | { kind: "manage"; x: number; y: number; groupId: string }
  | { kind: "tab"; x: number; y: number; sessionId: string };

interface SplitResizeState {
  groupId: string;
  pointerId: number;
}

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

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [qr, setQr] = useState("");
  const [pairError, setPairError] = useState("");
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [tabDrag, setTabDrag] = useState<TabDragState | null>(null);
  const [closingSessionIds, setClosingSessionIds] = useState<Set<string>>(() => new Set());
  const [projectDrag, setProjectDrag] = useState<ProjectDragState | null>(null);
  const [projectReordering, setProjectReordering] = useState(false);
  const [leavingProjects, setLeavingProjects] = useState<LeavingProject[]>([]);
  const [splitGroups, setSplitGroups] = useState<SplitGroup[]>(() => loadSplitPreferences().groups);
  const [allowSplitEdgeDrop, setAllowSplitEdgeDrop] = useState(() => loadSplitPreferences().allowEdgeDrop);
  const [splitMenu, setSplitMenu] = useState<SplitMenu | null>(null);
  const [splitDropSide, setSplitDropSide] = useState<SplitDropSide>(null);
  const [resizingSplitId, setResizingSplitId] = useState<string | null>(null);
  const [autoCollapseSidebar, setAutoCollapseSidebar] = useState(() => loadSidebarPreferences().autoCollapse);
  const [narrowLayout, setNarrowLayout] = useState(() => isNarrowLayout(window.innerWidth));
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia(SYSTEM_DARK_QUERY).matches);
  const tabDragRef = useRef<TabDragState | null>(null);
  const tabElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const pendingTabPositionsRef = useRef<Map<string, number> | null>(null);
  const suppressTabClickRef = useRef(false);
  const projectDragRef = useRef<ProjectDragState | null>(null);
  const projectElementsRef = useRef(new Map<string, HTMLDivElement>());
  const previousProjectsRef = useRef<readonly Project[] | null>(null);
  const previousSessionsRef = useRef<readonly TerminalSession[] | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const terminalStackRef = useRef<HTMLDivElement>(null);
  const splitButtonRef = useRef<HTMLButtonElement>(null);
  const splitMenuRef = useRef<HTMLDivElement>(null);
  const splitDropSideRef = useRef<SplitDropSide>(null);
  const splitResizeRef = useRef<SplitResizeState | null>(null);

  useEffect(() => {
    void window.agentTerminal.getState().then(setState);
    return window.agentTerminal.onState(setState);
  }, []);

  // When a project disappears from the host list (e.g. it was removed), keep
  // a ghost card in its old slot so the sidebar can play the leave: the card
  // slides off the left edge, then its slot collapses and the cards below
  // slide up to close the gap. Ghosts are unmounted once the animation runs
  // out (PROJECT_LEAVE_MS); the CSS side lives on `.project-item.is-leaving`.
  useEffect(() => {
    const projects = state?.projects ?? [];
    const previousProjects = previousProjectsRef.current;
    const previousSessions = previousSessionsRef.current ?? [];
    previousProjectsRef.current = projects;
    previousSessionsRef.current = state?.sessions ?? [];
    if (!previousProjects || previousProjects === projects) return;
    const leavings = departedProjects(previousProjects, projects, previousSessions);
    if (!leavings.length) return;
    // The tab-reorder slides skip animation under the same setting, so the
    // leave does too.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setLeavingProjects((current) => [
      ...current.filter((entry) => !leavings.some((leaving) => leaving.project.id === entry.project.id)),
      ...leavings
    ]);
    window.setTimeout(() => {
      setLeavingProjects((current) => current.filter((entry) => !leavings.some((leaving) => leaving.project.id === entry.project.id)));
    }, PROJECT_LEAVE_MS);
  }, [state]);

  useEffect(() => window.agentTerminal.onPairingSucceeded(() => {
    setModal((current) => nextModalAfterPairing(current));
    setQr("");
    setPairError("");
  }), []);

  useEffect(() => {
    if (!modal) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setModal(nextModalOnEscape(modal, renaming, state?.devices.length ?? 0));
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [modal, renaming, state?.devices.length]);

  useEffect(() => {
    saveSidebarPreferences({ autoCollapse: autoCollapseSidebar });
  }, [autoCollapseSidebar]);

  // The theme is a client-side preference: nothing about it reaches the host
  // or a paired phone, so each window follows the palette saved here. The
  // "system" choice tracks the OS setting live.
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
  }, [themePreference, resolvedTheme]);

  // Below the narrow threshold the project sidebar becomes an overlay drawer, so the
  // auto-collapse behavior is implicitly enabled there regardless of the saved
  // preference. This threshold must stay in sync with the CSS overlay breakpoint
  // in styles.css (NARROW_SIDEBAR_WIDTH).
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_SIDEBAR_WIDTH}px)`);
    const apply = () => setNarrowLayout(query.matches);
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  const autoCollapseEffective = effectiveAutoCollapse(autoCollapseSidebar, narrowLayout);

  // Entering the narrow layout implicitly enables auto-collapse; collapse an
  // already-open sidebar so the terminal instantly gets the space back and the
  // sidebar then behaves as the overlay drawer.
  useEffect(() => {
    setSidebarOpen((open) => sidebarOpenAfterNarrowLayout(open, narrowLayout));
  }, [narrowLayout]);

  useEffect(() => {
    if (!sidebarOpen || !autoCollapseEffective) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      const inside = sidebarRef.current?.contains(target) ?? false;
      const isProject = Boolean(target && inside && target.closest(".project-item"));
      const isToggle = Boolean(target?.closest(".title-action"));
      // The rename-project overlay belongs to the project sidebar flow, so
      // clicks on it must not count as outside the sidebar. The state check
      // covers normal clicks while the overlay is open; the DOM check covers
      // the click that closes the overlay, when the state update may not have
      // reached this listener yet (closest() still walks the detached form).
      const inProjectOverlay = modal === "rename" || Boolean(target?.closest(".rename-modal"));
      if (shouldCollapseSidebar(sidebarOpen, autoCollapseEffective, inside, isProject, isToggle, inProjectOverlay)) setSidebarOpen(false);
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [sidebarOpen, autoCollapseEffective, modal]);

  // The scheme pair is a host setting shared with the phone; which of the two
  // this window paints is decided by its own light/dark theme.
  const terminalTheme = normalizeTerminalThemeSettings(state?.terminalTheme);
  const terminalScheme = resolveTerminalScheme(
    resolvedTheme === "dark" ? terminalTheme.darkSchemeId : terminalTheme.lightSchemeId,
    resolvedTheme
  );

  const currentProject = state?.projects.find((project) => project.id === state.currentProjectId);
  const unorderedProjectSessions = useMemo(
    () => state?.sessions.filter((session) => session.projectId === state.currentProjectId) ?? [],
    [state]
  );
  const projectSessions = useMemo(() => {
    const positions = new Map(sessionOrder.map((id, index) => [id, index]));
    return [...unorderedProjectSessions].sort((left, right) =>
      (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }, [unorderedProjectSessions, sessionOrder]);
  const activeSession = projectSessions.find((session) => session.id === activeSessionId);
  const activeSplit = findSplitGroup(splitGroups, activeSessionId);
  // The terminals this window has on screen: both panes of a split, else the
  // active tab alone. A connected device viewing one of them shares it.
  const openSessionIds = activeSplit ? activeSplit.sessionIds : activeSessionId ? [activeSessionId] : [];
  const statusDevices = connectedDevices(state?.devices ?? [], openSessionIds);
  const splitBySession = useMemo(() => {
    const groups = new Map<string, SplitGroup>();
    for (const group of splitGroups) for (const sessionId of group.sessionIds) groups.set(sessionId, group);
    return groups;
  }, [splitGroups]);
  const renamingProject = state?.projects.find((project) => project.id === renamingProjectId);
  // Sidebar render list: live cards with leaving ghosts spliced back into the
  // slots their projects used to hold, so a removed card can play its leave
  // while the cards below slide up into the freed space.
  const projectList = useMemo(
    () => projectListEntries(state?.projects ?? [], leavingProjects),
    [state?.projects, leavingProjects]
  );

  useEffect(() => {
    if (!state) return;
    const ids = state.sessions.map((session) => session.id);
    const available = new Set(ids);
    setSessionOrder((current) => normalizeSplitOrder(
      [...current.filter((id) => available.has(id)), ...ids.filter((id) => !current.includes(id))],
      splitGroups
    ));
  }, [state?.sessions]);

  useEffect(() => {
    if (!state) return;
    setSplitGroups((current) => reconcileSplitGroups(current, state.sessions));
  }, [state?.sessions]);

  useEffect(() => {
    saveSplitPreferences({ groups: splitGroups, allowEdgeDrop: allowSplitEdgeDrop });
  }, [splitGroups, allowSplitEdgeDrop]);

  useEffect(() => {
    if (!splitMenu) return;
    const focusFrame = window.requestAnimationFrame(() => splitMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus());
    const closeMenu = (event: PointerEvent) => {
      if (!splitMenuRef.current?.contains(event.target as Node)) setSplitMenu(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSplitMenu(null);
    };
    window.addEventListener("pointerdown", closeMenu, true);
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", closeMenu, true);
      window.removeEventListener("keydown", handleKey, true);
    };
  }, [splitMenu]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !event.shiftKey || !event.altKey || event.ctrlKey || event.metaKey || !activeSessionId) return;
      event.preventDefault();
      const bounds = splitButtonRef.current?.getBoundingClientRect();
      const group = findSplitGroup(splitGroups, activeSessionId);
      setSplitMenu(group
        ? { kind: "manage", groupId: group.id, x: bounds?.left ?? window.innerWidth - 250, y: bounds?.bottom ?? 84 }
        : { kind: "picker", anchorId: activeSessionId, x: bounds?.left ?? window.innerWidth - 250, y: bounds?.bottom ?? 84 });
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeSessionId, splitGroups]);

  useLayoutEffect(() => {
    const previousPositions = pendingTabPositionsRef.current;
    if (!previousPositions) return;
    pendingTabPositionsRef.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [sessionId, previousLeft] of previousPositions) {
      const element = tabElementsRef.current.get(sessionId);
      if (!element) continue;
      const delta = previousLeft - element.getBoundingClientRect().left;
      if (Math.abs(delta) < 1) continue;
      element.animate(
        [{ transform: `translate3d(${delta}px,0,0)` }, { transform: "translate3d(0,0,0)" }],
        { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    }
  }, [sessionOrder, tabDrag]);

  // Per-project memory of the last selected terminal tab: switching to a
  // project (and back) restores the tab the user last looked at there
  // instead of defaulting to the last tab every time. Sessions are
  // in-memory PTYs, so the memory lives only in this window, where the
  // sessions live.
  const rememberedActiveByProjectRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!state) return;
    const remembered = rememberedActiveByProjectRef.current;
    pruneRememberedActiveSessions(remembered, state.projects.map((project) => project.id));
    const next = resolveProjectActiveSession({
      projectId: state.currentProjectId,
      activeSessionId,
      projectSessionIds: projectSessions.map((session) => session.id),
      rememberedByProject: remembered
    });
    if (next !== null) rememberProjectActiveSession(remembered, state.currentProjectId, next);
    if (next !== activeSessionId) setActiveSessionId(next);
  }, [state, projectSessions, activeSessionId]);

  async function showPairing() {
    setModal("pair");
    setQr("");
    setPairError("");
    try {
      const payload = await window.agentTerminal.startPairing();
      const svg = await QRCode.toString(encodePairingPayload(payload), {
        type: "svg",
        width: 320,
        margin: 4,
        // The compact payload leaves room for normal error correction while
        // preserving larger, cleaner modules on the physical display.
        errorCorrectionLevel: "M",
        color: { dark: "#0a1015", light: "#ffffff" }
      });
      // Keep the code vector-based so browser scaling cannot blur module
      // edges before the phone camera gets a chance to resolve them.
      setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    } catch (cause) {
      setPairError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function commitProjectSessionOrder(projectId: string, orderedProjectIds: string[]) {
    if (!state) return;
    const projectIds = new Set(state.sessions.filter((session) => session.projectId === projectId).map((session) => session.id));
    setSessionOrder((current) => {
      const allIds = state.sessions.map((session) => session.id);
      const available = new Set(allIds);
      const reconciled = [...current.filter((id) => available.has(id)), ...allIds.filter((id) => !current.includes(id))];
      let visibleIndex = 0;
      return reconciled.map((id) => projectIds.has(id) ? orderedProjectIds[visibleIndex++] ?? id : id);
    });
    void window.agentTerminal.reorderSessions(projectId, orderedProjectIds).catch(() => {
      void window.agentTerminal.getState().then((nextState) => {
        setState(nextState);
        setSessionOrder(nextState.sessions.map((session) => session.id));
      });
    });
  }

  function createSplit(anchorId: string, companionId: string, companionSide: "first" | "second" = "second", activateId = anchorId) {
    if (!state || anchorId === companionId || findSplitGroup(splitGroups, anchorId) || findSplitGroup(splitGroups, companionId)) return;
    const anchor = state.sessions.find((session) => session.id === anchorId);
    const companion = state.sessions.find((session) => session.id === companionId);
    if (!anchor || !companion || anchor.projectId !== companion.projectId) return;
    const firstId = companionSide === "first" ? companionId : anchorId;
    const secondId = companionSide === "first" ? anchorId : companionId;
    const group: SplitGroup = {
      id: crypto.randomUUID(),
      projectId: anchor.projectId,
      sessionIds: [firstId, secondId],
      layout: "side-by-side",
      ratio: 0.5
    };
    const orderedIds = state.sessions
      .filter((session) => session.projectId === anchor.projectId)
      .sort((left, right) => projectSessions.findIndex((session) => session.id === left.id) - projectSessions.findIndex((session) => session.id === right.id))
      .map((session) => session.id);
    const nextOrder = pairSessionsInOrder(orderedIds, anchorId, firstId, secondId);
    setSplitGroups((current) => [...current, group]);
    commitProjectSessionOrder(anchor.projectId, nextOrder);
    setActiveSessionId(activateId);
    setSplitMenu(null);
  }

  async function createTerminalInSplit(anchorId: string) {
    if (!state) return;
    const anchor = state.sessions.find((session) => session.id === anchorId);
    if (!anchor) return;
    const session = await window.agentTerminal.createSession(anchor.projectId);
    const nextState = await window.agentTerminal.getState();
    setState(nextState);
    const group: SplitGroup = {
      id: crypto.randomUUID(),
      projectId: anchor.projectId,
      sessionIds: [anchorId, session.id],
      layout: "side-by-side",
      ratio: 0.5
    };
    const order = pairSessionsInOrder(
      nextState.sessions.filter((item) => item.projectId === anchor.projectId).map((item) => item.id),
      anchorId,
      anchorId,
      session.id
    );
    setSplitGroups((current) => [...current, group]);
    const projectSessionIds = new Set(order);
    let projectIndex = 0;
    setSessionOrder(nextState.sessions.map((item) => projectSessionIds.has(item.id) ? order[projectIndex++]! : item.id));
    void window.agentTerminal.reorderSessions(anchor.projectId, order);
    setActiveSessionId(anchorId);
    setSplitMenu(null);
  }

  function separateSplit(groupId: string) {
    setSplitGroups((current) => current.filter((group) => group.id !== groupId));
    setSplitMenu(null);
  }

  function setSplitLayout(groupId: string, layout: SplitLayout) {
    setSplitGroups((current) => current.map((group) => group.id === groupId ? { ...group, layout } : group));
    setSplitMenu(null);
  }

  function swapSplit(groupId: string) {
    const group = splitGroups.find((item) => item.id === groupId);
    if (!group) return;
    const [firstId, secondId] = group.sessionIds;
    const nextGroups = splitGroups.map((item): SplitGroup => item.id === groupId ? { ...item, sessionIds: [secondId, firstId] } : item);
    setSplitGroups(nextGroups);
    const projectOrder = projectSessions.map((session) => session.id);
    const firstIndex = projectOrder.indexOf(firstId);
    const secondIndex = projectOrder.indexOf(secondId);
    if (firstIndex >= 0 && secondIndex >= 0) {
      projectOrder[firstIndex] = secondId;
      projectOrder[secondIndex] = firstId;
      commitProjectSessionOrder(group.projectId, projectOrder);
    }
    setSplitMenu(null);
  }

  function replaceSplitSession(groupId: string, outgoingId: string, incomingId: string) {
    const group = splitGroups.find((item) => item.id === groupId);
    const incoming = state?.sessions.find((session) => session.id === incomingId);
    if (!group || !incoming || incoming.projectId !== group.projectId || findSplitGroup(splitGroups, incomingId)) return;
    const nextSessionIds: [string, string] = group.sessionIds[0] === outgoingId
      ? [incomingId, group.sessionIds[1]]
      : [group.sessionIds[0], incomingId];
    setSplitGroups((current) => current.map((item) => item.id === groupId ? { ...item, sessionIds: nextSessionIds } : item));
    commitProjectSessionOrder(group.projectId, replaceSessionInOrder(projectSessions.map((session) => session.id), outgoingId, incomingId));
    if (activeSessionId === outgoingId) setActiveSessionId(incomingId);
    setSplitMenu(null);
  }

  function openSplitMenuForButton() {
    if (!activeSessionId) return;
    const bounds = splitButtonRef.current?.getBoundingClientRect();
    const x = bounds?.left ?? window.innerWidth - 250;
    const y = bounds?.bottom ?? 84;
    setSplitMenu(activeSplit
      ? { kind: "manage", groupId: activeSplit.id, x, y }
      : { kind: "picker", anchorId: activeSessionId, x, y });
  }

  function navigateSplitMenu(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)")];
    if (!items.length) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  async function addTab() {
    if (!state) return;
    const session = await window.agentTerminal.createSession(state.currentProjectId);
    setActiveSessionId(session.id);
  }

  async function closeTab(sessionId: string) {
    if (closingSessionIds.has(sessionId)) return;
    const index = projectSessions.findIndex((session) => session.id === sessionId);
    const split = findSplitGroup(splitGroups, sessionId);
    if (sessionId === activeSessionId) {
      const partnerId = split?.sessionIds.find((id) => id !== sessionId);
      setActiveSessionId(partnerId ?? projectSessions[index + 1]?.id ?? projectSessions[index - 1]?.id ?? null);
    }
    if (split) setSplitGroups((current) => current.filter((group) => group.id !== split.id));
    setSplitMenu(null);
    setClosingSessionIds((current) => new Set(current).add(sessionId));
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    try {
      await window.agentTerminal.closeSession(sessionId);
    } finally {
      setClosingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  function startRename(projectId: string) {
    const project = state?.projects.find((item) => item.id === projectId);
    if (!project) return;
    setRenamingProjectId(projectId);
    setProjectName(project.name);
    setRenameError("");
    setModal("rename");
  }

  async function renameProject() {
    if (!renamingProject || renaming) return;
    const name = projectName.trim();
    setRenaming(true);
    setRenameError("");
    try {
      await window.agentTerminal.renameProject(renamingProject.id, name);
      setModal(null);
      setRenamingProjectId(null);
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : "Could not rename the project.");
    } finally {
      setRenaming(false);
    }
  }

  function reorderSession(draggedId: string, targetId: string) {
    if (!state || draggedId === targetId) return;
    const orderedProjectIds = moveSessionBlock(projectSessions.map((session) => session.id), draggedId, targetId, splitGroups);
    if (orderedProjectIds.every((id, index) => id === projectSessions[index]?.id)) return;
    commitProjectSessionOrder(state.currentProjectId, orderedProjectIds);
  }

  function beginTabDrag(event: ReactPointerEvent<HTMLButtonElement>, sessionId: string, index: number) {
    if (event.button !== 0 || closingSessionIds.has(sessionId)) return;
    const centers = projectSessions.map((session) => {
      const bounds = tabElementsRef.current.get(session.id)?.getBoundingClientRect();
      return bounds ? bounds.left + bounds.width / 2 : 0;
    });
    if (centers.some((center) => center === 0)) return;
    const next: TabDragState = {
      sessionId,
      pointerId: event.pointerId,
      startX: event.clientX,
      deltaX: 0,
      startIndex: index,
      targetIndex: index,
      didMove: false,
      centers
    };
    suppressTabClickRef.current = false;
    tabDragRef.current = next;
    setTabDrag(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTabDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = tabDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - current.startX;
    const didMove = current.didMove || Math.abs(deltaX) > 4;
    const draggedCenter = current.centers[current.startIndex]! + deltaX;
    let targetIndex = current.startIndex;
    if (didMove) {
      let nearestDistance = Number.POSITIVE_INFINITY;
      current.centers.forEach((center, index) => {
        const distance = Math.abs(center - draggedCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          targetIndex = index;
        }
      });
      event.preventDefault();
    }
    let dropSide: SplitDropSide = null;
    const stackBounds = terminalStackRef.current?.getBoundingClientRect();
    const canSplit = allowSplitEdgeDrop
      && activeSessionId
      && activeSessionId !== current.sessionId
      && !findSplitGroup(splitGroups, activeSessionId)
      && !findSplitGroup(splitGroups, current.sessionId);
    if (canSplit && stackBounds && event.clientY >= stackBounds.top && event.clientY <= stackBounds.bottom) {
      const edgeWidth = Math.min(150, Math.max(72, stackBounds.width * 0.18));
      if (event.clientX <= stackBounds.left + edgeWidth) dropSide = "left";
      else if (event.clientX >= stackBounds.right - edgeWidth) dropSide = "right";
    }
    splitDropSideRef.current = dropSide;
    setSplitDropSide(dropSide);
    const next = { ...current, deltaX, didMove, targetIndex };
    tabDragRef.current = next;
    setTabDrag(next);
  }

  function finishTabDrag(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    const current = tabDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.didMove) {
      suppressTabClickRef.current = true;
      window.setTimeout(() => { suppressTabClickRef.current = false; }, 0);
      if (commit && splitDropSideRef.current && activeSessionId && activeSessionId !== current.sessionId) {
        createSplit(activeSessionId, current.sessionId, splitDropSideRef.current === "left" ? "first" : "second", current.sessionId);
      } else if (commit && current.targetIndex !== current.startIndex) {
        pendingTabPositionsRef.current = new Map(
          projectSessions.map((session) => [session.id, tabElementsRef.current.get(session.id)?.getBoundingClientRect().left ?? 0])
        );
        reorderSession(current.sessionId, projectSessions[current.targetIndex]!.id);
      }
    }
    tabDragRef.current = null;
    setTabDrag(null);
    splitDropSideRef.current = null;
    setSplitDropSide(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function tabDragTransform(sessionId: string, index: number): string | undefined {
    if (!tabDrag) return undefined;
    const draggedGroup = findSplitGroup(splitGroups, tabDrag.sessionId);
    if (sessionId === tabDrag.sessionId || draggedGroup?.sessionIds.includes(sessionId)) return `translate3d(${tabDrag.deltaX}px,0,0)`;
    if (tabDrag.startIndex < tabDrag.targetIndex && index > tabDrag.startIndex && index <= tabDrag.targetIndex) {
      return "translate3d(-100%,0,0)";
    }
    if (tabDrag.startIndex > tabDrag.targetIndex && index >= tabDrag.targetIndex && index < tabDrag.startIndex) {
      return "translate3d(100%,0,0)";
    }
    return undefined;
  }

  function beginProjectDrag(event: ReactPointerEvent<HTMLElement>, projectId: string, index: number) {
    if (event.button !== 0 || !state) return;
    const centers = state.projects.map((project) => {
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
    let targetIndex = current.startIndex;
    if (didMove) {
      targetIndex = current.centers.reduce((nearest, center, index) => Math.abs(center - draggedCenter) < Math.abs(current.centers[nearest]! - draggedCenter) ? index : nearest, current.startIndex);
      event.preventDefault();
    }
    const next = { ...current, deltaY, didMove, targetIndex };
    projectDragRef.current = next;
    setProjectDrag(next);
  }

  function finishProjectDrag(event: ReactPointerEvent<HTMLElement>, commit: boolean) {
    const current = projectDragRef.current;
    if (!current || current.pointerId !== event.pointerId || !state) return;
    if (shouldCommitProjectReorder({ commit, didMove: current.didMove, startIndex: current.startIndex, targetIndex: current.targetIndex })) {
      const projects = reorderBlock(state.projects, current.startIndex, current.targetIndex);
      const previous = state;
      setProjectReordering(true);
      setState({ ...state, projects });
      void window.agentTerminal.reorderProjects(projects.map((project) => project.id)).catch(() => {
        setState(previous);
        void window.agentTerminal.getState().then(setState);
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

  function beginSplitResize(event: ReactPointerEvent<HTMLDivElement>, groupId: string) {
    if (event.button !== 0) return;
    splitResizeRef.current = { groupId, pointerId: event.pointerId };
    setResizingSplitId(groupId);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function resizeSplit(event: ReactPointerEvent<HTMLDivElement>) {
    const current = splitResizeRef.current;
    const bounds = terminalStackRef.current?.getBoundingClientRect();
    const group = splitGroups.find((item) => item.id === current?.groupId);
    if (!current || current.pointerId !== event.pointerId || !bounds || !group) return;
    const dimension = group.layout === "side-by-side" ? bounds.width : bounds.height;
    const position = group.layout === "side-by-side" ? event.clientX - bounds.left : event.clientY - bounds.top;
    const minimum = dimension > 0 ? Math.min(0.42, Math.max(0.18, 180 / dimension)) : 0.18;
    const ratio = clampSplitRatio(position / dimension, minimum);
    setSplitGroups((groups) => groups.map((item) => item.id === group.id ? { ...item, ratio } : item));
    event.preventDefault();
  }

  function finishSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    const current = splitResizeRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    splitResizeRef.current = null;
    setResizingSplitId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeSplitWithKeyboard(groupId: string, event: ReactKeyboardEvent<HTMLDivElement>) {
    const group = splitGroups.find((item) => item.id === groupId);
    if (!group) return;
    const decreaseKey = group.layout === "side-by-side" ? "ArrowLeft" : "ArrowUp";
    const increaseKey = group.layout === "side-by-side" ? "ArrowRight" : "ArrowDown";
    let ratio: number | undefined;
    if (event.key === decreaseKey) ratio = clampSplitRatio(group.ratio - (event.shiftKey ? 0.1 : 0.025));
    if (event.key === increaseKey) ratio = clampSplitRatio(group.ratio + (event.shiftKey ? 0.1 : 0.025));
    if (event.key === "Home") ratio = 0.18;
    if (event.key === "End") ratio = 0.82;
    if (ratio === undefined) return;
    event.preventDefault();
    setSplitGroups((groups) => groups.map((item) => item.id === groupId ? { ...item, ratio: ratio! } : item));
  }

  async function selectShell(shellId: string) {
    const outgoingId = activeSessionId;
    const replacement = await window.agentTerminal.selectShell(outgoingId, shellId);
    if (!replacement) return;
    setActiveSessionId(replacement.id);
    if (!outgoingId) return;
    const nextState = await window.agentTerminal.getState();
    // The host keeps the outgoing tab when it has output yet and closes it
    // otherwise; see shell-switch.ts for what each outcome means for the
    // tab order and the split groups.
    const outgoingRetained = nextState.sessions.some((session) => session.id === outgoingId);
    setSessionOrder((current) => shellSwitchSessionOrder(current, outgoingId, replacement.id, outgoingRetained));
    setSplitGroups((current) => shellSwitchSplitGroups(current, outgoingId, replacement.id, outgoingRetained));
  }

  async function toggleProjectPersistence(projectId: string) {
    const project = state?.projects.find((item) => item.id === projectId);
    if (!project) return;
    await window.agentTerminal.setProjectPersistent(projectId, projectPersistenceAction(project.persistent).nextPersistent);
  }

  if (!state) return <div className="boot"><TerminalIcon/><span>Starting Agent Terminal…</span></div>;

  const remoteLabel = state.remoteRegistration.status === "enrolled"
    ? "Remote access ready"
    : state.remoteRegistration.status === "pending"
      ? "Registering remote access"
      : state.remoteRegistration.status === "failed"
        ? "Remote registration failed"
        : state.remoteRegistration.status === "offline"
          ? "No internet"
          : state.remoteRegistration.status === "unpaired"
            ? "Pair a device"
            : "LAN access ready";
  const menuGroup = splitMenu && (splitMenu.kind === "manage"
    ? splitGroups.find((group) => group.id === splitMenu.groupId)
    : splitMenu.kind === "tab"
      ? findSplitGroup(splitGroups, splitMenu.sessionId)
      : findSplitGroup(splitGroups, splitMenu.anchorId));
  const pickerCandidates = splitMenu?.kind === "picker"
    ? projectSessions.filter((session) => session.id !== splitMenu.anchorId && !findSplitGroup(splitGroups, session.id))
    : [];
  const splitHitboxVisible = isSplitEdgeHintVisible({
    dragging: tabDrag ? { sessionId: tabDrag.sessionId, didMove: tabDrag.didMove } : null,
    activeSessionId,
    allowEdgeDrop: allowSplitEdgeDrop,
    groups: splitGroups,
    dropSide: splitDropSide
  });

  return (
    <main className="app-shell">
      <header className="titlebar">
        <button className="icon-button title-action" onClick={() => setSidebarOpen((value) => !value)} aria-label="Toggle project sidebar"><MenuIcon /></button>
        <div className="brand-mark"><TerminalIcon /></div>
        <div className="window-title">
          <strong className="display-name" title={currentProject?.name ?? "Agent Terminal"}>{currentProject?.name ?? "Agent Terminal"}</strong>
          <span>{currentProject?.path}</span>
        </div>
        <div className="titlebar-actions">
          <span className={`host-online is-${state.remoteRegistration.status}`}><i /> {remoteLabel}</span>
          {state.remoteRegistration.status === "failed" && <span className="remote-registration-inline" role="status">
            <span>{state.remoteRegistration.error ?? "LAN access is still available."}</span>
            <button onClick={() => void window.agentTerminal.retryRemoteRegistration()}>Retry</button>
          </span>}
          {currentProject && (() => { const action = projectPersistenceAction(currentProject.persistent); return <button className={`project-persistence-action ${currentProject.persistent ? "is-saved" : ""}`} onClick={() => void toggleProjectPersistence(currentProject.id)} title={action.tooltip}>{currentProject.persistent ? <BookmarkIcon /> : <ClockIcon />}<span>{action.shortLabel}</span></button>; })()}
          <button className="icon-button" onClick={() => setModal(deviceListEntryModal(state.devices.length))} title="Connected devices"><PhoneIcon /></button>
          <button className="icon-button" onClick={() => setModal("settings")} title="Settings"><SettingsIcon /></button>
        </div>
      </header>

      <div className="workspace">
        <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? "" : "is-collapsed"}`}>
          <div className="sidebar-heading"><span>Projects</span><button className="icon-button small" onClick={() => void window.agentTerminal.createProject()} title="Add project"><PlusIcon /></button></div>
          <nav className="project-list">
            {projectList.map((entry) => {
              if (entry.kind === "leaving") {
                // The ghost card playing its leave: it slides off the left
                // edge first, then its slot collapses. Not interactive, and
                // App unmounts it once the animation completes.
                const count = entry.entry.count;
                return <div key={`leaving-${entry.entry.project.id}`} className="project-item is-leaving" aria-hidden="true">
                  <span className="project-icon"><FolderIcon /></span>
                  <span className="project-copy"><strong className="display-name">{entry.entry.project.name}</strong><small>{count ? `${count} active session${count === 1 ? "" : "s"}` : "No active sessions"}</small></span>
                </div>;
              }
              const project = entry.project;
              const index = entry.index;
              const count = state.sessions.filter((session) => session.projectId === project.id && session.status === "running").length;
              const action = projectPersistenceAction(project.persistent);
              return <div key={project.id} ref={(element) => { if (element) projectElementsRef.current.set(project.id, element); else projectElementsRef.current.delete(project.id); }} role="button" tabIndex={0} className={`project-item ${project.id === state.currentProjectId ? "active" : ""} ${project.id === projectDrag?.projectId ? "is-dragging" : ""} ${projectReordering ? "is-reordering" : ""}`} style={{ transform: projectDragTransform(projectDrag, project.id, index) }} onClick={() => void window.agentTerminal.openProject(project.id)} onKeyDown={(event) => { if (projectRowOpensOnKey(event.target, event.currentTarget, event.key)) void window.agentTerminal.openProject(project.id); }}>
                <span className="project-icon"><FolderIcon /></span>
                <span className="project-copy"><strong className="display-name" title={project.name}>{project.name}</strong><small>{count ? `${count} active session${count === 1 ? "" : "s"}` : "No active sessions"}</small></span>
                <span className="project-item-actions"><span className="project-drag-handle" role="button" aria-label={`Reorder ${project.name}`} title="Drag to reorder" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => beginProjectDrag(event, project.id, index)} onPointerMove={moveProjectDrag} onPointerUp={(event) => finishProjectDrag(event, true)} onPointerCancel={(event) => finishProjectDrag(event, false)}>⠿</span><button className="persistence" onClick={(event) => { event.stopPropagation(); void toggleProjectPersistence(project.id); }} title={action.tooltip} aria-label={action.tooltip}>{project.persistent ? <BookmarkIcon /> : <ClockIcon />}</button><button className="project-rename" onClick={(event) => { event.stopPropagation(); startRename(project.id); }} title={`Rename ${project.name}`} aria-label={`Rename ${project.name}`}><EditIcon /></button></span>
              </div>;
            })}
          </nav>
          <button className="new-project" onClick={() => void window.agentTerminal.createProject()}><PlusIcon /> Add project folder</button>
          <div className="sidebar-footer"><WifiIcon /><span><strong>{state.host.name}</strong><small>Port 47831</small></span></div>
        </aside>

        <section className="terminal-workspace">
          <div className="tabbar">
            <div className="tabs" role="tablist" aria-label="Terminal tabs">
              {projectSessions.map((session, index) => {
                const sessionSplit = splitBySession.get(session.id);
                const splitIndex = sessionSplit?.sessionIds.indexOf(session.id) ?? -1;
                const selectedSplit = activeSplit?.id === sessionSplit?.id;
                const draggedSplit = findSplitGroup(splitGroups, tabDrag?.sessionId);
                const isDragging = tabDrag?.sessionId === session.id || draggedSplit?.sessionIds.includes(session.id);
                return <button key={session.id} ref={(element) => { if (element) tabElementsRef.current.set(session.id, element); else tabElementsRef.current.delete(session.id); }} role="tab" aria-selected={session.id === activeSessionId} className={`terminal-tab ${session.id === activeSessionId ? "active" : ""} ${selectedSplit ? "is-split-selected" : ""} ${sessionSplit ? "is-split" : ""} ${splitIndex === 0 ? "split-first" : splitIndex === 1 ? "split-second" : ""} ${isDragging ? "is-dragging" : ""} ${closingSessionIds.has(session.id) ? "is-closing" : ""}`} style={{ transform: tabDragTransform(session.id, index) }} onClick={() => { if (!suppressTabClickRef.current) setActiveSessionId(session.id); }} onContextMenu={(event) => { event.preventDefault(); setSplitMenu({ kind: "tab", sessionId: session.id, x: event.clientX, y: event.clientY }); }} onPointerDown={(event) => beginTabDrag(event, session.id, index)} onPointerMove={moveTabDrag} onPointerUp={(event) => finishTabDrag(event, true)} onPointerCancel={(event) => finishTabDrag(event, false)}>
                  <TerminalIcon /><span className="terminal-tab-label display-name" title={session.title}>{session.title}</span>{session.status === "exited" && <i className="exit-dot" title={`Exited (${session.exitCode ?? "unknown"})`} />}
                  <span className="tab-close" role="button" aria-label={`Close ${session.title}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void closeTab(session.id); }}><CloseIcon /></span>
                </button>;
              })}
              <button className="add-tab" onClick={() => void addTab()} title="New terminal tab"><PlusIcon /></button>
            </div>
            <button ref={splitButtonRef} className={`split-toolbar-button ${activeSplit ? "is-active" : ""}`} disabled={!activeSessionId} onClick={openSplitMenuForButton} title={activeSplit ? "Manage split view (Shift+Alt+N)" : "New split view (Shift+Alt+N)"} aria-label={activeSplit ? "Manage split view" : "New split view"}><SplitViewIcon /></button>
            <select className="shell-picker" value={activeSession?.shellId ?? state.defaultShellId} onChange={(event) => void selectShell(event.target.value)} title="Terminal shell">
              {state.shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.name}</option>)}
            </select>
          </div>
          <div ref={terminalStackRef} className={`terminal-stack ${resizingSplitId ? "is-resizing" : ""}`}>
            {projectSessions.map((session) => {
              const splitIndex = activeSplit?.sessionIds.indexOf(session.id) ?? -1;
              const visible = activeSplit ? splitIndex >= 0 : session.id === activeSessionId;
              const paneActive = visible && session.id === activeSessionId;
              let surfaceStyle: CSSProperties | undefined;
              if (activeSplit && splitIndex >= 0) {
                const percentage = activeSplit.ratio * 100;
                if (activeSplit.layout === "side-by-side") {
                  surfaceStyle = splitIndex === 0
                    ? { left: 0, right: `${100 - percentage}%`, top: 0, bottom: 0 }
                    : { left: `${percentage}%`, right: 0, top: 0, bottom: 0 };
                } else {
                  surfaceStyle = splitIndex === 0
                    ? { left: 0, right: 0, top: 0, bottom: `${100 - percentage}%` }
                    : { left: 0, right: 0, top: `${percentage}%`, bottom: 0 };
                }
              }
              return <div key={session.id} className={`terminal-surface ${visible ? "is-visible" : ""} ${paneActive ? "is-active" : "is-inactive"} ${activeSplit ? `is-split ${activeSplit.layout}` : ""}`} style={surfaceStyle} onPointerDown={() => { if (visible && !paneActive) setActiveSessionId(session.id); }}>
                <TerminalPane sessionId={session.id} visible={visible} active={paneActive} confirmExternalLinks={state.confirmExternalLinks} scheme={terminalScheme} />
                {visible && activeSplit && !paneActive && <div className="split-mini-toolbar" onPointerDown={(event) => event.stopPropagation()}>
                  <TerminalIcon /><span className="display-name" title={session.title}>{session.title}</span>
                  <button title="Manage split view" aria-label="Manage split view" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setSplitMenu({ kind: "manage", groupId: activeSplit.id, x: bounds.right, y: bounds.top }); }}><MoreIcon /></button>
                  <button title={`Close ${session.title}`} aria-label={`Close ${session.title}`} onClick={() => void closeTab(session.id)}><CloseIcon /></button>
                </div>}
              </div>;
            })}
            {activeSplit && <div role="separator" tabIndex={0} aria-label="Resize split view" aria-orientation={activeSplit.layout === "side-by-side" ? "vertical" : "horizontal"} aria-valuemin={18} aria-valuemax={82} aria-valuenow={Math.round(activeSplit.ratio * 100)} className={`split-divider ${activeSplit.layout}`} style={activeSplit.layout === "side-by-side" ? { left: `calc(${activeSplit.ratio * 100}% - 4px)` } : { top: `calc(${activeSplit.ratio * 100}% - 4px)` }} onPointerDown={(event) => beginSplitResize(event, activeSplit.id)} onPointerMove={resizeSplit} onPointerUp={finishSplitResize} onPointerCancel={finishSplitResize} onDoubleClick={() => setSplitGroups((groups) => groups.map((group) => group.id === activeSplit.id ? { ...group, ratio: 0.5 } : group))} onKeyDown={(event) => resizeSplitWithKeyboard(activeSplit.id, event)}><i /></div>}
            {splitHitboxVisible && <div className="split-hitbox is-left" aria-hidden="true" />}
            {splitHitboxVisible && <div className="split-hitbox is-right" aria-hidden="true" />}
            {splitDropSide && <div className={`split-drop-target is-${splitDropSide}`}><span><SplitViewIcon /> Drop to split {splitDropSide}</span></div>}
            {!projectSessions.length && <div className="empty-terminal"><TerminalIcon /><h2>No open terminals</h2><p className="display-name" title={`Start a session in ${currentProject?.name}.`}>Start a session in {currentProject?.name}.</p><button className="primary" onClick={() => void addTab()}><PlusIcon /> New terminal</button></div>}
          </div>
          <footer className="statusbar">
            <span className="statusbar-location">
              <span className="statusbar-devices">{statusDevices.length
                ? <>{statusDevices.map((device, index) => <span className="statusbar-device" key={device.id} title={device.sharesTerminal ? `${device.name} has this terminal open` : `${device.name} is connected`}><i className={`device-dot ${device.sharesTerminal ? "is-shared" : ""}`} /><span className="display-name">{device.name}{index < statusDevices.length - 1 ? "," : ""}</span></span>)}<span>connected</span></>
                : NO_DEVICES_LABEL}</span>
            </span>
            <span>UTF-8</span>
          </footer>
        </section>
      </div>

      {splitMenu && <div ref={splitMenuRef} className="split-menu" role="menu" style={{ left: Math.max(8, Math.min(splitMenu.x, window.innerWidth - 276)), top: Math.max(50, Math.min(splitMenu.y, window.innerHeight - 420)) }} onPointerDown={(event) => event.stopPropagation()} onKeyDown={navigateSplitMenu}>
        {splitMenu.kind === "picker" && <>
          <div className="split-menu-heading"><SplitViewIcon /><span><strong>{splitMenu.replaceId ? "Replace split pane" : "Add to split view"}</strong><small>{splitMenu.replaceId ? "Choose another terminal" : "Choose a terminal to show alongside this one"}</small></span></div>
          <div className="split-menu-list">
            {pickerCandidates.map((session) => <button key={session.id} role="menuitem" onClick={() => {
              if (splitMenu.replaceId && menuGroup) replaceSplitSession(menuGroup.id, splitMenu.replaceId, session.id);
              else createSplit(splitMenu.anchorId, session.id);
            }}><TerminalIcon /><span className="display-name" title={session.title}>{session.title}</span></button>)}
            {!pickerCandidates.length && <div className="split-menu-empty">No other unsplit terminal tabs</div>}
          </div>
          {!splitMenu.replaceId && <button className="split-menu-item" role="menuitem" onClick={() => void createTerminalInSplit(splitMenu.anchorId)}><PlusIcon /><span>New terminal</span></button>}
          <div className="split-menu-hint"><span>Shortcut</span><kbd>Shift</kbd><b>+</b><kbd>Alt</kbd><b>+</b><kbd>N</kbd></div>
        </>}

        {splitMenu.kind === "manage" && menuGroup && <>
          <div className="split-menu-heading"><SplitViewIcon /><span><strong>Split view</strong><small>{menuGroup.layout === "side-by-side" ? "Side by side" : "Stacked"} · {Math.round(menuGroup.ratio * 100)} / {Math.round((1 - menuGroup.ratio) * 100)}</small></span></div>
          <button className="split-menu-item" role="menuitem" onClick={() => setSplitLayout(menuGroup.id, menuGroup.layout === "side-by-side" ? "stacked" : "side-by-side")}>{menuGroup.layout === "side-by-side" ? <StackedIcon /> : <SideBySideIcon />}<span>{menuGroup.layout === "side-by-side" ? "Stacked layout" : "Side-by-side layout"}</span></button>
          <button className="split-menu-item" role="menuitem" onClick={() => swapSplit(menuGroup.id)}><SwapIcon /><span>Reverse positions</span></button>
          <button className="split-menu-item" role="menuitem" onClick={() => { const replaceId = menuGroup.sessionIds.includes(activeSessionId ?? "") ? activeSessionId! : menuGroup.sessionIds[0]; setSplitMenu({ kind: "picker", anchorId: replaceId, replaceId, x: splitMenu.x, y: splitMenu.y }); }}><TerminalIcon /><span>Replace active pane</span></button>
          <button className="split-menu-item" role="menuitem" onClick={() => separateSplit(menuGroup.id)}><SeparateIcon /><span>Separate split view</span></button>
          <div className="split-menu-separator" />
          {menuGroup.sessionIds.map((sessionId, index) => {
            const session = projectSessions.find((item) => item.id === sessionId);
            const position = menuGroup.layout === "side-by-side" ? (index === 0 ? "left" : "right") : (index === 0 ? "top" : "bottom");
            return <button key={sessionId} className="split-menu-item is-danger" role="menuitem" onClick={() => void closeTab(sessionId)}><CloseIcon /><span className="display-name" title={session?.title}>Close {position} pane{session ? ` · ${session.title}` : ""}</span></button>;
          })}
        </>}

        {splitMenu.kind === "tab" && <>
          <div className="split-menu-heading compact"><TerminalIcon /><span><strong className="display-name" title={projectSessions.find((session) => session.id === splitMenu.sessionId)?.title}>{projectSessions.find((session) => session.id === splitMenu.sessionId)?.title ?? "Terminal tab"}</strong></span></div>
          {menuGroup ? <>
            <button className="split-menu-item" role="menuitem" onClick={() => setSplitMenu({ kind: "manage", groupId: menuGroup.id, x: splitMenu.x, y: splitMenu.y })}><SplitViewIcon /><span>Manage split view</span></button>
            <button className="split-menu-item" role="menuitem" onClick={() => separateSplit(menuGroup.id)}><SeparateIcon /><span>Separate split view</span></button>
          </> : <>
            {activeSessionId && activeSessionId !== splitMenu.sessionId && !activeSplit && <button className="split-menu-item" role="menuitem" onClick={() => createSplit(activeSessionId, splitMenu.sessionId)}><SplitViewIcon /><span>New split view with current tab</span></button>}
            <button className="split-menu-item" role="menuitem" onClick={() => setSplitMenu({ kind: "picker", anchorId: splitMenu.sessionId, x: splitMenu.x, y: splitMenu.y })}><SplitViewIcon /><span>Add tab to new split view</span></button>
          </>}
          <div className="split-menu-separator" />
          <button className="split-menu-item is-danger" role="menuitem" onClick={() => void closeTab(splitMenu.sessionId)}><CloseIcon /><span>Close tab</span></button>
        </>}
      </div>}

      {modal === "pair" && <div className="modal-backdrop" onMouseDown={() => setModal(pairModalEscapeTarget(state.devices.length))}><section className="modal pair-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close icon-button" onClick={() => setModal(pairModalEscapeTarget(state.devices.length))}><CloseIcon /></button>
        <div className="modal-kicker"><PhoneIcon /> Connect your phone</div>
        <h1>Pair once. Reconnect anytime.</h1>
        <p>Scan this QR once to add your phone as an authorized device. It stays paired across every network until you revoke it in Devices. Note: Both devices must be connected to the same Wi-Fi network for the initial setup.</p>
        <div className={`qr-frame ${pairError ? "has-error" : ""}`}>{qr ? <img src={qr} alt="Mobile pairing QR" /> : pairError ? <div className="pair-error">{pairError}</div> : <div className="qr-loading">Preparing secure pairing…</div>}</div>
        <div className="pair-details"><span><i /> This phone stays authorized</span><span>Reconnect from anywhere</span></div>
      </section></div>}

      {modal === "settings" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close icon-button" onClick={() => setModal(null)}><CloseIcon /></button>
        <div className="modal-kicker"><SettingsIcon /> Settings</div>
        <h1>Desktop host</h1>
        <div className="settings-group">
          <div className="settings-row"><span><strong>Appearance</strong></span><div className="theme-choice" role="group" aria-label="Appearance">{THEME_PREFERENCES.map((preference) => <button key={preference} type="button" aria-pressed={themePreference === preference} onClick={() => setThemePreference(preference)}>{THEME_LABELS[preference]}</button>)}</div></div>
          <div className="settings-row"><span><strong>Terminal colors · Dark{resolvedTheme === "dark" && <i className="active-dot" title="Painting this window now" />}</strong></span><select value={terminalTheme.darkSchemeId} onChange={(event) => void window.agentTerminal.setTerminalTheme(event.target.value, terminalTheme.lightSchemeId)}>{terminalSchemesFor("dark").map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></div>
          <div className="settings-row"><span><strong>Terminal colors · Light{resolvedTheme === "light" && <i className="active-dot" title="Painting this window now" />}</strong></span><select value={terminalTheme.lightSchemeId} onChange={(event) => void window.agentTerminal.setTerminalTheme(terminalTheme.darkSchemeId, event.target.value)}>{terminalSchemesFor("light").map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></div>
        </div>
        <div className="settings-row"><span><strong>Default terminal</strong></span><select value={state.defaultShellId} onChange={(event) => void selectShell(event.target.value)}>{state.shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.name}</option>)}</select></div>
        <label className="settings-row settings-toggle"><span><strong>Open each project in a new window</strong><small>Turn off to switch projects like tabs in this window</small></span><input type="checkbox" checked={state.openProjectsInNewWindows} onChange={(event) => void window.agentTerminal.setOpenProjectsInNewWindows(event.target.checked)} /><i /></label>
        <label className="settings-row settings-toggle"><span><strong>Move tabs to the matching project</strong><small>Turn off to keep a terminal tab in its current project even when the folder changes</small></span><input type="checkbox" checked={state.followWorkingDirectory} onChange={(event) => void window.agentTerminal.setFollowWorkingDirectory(event.target.checked)} /><i /></label>
        <label className="settings-row settings-toggle"><span><strong>Warn before opening external links</strong><small>Ask for confirmation before sending terminal links to your browser</small></span><input type="checkbox" checked={state.confirmExternalLinks} onChange={(event) => void window.agentTerminal.setConfirmExternalLinks(event.target.checked)} /><i /></label>
        <label className="settings-row settings-toggle"><span><strong>Drag tabs to split</strong><small>Drop a tab on the left or right edge of the terminal</small></span><input type="checkbox" checked={allowSplitEdgeDrop} onChange={(event) => setAllowSplitEdgeDrop(event.target.checked)} /><i /></label>
        <label className="settings-row settings-toggle"><span><strong>Auto collapse project sidebar</strong><small>Collapse the project list when you click elsewhere or open a project</small></span><input type="checkbox" checked={autoCollapseSidebar} onChange={(event) => { const next = event.target.checked; setAutoCollapseSidebar(next); setSidebarOpen((open) => sidebarOpenAfterAutoCollapseToggle(open, next)); }} /><i /></label>
      </section></div>}

      {modal === "devices" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal devices-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close icon-button" onClick={() => setModal(null)}><CloseIcon /></button>
        <div className="modal-kicker"><PhoneIcon /> Devices</div>
        <h1>Connected devices</h1>
        <p>Phones paired with this computer stay authorized until you revoke them. Pairing requires both devices on the same Wi-Fi network.</p>
        <div className="device-list">
          {state.devices.length ? state.devices.map((device) => <div className="device-row" key={device.id}><span className="device-avatar"><PhoneIcon /></span><span><strong className="device-name"><span className="display-name" title={device.name}>{device.name}</span><i className={`device-status ${device.online ? "is-online" : "is-offline"}`} title={device.online ? "Connected now" : "Not connected"} /></strong><small>{device.platform} · Last connected {new Date(device.lastSeenAt).toLocaleString()}</small></span><button className="danger-icon" title="Revoke device" onClick={() => void window.agentTerminal.revokeDevice(device.id)}><TrashIcon /></button></div>) : <div className="empty-devices">No mobile devices have been paired.</div>}
        </div>
        <button className="primary wide" onClick={() => void showPairing()}><PhoneIcon /> Pair new device</button>
      </section></div>}

      {modal === "rename" && renamingProject && <div className="modal-backdrop" onMouseDown={() => { if (!renaming) setModal(null); }}><form className="modal rename-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void renameProject(); }}>
        <button type="button" className="modal-close icon-button" disabled={renaming} onClick={() => setModal(null)}><CloseIcon /></button>
        <div className="modal-kicker"><EditIcon /> Project name</div>
        <h1>Rename project</h1>
        <p>The folder stays at {renamingProject.path}. Leave the name blank to use the folder name.</p>
        <label className="rename-field">Name<input autoFocus maxLength={MAX_PROJECT_NAME_LENGTH} value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
        {renameError && <div className="form-error">{renameError}</div>}
        <button className="primary wide" disabled={renaming} type="submit">{renaming ? "Renaming…" : "Save name"}</button>
      </form></div>}
    </main>
  );
}
