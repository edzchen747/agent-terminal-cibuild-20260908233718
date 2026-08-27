import { useEffect, useMemo, useRef, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint
} from "@capacitor/barcode-scanner";
import type { HostSnapshot, PairingPayload, Platform, Project, TerminalSession } from "@agentterminal/protocol";
import { createRequestId, parsePairingPayload } from "@agentterminal/protocol";
import { HostConnection } from "./connection";
import { BackIcon, BookmarkIcon, ChevronIcon, ClockIcon, CloseIcon, FolderIcon, MoreIcon, PlusIcon, ScanIcon, TerminalIcon, WifiIcon } from "./icons";
import { MobileTerminal } from "./MobileTerminal";

type View = { type: "home" } | { type: "project"; projectId: string } | { type: "terminal"; sessionId: string; projectId: string };

export function App() {
  const [connection, setConnection] = useState<HostConnection | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "pairing" | "connecting" | "connected" | "error">("loading");
  const [error, setError] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [view, setView] = useState<View>({ type: "home" });
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [sessionToClose, setSessionToClose] = useState<TerminalSession | null>(null);
  const navigationRef = useRef({ view, status, showCreateProject, sessionToClose });
  navigationRef.current = { view, status, showCreateProject, sessionToClose };

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    const listener = CapacitorApp.addListener("backButton", () => {
      const navigation = navigationRef.current;
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
      void CapacitorApp.exitApp();
    });
    return () => { void listener.then((handle) => handle.remove()); };
  }, []);

  useEffect(() => {
    let current: HostConnection | null = null;
    void HostConnection.saved().then(async (host) => {
      if (!host) { setStatus("pairing"); return; }
      setStatus("connecting");
      current = new HostConnection(host);
      try {
        setSnapshot(await current.connect());
        setConnection(current);
        setStatus("connected");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not connect to the saved desktop.");
        setStatus("error");
      }
    });
    return () => current?.close();
  }, []);

  useEffect(() => {
    if (!connection) return;
    const offSnapshot = connection.on("snapshot", setSnapshot);
    const offDisconnect = connection.on("disconnected", () => { setError("The desktop connection was lost."); setStatus("error"); });
    return () => { offSnapshot(); offDisconnect(); };
  }, [connection]);

  async function pair(raw: string) {
    setStatus("connecting"); setError("");
    try {
      const payload: PairingPayload = parsePairingPayload(raw.trim());
      const platform = (Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web") as Platform;
      const next = await HostConnection.pair(payload, { id: crypto.randomUUID(), name: mobileName(), platform });
      connection?.close();
      setConnection(next); setSnapshot(next.snapshot ?? null); setStatus("connected"); setView({ type: "home" });
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
        cancelButtonAccessibilityLabel: "Cancel QR scan"
      });
      if (result.ScanResult) await pair(result.ScanResult);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The camera could not scan the code.");
    }
  }

  async function forgetHost() {
    connection?.close(); await HostConnection.forget();
    setConnection(null); setSnapshot(null); setError(""); setStatus("pairing"); setView({ type: "home" });
  }

  async function closeSession(session: TerminalSession) {
    if (!connection) return;
    await connection.request({ type: "session.close", requestId: createRequestId(), sessionId: session.id });
    setSessionToClose(null);
    setView({ type: "project", projectId: session.projectId });
  }

  if (status === "loading" || status === "connecting") return <Splash label={status === "loading" ? "Opening Agent Terminal" : "Connecting to desktop"} />;
  if (status === "pairing") return <PairScreen error={error} manualCode={manualCode} showManual={showManual} onManualCode={setManualCode} onShowManual={() => setShowManual(true)} onScan={() => void scan()} onPair={() => void pair(manualCode)} />;
  if (status === "error") return <ErrorScreen message={error} onRetry={() => window.location.reload()} onForget={() => void forgetHost()} />;
  if (!connection || !snapshot) return null;

  const activeProject = view.type === "project" ? snapshot.projects.find((item) => item.id === view.projectId) : undefined;
  const activeSession = view.type === "terminal" ? snapshot.sessions.find((item) => item.id === view.sessionId) : undefined;
  if (view.type === "terminal" && activeSession) {
    const project = snapshot.projects.find((item) => item.id === activeSession.projectId);
    return <div className="mobile-app terminal-view">
      <MobileHeader title={activeSession.title} subtitle={project?.name ?? activeSession.cwd} onBack={() => setView({ type: "project", projectId: activeSession.projectId })} trailing={<div className="session-actions"><span className={`session-state ${activeSession.status}`}>{activeSession.status}</span><button className="close-session-button" onClick={() => setSessionToClose(activeSession)} aria-label="Close terminal session" title="Close terminal session"><CloseIcon /></button></div>} />
      <MobileTerminal key={activeSession.id} connection={connection} session={activeSession} />
      {sessionToClose?.id === activeSession.id && <CloseSessionSheet session={activeSession} onClose={() => setSessionToClose(null)} onConfirm={() => closeSession(activeSession)} />}
    </div>;
  }
  if (view.type === "project" && activeProject) {
    return <ProjectScreen project={activeProject} snapshot={snapshot} connection={connection} onBack={() => setView({ type: "home" })} onOpen={(session) => setView({ type: "terminal", sessionId: session.id, projectId: session.projectId })} />;
  }
  return <div className="mobile-app home-view">
    <header className="home-header">
      <div><span className="eyebrow">Connected desktop</span><h1>{snapshot.host.name}</h1><span className="connection-label"><i /> Online · {snapshot.sessions.filter((s) => s.status === "running").length} sessions</span></div>
      <button className="round-button" onClick={() => void forgetHost()} title="Host options"><MoreIcon /></button>
    </header>
    <section className="home-content">
      <div className="section-title"><span>Projects</span><button onClick={() => setShowCreateProject(true)}><PlusIcon /> New</button></div>
      <div className="project-cards">
        {snapshot.projects.map((project) => <ProjectCard key={project.id} project={project} sessions={snapshot.sessions.filter((session) => session.projectId === project.id)} onClick={() => setView({ type: "project", projectId: project.id })} onSession={(session) => setView({ type: "terminal", sessionId: session.id, projectId: session.projectId })} />)}
      </div>
      {!snapshot.projects.length && <div className="mobile-empty"><FolderIcon /><h2>No projects yet</h2><p>Add a folder from your desktop to begin.</p></div>}
    </section>
    <nav className="bottom-nav"><button className="active"><FolderIcon /><span>Projects</span></button><button onClick={() => void scan()}><ScanIcon /><span>Pair</span></button><button onClick={() => void forgetHost()}><WifiIcon /><span>Host</span></button></nav>
    {showCreateProject && <CreateProjectSheet connection={connection} onClose={() => setShowCreateProject(false)} />}
  </div>;
}

