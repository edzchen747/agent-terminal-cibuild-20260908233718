import { useState } from "react";
import {
  MAX_BRIDGE_LABEL_LENGTH,
  MAX_BRIDGE_PORT,
  MIN_BRIDGE_PORT,
  addBridge,
  bridgeDirectionLabel,
  bridgeDisplayName,
  bridgeStateLabel,
  bridgeWarningDetail,
  canAddBridgePort,
  duplicatePortIds,
  isValidBridgePort,
  normalizePortBridging,
  portBridgeStatusOf,
  removeBridge,
  sortedBridges,
  updateBridge,
  type AuthorizedDevice,
  type PortBridge,
  type PortBridgeServer,
  type PortBridgeStatus
} from "@agentterminal/protocol";
import { ChevronRightIcon, CloseIcon, PhoneIcon, PlusIcon, PortBridgeIcon, TrashIcon, WarningIcon } from "./icons.tsx";
import { devicesByLastConnected } from "./port-bridges.ts";

/**
 * The Port Bridge pages.
 *
 * The list page is the overview: a card per paired device, most recently
 * connected first, with whether bridging is on for it and what became of every
 * port it asked for. The per-device page is where those ports are configured.
 *
 * Both pages show the warning marker. A port can be perfectly configured and
 * still not bridged - another device claimed the number first, or nothing is
 * answering on it - and the page where the user would go to fix that is the
 * config page, so hiding it there only sends them back and forth.
 */

/**
 * The warning marker.
 *
 * Deliberately not a `title` attribute: the native tooltip needs an
 * uninterrupted hover over a 15px target and gives up constantly, which made
 * the explanation for an unbridged port effectively unreachable. This one is
 * CSS and appears on hover or keyboard focus.
 */
function BridgeWarning({ detail }: { detail: string }) {
  if (!detail) return null;
  return <span className="bridge-warning" tabIndex={0} role="note" aria-label={detail}>
    <WarningIcon />
    <span className="bridge-tip">{detail}</span>
  </span>;
}

interface SaveBridging {
  (deviceId: string, enabled: boolean, bridges: PortBridge[]): void;
}

interface ListProps {
  devices: AuthorizedDevice[];
  statuses: Record<string, PortBridgeStatus[]> | undefined;
  onClose: () => void;
  onOpenDevice: (deviceId: string) => void;
  onSave: SaveBridging;
}

export function PortBridgeListPage({ devices, statuses, onClose, onOpenDevice, onSave }: ListProps) {
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal bridges-modal" onMouseDown={(event) => event.stopPropagation()}>
    <button className="modal-close icon-button" onClick={onClose}><CloseIcon /></button>
    <div className="modal-kicker"><PortBridgeIcon /> Port bridges</div>
    <h1>Port bridges</h1>
    <p>Reach a service running on a paired device from this PC, or one running here from the device. Each bridge is set up when the device connects and torn down when it disconnects.</p>
    <div className="bridge-devices">
      {devices.length ? devicesByLastConnected(devices).map((device) => {
        const bridging = normalizePortBridging(device.portBridging);
        const bridges = sortedBridges(bridging.bridges);
        return <article className="bridge-device" key={device.id}>
          <header>
            <span className="device-avatar"><PhoneIcon /></span>
            <span className="bridge-device-copy">
              <strong className="device-name">
                <span className="display-name" title={device.name}>{device.name}</span>
                <i className={`device-status ${device.online ? "is-online" : "is-offline"}`} title={device.online ? "Connected now" : "Not connected"} />
              </strong>
              <small>{bridges.length ? `${bridges.length} port${bridges.length === 1 ? "" : "s"} configured` : "No ports configured"}</small>
            </span>
            <label className="bridge-switch" title={bridging.enabled ? "Turn port bridging off for this device" : "Turn port bridging on for this device"}>
              <input
                type="checkbox"
                checked={bridging.enabled}
                onChange={(event) => onSave(device.id, event.target.checked, bridging.bridges)}
              />
              <i />
            </label>
          </header>
          <div className="bridge-rows">
            {bridges.length ? bridges.map((bridge) => {
              const status = portBridgeStatusOf(statuses, device.id, bridge.id);
              const state = bridging.enabled ? status?.state ?? "pending" : "disabled";
              return <div className="bridge-row" key={bridge.id}>
                <strong>{bridgeDisplayName(bridge)}</strong>
                <small>{bridge.label ? `${bridge.port} · ` : ""}{bridgeDirectionLabel(bridge, "desktop")}</small>
                <span className={`bridge-state is-${state}`}>{bridgeStateLabel(state)}</span>
                <BridgeWarning detail={bridging.enabled ? bridgeWarningDetail(bridge, status) : ""} />
              </div>;
            }) : <div className="bridge-empty">No ports yet.</div>}
          </div>
          <button className="bridge-configure" onClick={() => onOpenDevice(device.id)}>
            Configure ports <ChevronRightIcon />
          </button>
        </article>;
      }) : <div className="empty-devices">No mobile devices have been paired.</div>}
    </div>
  </section></div>;
}

