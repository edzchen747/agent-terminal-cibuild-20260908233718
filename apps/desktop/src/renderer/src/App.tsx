import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { DesktopState } from "../../shared/api";
import { BookmarkIcon, ClockIcon, CloseIcon, FolderIcon, MenuIcon, PhoneIcon, PlusIcon, SettingsIcon, TerminalIcon, TrashIcon, WifiIcon } from "./icons";
import { TerminalPane } from "./TerminalPane";

type Modal = "pair" | "settings" | null;

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [qr, setQr] = useState("");
  const [pairError, setPairError] = useState("");

  useEffect(() => {
    void window.agentTerminal.getState().then(setState);
    return window.agentTerminal.onState(setState);
  }, []);

  const currentProject = state?.projects.find((project) => project.id === state.currentProjectId);
  const projectSessions = useMemo(
    () => state?.sessions.filter((session) => session.projectId === state.currentProjectId) ?? [],
    [state]
  );

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
      setQr(await QRCode.toDataURL(JSON.stringify(payload), { width: 320, margin: 2, color: { dark: "#0a1015", light: "#ffffff" } }));
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
    await window.agentTerminal.closeSession(sessionId);
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
              return <button key={project.id} className={`project-item ${project.id === state.currentProjectId ? "active" : ""}`} onClick={() => void window.agentTerminal.openProject(project.id)}>
                <span className="project-icon"><FolderIcon /></span>
                <span className="project-copy"><strong>{project.name}</strong><small>{count ? `${count} active session${count === 1 ? "" : "s"}` : "No active sessions"}</small></span>
                <span className="persistence" title={project.persistent ? "Saved project" : "Temporary project"}>{project.persistent ? <BookmarkIcon /> : <ClockIcon />}</span>
              </button>;
            })}
          </nav>
          <button className="new-project" onClick={() => void window.agentTerminal.createProject()}><PlusIcon /> Add project folder</button>
          <div className="sidebar-footer"><WifiIcon /><span><strong>{state.host.name}</strong><small>Port 47831</small></span></div>
        </aside>

        <section className="terminal-workspace">
          <div className="tabbar">
            <div className="tabs">
              {projectSessions.map((session, index) => <button key={session.id} className={`terminal-tab ${session.id === activeSessionId ? "active" : ""}`} onClick={() => setActiveSessionId(session.id)}>
                <TerminalIcon /><span>{session.title} {index + 1}</span>{session.status === "exited" && <i className="exit-dot" title={`Exited (${session.exitCode ?? "unknown"})`} />}
                <span className="tab-close" role="button" onClick={(event) => { event.stopPropagation(); void closeTab(session.id); }}><CloseIcon /></span>
              </button>)}
              <button className="add-tab" onClick={() => void addTab()} title="New terminal tab"><PlusIcon /></button>
            </div>
            <select className="shell-picker" value={state.defaultShellId} onChange={(event) => void window.agentTerminal.setDefaultShell(event.target.value)} title="Default shell">
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
        <div className="settings-row"><span><strong>Default terminal</strong><small>Used for new tabs and projects</small></span><select value={state.defaultShellId} onChange={(event) => void window.agentTerminal.setDefaultShell(event.target.value)}>{state.shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.name}</option>)}</select></div>
        <div className="section-label">Authorized devices</div>
        <div className="device-list">
          {state.devices.length ? state.devices.map((device) => <div className="device-row" key={device.id}><span className="device-avatar"><PhoneIcon /></span><span><strong>{device.name}</strong><small>{device.platform} · Last connected {new Date(device.lastSeenAt).toLocaleString()}</small></span><button className="danger-icon" title="Revoke device" onClick={() => void window.agentTerminal.revokeDevice(device.id)}><TrashIcon /></button></div>) : <div className="empty-devices">No mobile devices have been paired.</div>}
        </div>
        <button className="primary wide" onClick={() => void showPairing()}><PhoneIcon /> Pair another device</button>
      </section></div>}
    </main>
  );
}