function ProjectScreen({ project, snapshot, connection, onBack, onOpen }: { project: Project; snapshot: HostSnapshot; connection: HostConnection; onBack: () => void; onOpen: (session: TerminalSession) => void }) {
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
    <MobileHeader title={project.name} subtitle={project.path} onBack={onBack} trailing={project.persistent ? <BookmarkIcon className="saved-icon" /> : <ClockIcon className="temp-icon" />} />
    <section className="project-hero"><div className="large-folder"><FolderIcon /></div><span>{project.persistent ? "Saved project" : "Temporary project"}</span><h1>{project.name}</h1><p>{project.path}</p><div className="project-actions"><button className="mobile-primary" onClick={() => void createSession()}><PlusIcon /> New terminal</button><button className="mobile-secondary" disabled={changingPersistence} onClick={() => void togglePersistence()}>{project.persistent ? <ClockIcon /> : <BookmarkIcon />}{changingPersistence ? "Updating…" : project.persistent ? "Make temporary" : "Save project"}</button></div>{persistenceError && <div className="form-error project-error">{persistenceError}</div>}</section>
    <section className="session-section"><div className="section-title"><span>Sessions</span><small>{sessions.length}</small></div>
      {sessions.length ? <div className="session-list">{sessions.map((session, index) => <button key={session.id} onClick={() => onOpen(session)}><span className="session-icon"><TerminalIcon /></span><span><strong>{session.title} {index + 1}</strong><small>{session.status === "running" ? "Active now" : `Exited · ${session.exitCode ?? "—"}`}</small></span><i className={session.status} /><ChevronIcon /></button>)}</div> : <div className="inline-empty">No open terminal sessions.</div>}
    </section>
  </div>;
}

function ProjectCard({ project, sessions, onClick, onSession }: { project: Project; sessions: TerminalSession[]; onClick: () => void; onSession: (session: TerminalSession) => void }) {
  return <article className="project-card"><button className="project-card-main" onClick={onClick}><span className="card-folder"><FolderIcon /></span><span className="card-copy"><strong>{project.name}</strong><small>{project.path}</small></span><span className="card-persist">{project.persistent ? <BookmarkIcon /> : <ClockIcon />}</span><ChevronIcon /></button>
    {!!sessions.length && <div className="card-sessions">{sessions.slice(0, 3).map((session, index) => <button key={session.id} onClick={() => onSession(session)}><TerminalIcon /><span>{session.title} {index + 1}</span><i className={session.status} /></button>)}{sessions.length > 3 && <span className="more-sessions">+{sessions.length - 3}</span>}</div>}
  </article>;
}

