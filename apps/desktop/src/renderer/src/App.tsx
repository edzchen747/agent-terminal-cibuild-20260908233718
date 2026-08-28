import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { encodePairingPayload } from "@agentterminal/protocol";
import type { DesktopState } from "../../shared/api";
import { BookmarkIcon, ClockIcon, CloseIcon, EditIcon, FolderIcon, MenuIcon, PhoneIcon, PlusIcon, SettingsIcon, TerminalIcon, TrashIcon, WifiIcon } from "./icons";
import { TerminalPane } from "./TerminalPane";

type Modal = "pair" | "settings" | "rename" | null;

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
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [closingSessionIds, setClosingSessionIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void window.agentTerminal.getState().then(setState);
    return window.agentTerminal.onState(setState);
  }, []);

  useEffect(() => window.agentTerminal.onPairingSucceeded(() => {
    setModal((current) => current === "pair" ? null : current);
    setQr("");
    setPairError("");
  }), []);

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
  const renamingProject = state?.projects.find((project) => project.id === renamingProjectId);

  useEffect(() => {
    if (!state) return;
    const ids = state.sessions.map((session) => session.id);
    const available = new Set(ids);
    setSessionOrder((current) => [...current.filter((id) => available.has(id)), ...ids.filter((id) => !current.includes(id))]);
  }, [state?.sessions]);

  useEffect(() => {
    if (!projectSessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(projectSessions.at(-1)?.id ?? null);
    }
  }, [projectSessions, activeSessionId]);

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

  async function addTab() {
    if (!state) return;
    const session = await window.agentTerminal.createSession(state.currentProjectId);
    setActiveSessionId(session.id);
  }

  async function closeTab(sessionId: string) {
    if (closingSessionIds.has(sessionId)) return;
    const index = projectSessions.findIndex((session) => session.id === sessionId);
    if (sessionId === activeSessionId) {
      setActiveSessionId(projectSessions[index + 1]?.id ?? projectSessions[index - 1]?.id ?? null);
    }
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
    if (!name) { setRenameError("Enter a project name."); return; }
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
    const projectIds = new Set(unorderedProjectSessions.map((session) => session.id));
    setSessionOrder((current) => {
      const allIds = state.sessions.map((session) => session.id);
      const available = new Set(allIds);
      const reconciled = [...current.filter((id) => available.has(id)), ...allIds.filter((id) => !current.includes(id))];
      const visible = reconciled.filter((id) => projectIds.has(id));
      const from = visible.indexOf(draggedId);
      const to = visible.indexOf(targetId);
      if (from < 0 || to < 0) return current;
      visible.splice(to, 0, ...visible.splice(from, 1));
      let visibleIndex = 0;
      return reconciled.map((id) => projectIds.has(id) ? visible[visibleIndex++]! : id);
    });
  }

  async function selectShell(shellId: string) {
    const replacement = await window.agentTerminal.selectShell(activeSessionId, shellId);
    if (replacement) setActiveSessionId(replacement.id);
  }

  async function toggleProjectPersistence() {
    if (!currentProject) return;
    await window.agentTerminal.setProjectPersistent(currentProject.id, !currentProject.persistent);
  }

  if (!state) return <div className="boot"><TerminalIcon/><span>Starting Agent Terminal…</span></div>;

  return (
    <main className="app-shell">
      <header className="titlebar">
        <button className="icon-button title-action" onClick={() => setSidebarOpen((value) => !value)} aria-label="Toggle project sidebar"><MenuIcon /></button>
        <div className="brand-mark"><TerminalIcon /></div>
        <div className="window-title">
          <strong>{currentProject?.name ?? "Agent Terminal"}</strong>
          <span>{currentProject?.path}</span>
        </div>
        <div className="titlebar-actions">
          <span className="host-online"><i /> Remote host online</span>
          {currentProject && <button className={`project-persistence-action ${currentProject.persistent ? "is-saved" : ""}`} onClick={() => void toggleProjectPersistence()} title={currentProject.persistent ? "Stop saving this project" : "Save this temporary project"}>{currentProject.persistent ? <BookmarkIcon /> : <ClockIcon />}<span>{currentProject.persistent ? "Unsave" : "Save project"}</span></button>}
          <button className="icon-button" onClick={() => void showPairing()} title="Pair a mobile device"><PhoneIcon /></button>
          <button className="icon-button" onClick={() => setModal("settings")} title="Settings and devices"><SettingsIcon /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`sidebar ${sidebarOpen ? "" : "is-collapsed"}`}>
          <div className="sidebar-heading"><span>Projects</span><button className="icon-button small" onClick={() => void window.agentTerminal.createProject()} title="Add project"><PlusIcon /></button></div>
          <nav className="project-list">
            {state.projects.map((project) => {
              const count = state.sessions.filter((session) => session.projectId === project.id && session.status === "running").length;
              return <div key={project.id} role="button" tabIndex={0} className={`project-item ${project.id === state.currentProjectId ? "active" : ""}`} onClick={() => void window.agentTerminal.openProject(project.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void window.agentTerminal.openProject(project.id); }}>
                <span className="project-icon"><FolderIcon /></span>
                <span className="project-copy"><strong>{project.name}</strong><small>{count ? `${count} active session${count === 1 ? "" : "s"}` : "No active sessions"}</small></span>
                <span className="project-item-actions"><span className="persistence" title={project.persistent ? "Saved project" : "Temporary project"}>{project.persistent ? <BookmarkIcon /> : <ClockIcon />}</span><button className="project-rename" onClick={(event) => { event.stopPropagation(); startRename(project.id); }} title={`Rename ${project.name}`} aria-label={`Rename ${project.name}`}><EditIcon /></button></span>
              </div>;
            })}
          </nav>
          <button className="new-project" onClick={() => void window.agentTerminal.createProject()}><PlusIcon /> Add project folder</button>
          <div className="sidebar-footer"><WifiIcon /><span><strong>{state.host.name}</strong><small>Port 47831</small></span></div>
        </aside>

        <section className="terminal-workspace">
          <div className="tabbar">
            <div className="tabs">
              {projectSessions.map((session, index) => <button key={session.id} draggable={!closingSessionIds.has(session.id)} className={`terminal-tab ${session.id === activeSessionId ? "active" : ""} ${session.id === draggedSessionId ? "is-dragging" : ""} ${closingSessionIds.has(session.id) ? "is-closing" : ""}`} onClick={() => { if (!draggedSessionId) setActiveSessionId(session.id); }} onDragStart={(event) => { setDraggedSessionId(session.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", session.id); }} onDragEnter={(event) => { event.preventDefault(); if (draggedSessionId) reorderSession(draggedSessionId, session.id); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); setDraggedSessionId(null); }} onDragEnd={() => setDraggedSessionId(null)}>
                <TerminalIcon /><span>{session.title} {index + 1}</span>{session.status === "exited" && <i className="exit-dot" title={`Exited (${session.exitCode ?? "unknown"})`} />}
                <span className="tab-close" role="button" onClick={(event) => { event.stopPropagation(); void closeTab(session.id); }}><CloseIcon /></span>
              </button>)}
              <button className="add-tab" onClick={() => void addTab()} title="New terminal tab"><PlusIcon /></button>
            </div>
            <select className="shell-picker" value={activeSession?.shellId ?? state.defaultShellId} onChange={(event) => void selectShell(event.target.value)} title="Terminal shell">
              {state.shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.name}</option>)}
            </select>
          </div>
          <div className="terminal-stack">
            {projectSessions.map((session) => <TerminalPane key={session.id} sessionId={session.id} active={session.id === activeSessionId} />)}
            {!projectSessions.length && <div className="empty-terminal"><TerminalIcon /><h2>No open terminals</h2><p>Start a session in {currentProject?.name}.</p><button className="primary" onClick={() => void addTab()}><PlusIcon /> New terminal</button></div>}
          </div>
          <footer className="statusbar"><span><i className="status-dot" /> {projectSessions.filter((session) => session.status === "running").length} running</span><span>{currentProject?.path}</span><span>UTF-8</span></footer>
        </section>
      </div>

      {modal === "pair" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal pair-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close icon-button" onClick={() => setModal(null)}><CloseIcon /></button>
        <div className="modal-kicker"><PhoneIcon /> Connect your phone</div>
        <h1>Pair once. Reconnect anytime.</h1>
        <p>Scan this QR once to add your phone as an authorized device. It stays paired across every network until you revoke it in Settings.</p>
        <div className={`qr-frame ${pairError ? "has-error" : ""}`}>{qr ? <img src={qr} alt="Mobile pairing QR" /> : pairError ? <div className="pair-error">{pairError}</div> : <div className="qr-loading">Preparing secure pairing…</div>}</div>
        <div className="pair-details"><span><i /> This phone stays authorized</span><span>Reconnect from anywhere</span></div>
      </section></div>}

      {modal === "settings" && <div className="modal-backdrop" onMouseDown={() => setModal(null)}><section className="modal settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close icon-button" onClick={() => setModal(null)}><CloseIcon /></button>
        <div className="modal-kicker"><SettingsIcon /> Settings</div>
        <h1>Desktop host</h1>
        <div className="settings-row"><span><strong>Default terminal</strong><small>Used for new tabs and projects</small></span><select value={state.defaultShellId} onChange={(event) => void selectShell(event.target.value)}>{state.shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.name}</option>)}</select></div>
        <div className="section-label">Authorized devices</div>
        <div className="device-list">
          {state.devices.length ? state.devices.map((device) => <div className="device-row" key={device.id}><span className="device-avatar"><PhoneIcon /></span><span><strong>{device.name}</strong><small>{device.platform} · Last connected {new Date(device.lastSeenAt).toLocaleString()}</small></span><button className="danger-icon" title="Revoke device" onClick={() => void window.agentTerminal.revokeDevice(device.id)}><TrashIcon /></button></div>) : <div className="empty-devices">No mobile devices have been paired.</div>}
        </div>
        <button className="primary wide" onClick={() => void showPairing()}><PhoneIcon /> Pair another device</button>
      </section></div>}

      {modal === "rename" && renamingProject && <div className="modal-backdrop" onMouseDown={() => { if (!renaming) setModal(null); }}><form className="modal rename-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void renameProject(); }}>
        <button type="button" className="modal-close icon-button" disabled={renaming} onClick={() => setModal(null)}><CloseIcon /></button>
        <div className="modal-kicker"><EditIcon /> Project name</div>
        <h1>Rename project</h1>
        <p>The folder stays at {renamingProject.path}.</p>
        <label className="rename-field">Name<input autoFocus maxLength={100} value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label>
        {renameError && <div className="form-error">{renameError}</div>}
        <button className="primary wide" disabled={renaming} type="submit">{renaming ? "Renaming…" : "Save name"}</button>
      </form></div>}
    </main>
  );
}