/** A row the user is still filling in. It is not saved until its port is
 * valid and free, so a half-typed port never reaches the host. */
interface DraftBridge {
  port: string;
  server: PortBridgeServer;
  label: string;
}

interface DeviceProps {
  device: AuthorizedDevice;
  statuses: Record<string, PortBridgeStatus[]> | undefined;
  onBack: () => void;
  onSave: SaveBridging;
}

export function PortBridgeDevicePage({ device, statuses, onBack, onSave }: DeviceProps) {
  const bridging = normalizePortBridging(device.portBridging);
  const bridges = sortedBridges(bridging.bridges);
  const duplicates = new Set(duplicatePortIds(bridges));
  const [draft, setDraft] = useState<DraftBridge | null>(null);

  const draftPort = Number(draft?.port);
  const draftValid = draft !== null && draft.port.trim() !== "" && canAddBridgePort(bridges, draftPort);
  const draftError = !draft || draft.port.trim() === "" || draftValid
    ? ""
    : bridges.some((bridge) => bridge.port === draftPort)
      ? `Port ${draft.port} is already bridged for this device.`
      : `Enter a port between ${MIN_BRIDGE_PORT} and ${MAX_BRIDGE_PORT}.`;

  function commit(next: PortBridge[]) {
    onSave(device.id, bridging.enabled, next);
  }

  /** Promote the draft into a real bridge once its port is usable. */
  function commitDraft() {
    if (!draft || !draftValid) return;
    commit(addBridge(bridges, draftPort, draft.server, draft.label));
    setDraft(null);
  }

  return <div className="modal-backdrop" onMouseDown={onBack}><section className="modal bridges-modal" onMouseDown={(event) => event.stopPropagation()}>
    {/* Closing a page that was opened from the list returns to the list. */}
    <button className="modal-close icon-button" onClick={onBack} aria-label="Back to port bridges"><CloseIcon /></button>
    <div className="modal-kicker"><PortBridgeIcon /> Ports</div>
    <h1><span className="display-name" title={device.name}>{device.name}</span></h1>
    <p>Pick the port and the side that already runs the service on it. The other side opens the same port on its own localhost.</p>

    <label className="settings-row bridge-switch-row">
      <span><strong>Bridge ports for this device</strong><small>Turning this off tears down every bridge below without forgetting them.</small></span>
      <span className="bridge-switch"><input type="checkbox" checked={bridging.enabled} onChange={(event) => onSave(device.id, event.target.checked, bridging.bridges)} /><i /></span>
    </label>

    <div className="bridge-config-list">
      {bridges.map((bridge) => {
        const status = portBridgeStatusOf(statuses, device.id, bridge.id);
        const state = bridging.enabled ? status?.state ?? "pending" : "disabled";
        const warning = bridging.enabled ? bridgeWarningDetail(bridge, status) : "";
        return <div className={`bridge-config-row ${duplicates.has(bridge.id) ? "is-invalid" : ""}`} key={bridge.id}>
          <label className="bridge-field is-port">Port<BridgePortInput
            port={bridge.port}
            onCommit={(port) => commit(updateBridge(bridges, bridge.id, { port }))}
          /></label>
          <label className="bridge-field">Served by<select
            value={bridge.server}
            onChange={(event) => commit(updateBridge(bridges, bridge.id, { server: event.target.value as PortBridgeServer }))}
          >
            <option value="host">This PC</option>
            <option value="client">{device.name}</option>
          </select></label>
          <label className="bridge-field">Label<BridgeLabelInput
            label={bridge.label ?? ""}
            onCommit={(label) => commit(updateBridge(bridges, bridge.id, { label }))}
          /></label>
          <button className="danger-icon" title="Remove port" onClick={() => commit(removeBridge(bridges, bridge.id))}><TrashIcon /></button>
          <div className="bridge-config-meta">
            <small>{bridgeDirectionLabel(bridge, "desktop")}</small>
            <span className={`bridge-state is-${state}`}>{bridgeStateLabel(state)}</span>
          </div>
          {warning && <p className="bridge-config-warning"><WarningIcon /><span>{warning}</span></p>}
        </div>;
      })}

      {draft && <div className={`bridge-config-row is-draft ${draftError ? "is-invalid" : ""}`}>
        <label className="bridge-field is-port">Port<input
          type="number"
          autoFocus
          min={MIN_BRIDGE_PORT}
          max={MAX_BRIDGE_PORT}
          placeholder="5173"
          value={draft.port}
          onChange={(event) => setDraft({ ...draft, port: event.target.value })}
          onBlur={commitDraft}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
        /></label>
        <label className="bridge-field">Served by<select value={draft.server} onChange={(event) => setDraft({ ...draft, server: event.target.value as PortBridgeServer })}>
          <option value="host">This PC</option>
          <option value="client">{device.name}</option>
        </select></label>
        <label className="bridge-field">Label<input
          maxLength={MAX_BRIDGE_LABEL_LENGTH}
          placeholder="optional"
          value={draft.label}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          onBlur={commitDraft}
        /></label>
        <button className="danger-icon" title="Discard this row" onClick={() => setDraft(null)}><TrashIcon /></button>
        {draftError && <p className="bridge-config-warning"><WarningIcon /><span>{draftError}</span></p>}
      </div>}

      {!bridges.length && !draft && <div className="bridge-empty">No ports yet. Add one below.</div>}
    </div>

    {/* One unfinished row at a time: a second empty template before the first
        has a port would give the user two rows that cannot be told apart. */}
    <button
      className="primary wide"
      disabled={draft !== null}
      title={draft !== null ? "Finish the port above first" : undefined}
      onClick={() => setDraft({ port: "", server: "host", label: "" })}
    ><PlusIcon /> New port bridge</button>
  </section></div>;
}