function CreateProjectSheet({ connection, onClose }: { connection: HostConnection; onClose: () => void }) {
  const [name, setName] = useState(""); const [folderPath, setFolderPath] = useState(""); const [error, setError] = useState("");
  async function submit() {
    if (!folderPath.trim()) { setError("Enter the full path of a folder on the desktop."); return; }
    try { await connection.request({ type: "project.create", requestId: createRequestId(), name: name.trim() || folderPath.split(/[\\/]/).filter(Boolean).at(-1) || "Project", path: folderPath.trim() }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the project."); }
  }
  return <div className="sheet-backdrop" onClick={onClose}><section className="bottom-sheet" onClick={(event) => event.stopPropagation()}><i className="sheet-handle" /><span className="eyebrow">Desktop project</span><h2>Add a project</h2><p>Projects point directly to an existing folder on {connection.host.name}.</p><label>Project name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="My project" /></label><label>Desktop folder path<input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="C:\Users\you\Projects\app" autoCapitalize="none" autoCorrect="off" /></label>{error && <div className="form-error">{error}</div>}<button className="mobile-primary full" onClick={() => void submit()}>Add project</button><button className="text-button" onClick={onClose}>Cancel</button></section></div>;
}

function CloseSessionSheet({ session, onClose, onConfirm }: { session: TerminalSession; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setClosing(true); setError("");
    try { await onConfirm(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not close the terminal session."); setClosing(false); }
  }
  return <div className="sheet-backdrop" onClick={closing ? undefined : onClose}><section className="bottom-sheet confirm-sheet" onClick={(event) => event.stopPropagation()}><i className="sheet-handle" /><span className="eyebrow">Close terminal</span><h2>End this session?</h2><p>This will terminate <strong>{session.title}</strong> and remove its tab from the desktop and phone.</p>{error && <div className="form-error">{error}</div>}<button className="danger-button" disabled={closing} onClick={() => void confirm()}>{closing ? "Closing…" : "Close terminal"}</button><button className="text-button" disabled={closing} onClick={onClose}>Cancel</button></section></div>;
}

function MobileHeader({ title, subtitle, onBack, trailing }: { title: string; subtitle: string; onBack: () => void; trailing?: React.ReactNode }) {
  return <header className="mobile-header"><button className="round-button" onClick={onBack}><BackIcon /></button><span><strong>{title}</strong><small>{subtitle}</small></span><div className="header-trailing">{trailing}</div></header>;
}

function PairScreen({ error, manualCode, showManual, onManualCode, onShowManual, onScan, onPair }: { error: string; manualCode: string; showManual: boolean; onManualCode: (value: string) => void; onShowManual: () => void; onScan: () => void; onPair: () => void }) {
  return <div className="onboarding"><div className="ambient one"/><div className="ambient two"/><div className="onboarding-top"><span className="logo"><TerminalIcon /></span><strong>Agent Terminal</strong></div><section className="pair-copy"><span className="eyebrow">Desktop, untethered</span><h1>Your Windows terminal.<br/><em>Now in your pocket.</em></h1><p>Scan once to authorize this phone. It stays paired until you remove it from the desktop.</p></section><div className="scan-illustration"><span className="scan-corner tl"/><span className="scan-corner tr"/><span className="scan-corner bl"/><span className="scan-corner br"/><div className="qr-art"><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><div className="scan-line"/></div>{error && <div className="pair-error">{error}</div>}<section className="pair-actions"><button className="scan-button" onClick={onScan}><ScanIcon /> Authorize this phone</button>{showManual ? <div className="manual-pair"><textarea value={manualCode} onChange={(event) => onManualCode(event.target.value)} placeholder="Paste setup QR data"/><button onClick={onPair}>Authorize</button></div> : <button className="manual-link" onClick={onShowManual}>Enter setup data manually</button>}<small>Future connections work automatically from any network.</small></section></div>;
}

function Splash({ label }: { label: string }) { return <div className="splash"><span className="logo large"><TerminalIcon /></span><strong>Agent Terminal</strong><small>{label}…</small><i className="loader" /></div>; }
function ErrorScreen({ message, onRetry, onForget }: { message: string; onRetry: () => void; onForget: () => void }) { return <div className="error-screen"><span className="offline-icon"><WifiIcon /></span><h1>Desktop unavailable</h1><p>{message}</p><button className="mobile-primary full" onClick={onRetry}>Try again</button><button className="text-button" onClick={onForget}>Pair a different desktop</button></div>; }
function mobileName() { const platform = Capacitor.getPlatform(); return platform === "android" ? "Android phone" : platform === "ios" ? "iPhone" : "Web client"; }
