import { useState } from "react";
import {
  MAX_BRIDGE_PORT,
  MIN_BRIDGE_PORT,
  addBridge,
  bridgeDirectionLabel,
  bridgeStateLabel,
  bridgeWarningDetail,
  canAddBridgePort,
  duplicatePortIds,
  isPortBridgeWarning,
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

/**
 * The Port Bridge pages.
 *
 * The list page is the overview: a card per paired device, whether bridging is
 * on for it, and every port it asked for with what became of it. The warning
 * marker lives only here, because only here is there more than one device to
 * compare - a port is host-exclusive, so a device can be perfectly configured
 * and still not be bridged because another device claimed the number first.
 *
 * The per-device page is pure configuration and deliberately shows no
 * warnings: it is about what this device should have, not about who currently
 * won the race for it.
 */

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

  function commit() {
    setEditing(false);
    const next = Number(draft);
    if (isValidBridgePort(next) && next !== port) onCommit(next);
  }

  return <input
    type="number"
    min={MIN_BRIDGE_PORT}
    max={MAX_BRIDGE_PORT}
    value={value}
    onFocus={() => { setDraft(String(port)); setEditing(true); }}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
  />;
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
      {devices.length ? devices.map((device) => {
        const bridging = normalizePortBridging(device.portBridging);
        const bridges = sortedBridges(bridging.bridges);
        return <article className="bridge-device" key={device.id}>
          <header>
            <span className="device-avatar"><PhoneIcon /></span>
            <span>
              <strong className="device-name">
                <span className="display-name" title={device.name}>{device.name}</span>
                <i className={`device-status ${device.online ? "is-online" : "is-offline"}`} title={device.online ? "Connected now" : "Not connected"} />
              </strong>
              <small>{bridges.length ? `${bridges.length} port${bridges.length === 1 ? "" : "s"} configured` : "No ports configured"}</small>
            </span>
            <label className="settings-toggle" title={bridging.enabled ? "Turn port bridging off for this device" : "Turn port bridging on for this device"}>
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
              const warning = bridging.enabled ? bridgeWarningDetail(bridge, status) : "";
              return <div className="bridge-row" key={bridge.id}>
                <strong>{bridge.port}</strong>
                <small>{bridgeDirectionLabel(bridge, "desktop")}</small>
                <span className={`bridge-state is-${bridging.enabled ? status?.state ?? "pending" : "disabled"}`}>
                  {bridgeStateLabel(bridging.enabled ? status?.state ?? "pending" : "disabled")}
                </span>
                {warning
                  ? <span className="bridge-warning" role="img" aria-label={warning} title={warning}><WarningIcon /></span>
                  : <span className="bridge-warning is-empty" />}
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

interface DeviceProps {
  device: AuthorizedDevice;
  onBack: () => void;
  onClose: () => void;
  onSave: SaveBridging;
}

export function PortBridgeDevicePage({ device, onBack, onClose, onSave }: DeviceProps) {
  const bridging = normalizePortBridging(device.portBridging);
  const bridges = sortedBridges(bridging.bridges);
  const duplicates = new Set(duplicatePortIds(bridges));
  const [draftPort, setDraftPort] = useState("");
  const [draftServer, setDraftServer] = useState<PortBridgeServer>("host");

  const port = Number(draftPort);
  const canAdd = draftPort.trim() !== "" && canAddBridgePort(bridges, port);
  const addError = draftPort.trim() === "" || canAdd
    ? ""
    : bridges.some((bridge) => bridge.port === port)
      ? `Port ${draftPort} is already bridged for this device.`
      : `Enter a port between ${MIN_BRIDGE_PORT} and ${MAX_BRIDGE_PORT}.`;

  function commit(next: PortBridge[]) {
    onSave(device.id, bridging.enabled, next);
  }

  function add() {
    if (!canAdd) return;
    commit(addBridge(bridges, port, draftServer));
    setDraftPort("");
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal bridges-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); add(); }}>
    <button type="button" className="modal-close icon-button" onClick={onClose}><CloseIcon /></button>
    <button type="button" className="modal-back" onClick={onBack}>Back to port bridges</button>
    <div className="modal-kicker"><PortBridgeIcon /> Ports</div>
    <h1><span className="display-name" title={device.name}>{device.name}</span></h1>
    <p>Pick the port and the side that already runs the service on it. The other side opens the same port on its own localhost.</p>

    <label className="settings-row settings-toggle">
      <span><strong>Bridge ports for this device</strong><small>Turning this off tears down every bridge below without forgetting them.</small></span>
      <input type="checkbox" checked={bridging.enabled} onChange={(event) => onSave(device.id, event.target.checked, bridging.bridges)} />
      <i />
    </label>

    <div className="bridge-config-list">
      {bridges.length ? bridges.map((bridge) => <div className={`bridge-config-row ${duplicates.has(bridge.id) ? "is-invalid" : ""}`} key={bridge.id}>
        <label>Port<BridgePortInput
          port={bridge.port}
          onCommit={(port) => commit(updateBridge(bridges, bridge.id, { port }))}
        /></label>
        <label>Server<select
          value={bridge.server}
          onChange={(event) => commit(updateBridge(bridges, bridge.id, { server: event.target.value as PortBridgeServer }))}
        >
          <option value="host">This PC</option>
          <option value="client">{device.name}</option>
        </select></label>
        <button type="button" className="danger-icon" title="Remove port" onClick={() => commit(removeBridge(bridges, bridge.id))}><TrashIcon /></button>
      </div>) : <div className="bridge-empty">No ports yet. Add one below.</div>}
    </div>

    <div className="bridge-config-row is-draft">
      <label>Port<input
        type="number"
        min={MIN_BRIDGE_PORT}
        max={MAX_BRIDGE_PORT}
        placeholder="5173"
        value={draftPort}
        onChange={(event) => setDraftPort(event.target.value)}
      /></label>
      <label>Server<select value={draftServer} onChange={(event) => setDraftServer(event.target.value as PortBridgeServer)}>
        <option value="host">This PC</option>
        <option value="client">{device.name}</option>
      </select></label>
      <button type="submit" className="icon-button" disabled={!canAdd} title="Add port"><PlusIcon /></button>
    </div>
    {addError && <div className="form-error">{addError}</div>}
  </form></div>;
}

/** Whether any of a device's configured bridges is showing a warning. */
export function deviceHasBridgeWarning(
  device: Pick<AuthorizedDevice, "id" | "portBridging">,
  statuses: Record<string, PortBridgeStatus[]> | undefined
): boolean {
  const bridging = normalizePortBridging(device.portBridging);
  if (!bridging.enabled) return false;
  return bridging.bridges.some((bridge) => isPortBridgeWarning(portBridgeStatusOf(statuses, device.id, bridge.id)));
}