/**
 * A port field that commits when the user is done with it rather than on every
 * keystroke. Typing "5173" passes through "5", "51" and "517", and each of
 * those would be a save the host has to arbitrate - and any of them may
 * collide with another bridge on this device, which `updateBridge` refuses,
 * snapping the field back mid-word.
 */
function BridgePortInput({ port, onCommit }: { port: number; onCommit: (port: number) => void }) {
  const [draft, setDraft] = useState(String(port));
  const [editing, setEditing] = useState(false);
  // While the user is not typing, the saved value wins: a rejected edit and a
  // change made from the phone both have to show up here.
  const value = editing ? draft : String(port);

  return <input
    type="number"
    min={MIN_BRIDGE_PORT}
    max={MAX_BRIDGE_PORT}
    value={value}
    onFocus={() => { setDraft(String(port)); setEditing(true); }}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => {
      setEditing(false);
      const next = Number(draft);
      if (isValidBridgePort(next) && next !== port) onCommit(next);
    }}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
  />;
}

/** The label field, committed on blur for the same reason as the port. */
function BridgeLabelInput({ label, onCommit }: { label: string; onCommit: (label: string) => void }) {
  const [draft, setDraft] = useState(label);
  const [editing, setEditing] = useState(false);
  const value = editing ? draft : label;

  return <input
    maxLength={MAX_BRIDGE_LABEL_LENGTH}
    placeholder="optional"
    value={value}
    onFocus={() => { setDraft(label); setEditing(true); }}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => {
      setEditing(false);
      if (draft.trim() !== label) onCommit(draft);
    }}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
  />;
}
