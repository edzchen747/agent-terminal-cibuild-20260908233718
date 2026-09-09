//! Port Bridge arbitration.
//!
//! A bridge names a port and the side that runs the real service on
//! `127.0.0.1:port`; the other side opens a loopback listener and forwards
//! over the overlay. The bytes never touch this process - the embedded node
//! proxies them - so what the host does here is decide *which* bridges may
//! exist, write that decision out as the node's desired state, and explain
//! every bridge that did not make it.
//!
//! Ports are unique within one device but may collide between devices, and a
//! collision is resolved first-come-first-served: the connected device that
//! claimed the port keeps it until it disconnects, at which point the port is
//! re-awarded to the longest-connected device still waiting for it. A port is
//! host-exclusive regardless of which side serves it, so one number is claimed
//! by at most one device at a time.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::models::{PortBridge, PortBridgeServer, PortBridgeState, PortBridgeStatus};

/// One device as the arbiter sees it.
pub struct BridgeCandidate {
    pub device_id: String,
    pub device_name: String,
    /// Whether the device currently holds an authenticated connection.
    pub connected: bool,
    /// The overlay address the device reported for its own node. A device
    /// cannot be bridged until it has one: it is both the dial target and the
    /// peer allowlist entry.
    pub tailnet_address: Option<String>,
    /// Connection order, ascending. The first-come-first-served key.
    pub connected_seq: u64,
    pub enabled: bool,
    pub bridges: Vec<PortBridge>,
}

/// One entry of the node's desired state (`bridges.json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BridgeEntry {
    pub id: String,
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BridgeFile {
    pub revision: u64,
    pub bridges: Vec<BridgeEntry>,
}

/// What the node made of the desired state (`bridges-status.json`).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct NodeBridgeStatusFile {
    #[serde(default)]
    pub bridges: Vec<NodeBridgeStatus>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct NodeBridgeStatus {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub error: String,
}

pub const MODE_LISTEN_TSNET: &str = "listen-tsnet";
pub const MODE_LISTEN_LOCAL: &str = "listen-local";

/// States the node reports back in `bridges-status.json`.
const NODE_STATE_FAILED: &str = "failed";
/// Listening, but the far side refused or never answered - which is what a
/// filtered port looks like, and is otherwise invisible.
const NODE_STATE_UNREACHABLE: &str = "unreachable";

pub struct BridgePlan {
    pub entries: Vec<BridgeEntry>,
    pub statuses: BTreeMap<String, Vec<PortBridgeStatus>>,
}

/// The desired-state entry id for one device's bridge. Scoped by device so a
/// status coming back from the node names exactly one configured bridge.
pub fn entry_id(device_id: &str, bridge_id: &str) -> String {
    format!("{device_id}\u{1f}{bridge_id}")
}

/// Split an entry id back into its device and bridge halves.
pub fn split_entry_id(id: &str) -> Option<(&str, &str)> {
    id.split_once('\u{1f}')
}

/// Decide which bridges may exist and explain the rest.
///
/// `node_ready` is whether this PC's own embedded node is up: with no node
/// there is nothing to proxy through, so every bridge waits rather than
/// pretending to be established.
pub fn plan_port_bridges(candidates: &[BridgeCandidate], node_ready: bool) -> BridgePlan {
    let mut order: Vec<&BridgeCandidate> = candidates.iter().collect();
    // Connected devices arbitrate in the order they connected; a device that
    // is not connected claims nothing, so its position does not matter.
    order.sort_by_key(|candidate| (!candidate.connected, candidate.connected_seq));

    // port -> the device that holds it.
    let mut claims: BTreeMap<u16, &str> = BTreeMap::new();
    let mut entries = Vec::new();
    let mut statuses: BTreeMap<String, Vec<PortBridgeStatus>> = BTreeMap::new();

    for candidate in order {
        let mut device_statuses = Vec::with_capacity(candidate.bridges.len());
        let mut ports_used_here: Vec<u16> = Vec::new();

        for bridge in &candidate.bridges {
            let status = |state: PortBridgeState, detail: Option<String>| PortBridgeStatus {
                bridge_id: bridge.id.clone(),
                state,
                detail,
            };

            if !candidate.enabled {
                device_statuses.push(status(PortBridgeState::Disabled, None));
                continue;
            }
            if !node_ready {
                device_statuses.push(status(
                    PortBridgeState::Pending,
                    Some(
                        "This PC's overlay node is not running, so no port can be bridged yet."
                            .into(),
                    ),
                ));
                continue;
            }
            if !candidate.connected {
                device_statuses.push(status(
                    PortBridgeState::Pending,
                    Some(format!(
                        "{} is not connected. The bridge is set up as soon as it connects.",
                        candidate.device_name
                    )),
                ));
                continue;
            }
            let Some(peer) = candidate.tailnet_address.as_deref() else {
                device_statuses.push(status(
                    PortBridgeState::Pending,
                    Some(format!(
                        "Waiting for {} to bring up its overlay node.",
                        candidate.device_name
                    )),
                ));
                continue;
            };
            if ports_used_here.contains(&bridge.port) {
                // The config pages reject a repeat, so this only guards a
                // hand-edited store file.
                device_statuses.push(status(
                    PortBridgeState::Failed,
                    Some(format!(
                        "Port {} is listed twice for this device.",
                        bridge.port
                    )),
                ));
                continue;
            }
            if let Some(&holder) = claims.get(&bridge.port) {
                let holder_name = candidates
                    .iter()
                    .find(|other| other.device_id == holder)
                    .map(|other| other.device_name.as_str())
                    .unwrap_or("another device");
                device_statuses.push(status(
                    PortBridgeState::Conflict,
                    Some(format!(
                        "Port {} is already bridged by {holder_name}. It is bridged here as soon as {holder_name} disconnects.",
                        bridge.port
                    )),
                ));
                continue;
            }

            claims.insert(bridge.port, candidate.device_id.as_str());
            ports_used_here.push(bridge.port);
            entries.push(host_entry(&candidate.device_id, bridge, peer));
            device_statuses.push(status(PortBridgeState::Active, None));
        }

        statuses.insert(candidate.device_id.clone(), device_statuses);
    }

    BridgePlan { entries, statuses }
}

/// This PC's half of a bridge.
///
/// When the host serves, it accepts on the tailnet and dials its own service,
/// and only the device that was awarded the port may connect. When the device
/// serves, the host accepts on loopback and dials the device over the overlay.
fn host_entry(device_id: &str, bridge: &PortBridge, peer: &str) -> BridgeEntry {
    match bridge.server {
        PortBridgeServer::Host => BridgeEntry {
            id: entry_id(device_id, &bridge.id),
            mode: MODE_LISTEN_TSNET,
            port: Some(bridge.port),
            listen: None,
            target: format!("127.0.0.1:{}", bridge.port),
            peer: Some(peer.to_string()),
        },
        PortBridgeServer::Client => BridgeEntry {
            id: entry_id(device_id, &bridge.id),
            mode: MODE_LISTEN_LOCAL,
            port: None,
            listen: Some(format!("127.0.0.1:{}", bridge.port)),
            target: format!("{peer}:{}", bridge.port),
            peer: None,
        },
    }
}

/// Fold the node's own verdict into the plan.
///
/// The plan says a bridge is allowed; the node says whether the listener
/// actually opened. A local port that some unrelated program already owns only
/// shows up here.
pub fn merge_node_statuses(
    plan: &mut BridgePlan,
    entries: &[BridgeEntry],
    node: &NodeBridgeStatusFile,
) {
    for reported in &node.bridges {
        if reported.state != NODE_STATE_FAILED && reported.state != NODE_STATE_UNREACHABLE {
            continue;
        }
        let Some((device_id, bridge_id)) = split_entry_id(&reported.id) else {
            continue;
        };
        let Some(statuses) = plan.statuses.get_mut(device_id) else {
            continue;
        };
        let Some(status) = statuses.iter_mut().find(|item| item.bridge_id == bridge_id) else {
            continue;
        };
        if status.state != PortBridgeState::Active {
            continue;
        }
        let entry = entries.iter().find(|item| item.id == reported.id);
        status.state = PortBridgeState::Failed;
        status.detail = Some(if reported.state == NODE_STATE_UNREACHABLE {
            node_unreachable_detail(entry, &reported.error)
        } else {
            node_failure_detail(entry, &reported.error)
        });
    }
}

/// The node could not open its listener at all.
fn node_failure_detail(entry: Option<&BridgeEntry>, error: &str) -> String {
    let reason = reason_suffix(error);
    match entry {
        Some(entry) if entry.mode == MODE_LISTEN_LOCAL => format!(
            "{} could not be opened on this PC; another program is probably already using it{reason}.",
            entry.listen.as_deref().unwrap_or("The local port")
        ),
        Some(entry) => format!(
            "Port {} could not be opened on this PC's overlay node{reason}.",
            entry.port.unwrap_or_default()
        ),
        None => format!("The bridge could not be opened on this PC{reason}."),
    }
}

/// The listener is open, but forwarding a connection through it failed.
///
/// Which side is at fault depends on the direction, and getting this wrong
/// sends the user looking in the wrong place: a `listen-tsnet` bridge dials
/// this PC's own service, while a `listen-local` one dials the device across
/// the overlay.
fn node_unreachable_detail(entry: Option<&BridgeEntry>, error: &str) -> String {
    let reason = reason_suffix(error);
    match entry {
        Some(entry) if entry.mode == MODE_LISTEN_LOCAL => format!(
            "The device did not answer on {}{reason}. Check that the service is running on it, and that the overlay allows this port.",
            entry.target
        ),
        Some(entry) => format!(
            "Nothing answered on {} on this PC{reason}. Start the service on that port.",
            entry.target
        ),
        None => format!("The bridge is listening but its target did not answer{reason}."),
    }
}

fn reason_suffix(error: &str) -> String {
    if error.trim().is_empty() {
        String::new()
    } else {
        format!(" ({})", error.trim())
    }
}

/// Fold in what a device said about its own half of the bridges. Only its
/// failures are interesting: the host already knows which bridges it allowed,
/// and a device cannot promote one the host refused.
pub fn merge_device_reports(
    plan: &mut BridgePlan,
    reports: &BTreeMap<String, Vec<PortBridgeStatus>>,
) {
    for (device_id, reported) in reports {
        let Some(statuses) = plan.statuses.get_mut(device_id) else {
            continue;
        };
        for report in reported {
            if report.state != PortBridgeState::Failed {
                continue;
            }
            let Some(status) = statuses
                .iter_mut()
                .find(|item| item.bridge_id == report.bridge_id)
            else {
                continue;
            };
            if status.state != PortBridgeState::Active {
                continue;
            }
            status.state = PortBridgeState::Failed;
            status.detail = report
                .detail
                .clone()
                .or_else(|| Some("The device could not open its side of this bridge.".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge(id: &str, port: u16, server: PortBridgeServer) -> PortBridge {
        PortBridge {
            id: id.into(),
            port,
            server,
        }
    }

    fn candidate(id: &str, name: &str, seq: u64, bridges: Vec<PortBridge>) -> BridgeCandidate {
        BridgeCandidate {
            device_id: id.into(),
            device_name: name.into(),
            connected: true,
            tailnet_address: Some(format!("100.64.0.{seq}")),
            connected_seq: seq,
            enabled: true,
            bridges,
        }
    }

    fn state_of(plan: &BridgePlan, device_id: &str, bridge_id: &str) -> PortBridgeState {
        plan.statuses[device_id]
            .iter()
            .find(|status| status.bridge_id == bridge_id)
            .expect("configured bridge has a status")
            .state
    }

    #[test]
    fn a_contested_port_goes_to_the_device_that_connected_first() {
        let candidates = vec![
            candidate(
                "late",
                "Tablet",
                2,
                vec![bridge("b", 8080, PortBridgeServer::Host)],
            ),
            candidate(
                "early",
                "Pixel",
                1,
                vec![bridge("a", 8080, PortBridgeServer::Host)],
            ),
        ];
        let plan = plan_port_bridges(&candidates, true);

        assert_eq!(state_of(&plan, "early", "a"), PortBridgeState::Active);
        assert_eq!(state_of(&plan, "late", "b"), PortBridgeState::Conflict);
        assert_eq!(plan.entries.len(), 1);
        assert_eq!(plan.entries[0].id, entry_id("early", "a"));
        // The warning has to name the holder: that is the whole content of
        // the tooltip on the Port Bridge page.
        assert!(
            plan.statuses["late"][0]
                .detail
                .as_deref()
                .expect("a conflict explains itself")
                .contains("Pixel")
        );
    }

    #[test]
    fn a_port_released_on_disconnect_is_re_awarded_to_the_longest_waiting_device() {
        let mut candidates = vec![
            candidate(
                "early",
                "Pixel",
                1,
                vec![bridge("a", 8080, PortBridgeServer::Host)],
            ),
            candidate(
                "middle",
                "Tablet",
                2,
                vec![bridge("b", 8080, PortBridgeServer::Host)],
            ),
            candidate(
                "late",
                "Laptop",
                3,
                vec![bridge("c", 8080, PortBridgeServer::Host)],
            ),
        ];
        assert_eq!(
            state_of(&plan_port_bridges(&candidates, true), "middle", "b"),
            PortBridgeState::Conflict
        );

        candidates[0].connected = false;
        let plan = plan_port_bridges(&candidates, true);
        assert_eq!(state_of(&plan, "middle", "b"), PortBridgeState::Active);
        assert_eq!(state_of(&plan, "late", "c"), PortBridgeState::Conflict);
        assert_eq!(state_of(&plan, "early", "a"), PortBridgeState::Pending);
    }

    #[test]
    fn a_device_that_has_not_reported_its_overlay_address_claims_nothing() {
        let mut candidates = vec![
            candidate(
                "silent",
                "Pixel",
                1,
                vec![bridge("a", 8080, PortBridgeServer::Host)],
            ),
            candidate(
                "ready",
                "Tablet",
                2,
                vec![bridge("b", 8080, PortBridgeServer::Host)],
            ),
        ];
        candidates[0].tailnet_address = None;

        let plan = plan_port_bridges(&candidates, true);
        assert_eq!(state_of(&plan, "silent", "a"), PortBridgeState::Pending);
        // The port was never claimed, so it is still free for the next device.
        assert_eq!(state_of(&plan, "ready", "b"), PortBridgeState::Active);
    }

    #[test]
    fn each_server_side_produces_the_matching_half_of_the_proxy() {
        let candidates = vec![candidate(
            "device",
            "Pixel",
            1,
            vec![
                bridge("served-here", 5173, PortBridgeServer::Host),
                bridge("served-there", 9000, PortBridgeServer::Client),
            ],
        )];
        let plan = plan_port_bridges(&candidates, true);

        // The host runs the service: accept on the tailnet, dial our own
        // localhost, and let only the awarded device in.
        let host_side = &plan.entries[0];
        assert_eq!(host_side.mode, MODE_LISTEN_TSNET);
        assert_eq!(host_side.port, Some(5173));
        assert_eq!(host_side.target, "127.0.0.1:5173");
        assert_eq!(host_side.peer.as_deref(), Some("100.64.0.1"));

        // The device runs the service: accept on our loopback and dial it.
        let device_side = &plan.entries[1];
        assert_eq!(device_side.mode, MODE_LISTEN_LOCAL);
        assert_eq!(device_side.listen.as_deref(), Some("127.0.0.1:9000"));
        assert_eq!(device_side.target, "100.64.0.1:9000");
        assert_eq!(device_side.peer, None);
    }

    #[test]
    fn bridging_switched_off_or_a_node_that_is_down_bridges_nothing() {
        let mut candidates = vec![candidate(
            "device",
            "Pixel",
            1,
            vec![bridge("a", 8080, PortBridgeServer::Host)],
        )];
        assert_eq!(
            state_of(&plan_port_bridges(&candidates, false), "device", "a"),
            PortBridgeState::Pending
        );
        assert!(plan_port_bridges(&candidates, false).entries.is_empty());

        candidates[0].enabled = false;
        let plan = plan_port_bridges(&candidates, true);
        assert_eq!(state_of(&plan, "device", "a"), PortBridgeState::Disabled);
        assert!(plan.entries.is_empty());
    }

    #[test]
    fn a_local_port_the_node_could_not_open_becomes_a_warning() {
        let candidates = vec![candidate(
            "device",
            "Pixel",
            1,
            vec![bridge("a", 9000, PortBridgeServer::Client)],
        )];
        let mut plan = plan_port_bridges(&candidates, true);
        let entries = plan.entries.clone();
        merge_node_statuses(
            &mut plan,
            &entries,
            &NodeBridgeStatusFile {
                bridges: vec![NodeBridgeStatus {
                    id: entry_id("device", "a"),
                    state: "failed".into(),
                    error: "bind: address already in use".into(),
                }],
            },
        );

        assert_eq!(state_of(&plan, "device", "a"), PortBridgeState::Failed);
        let detail = plan.statuses["device"][0].detail.clone().expect("a reason");
        assert!(detail.contains("127.0.0.1:9000"), "{detail}");
        assert!(detail.contains("already in use"), "{detail}");
    }

    #[test]
    fn a_device_reporting_its_own_failure_downgrades_only_an_active_bridge() {
        let candidates = vec![
            candidate(
                "early",
                "Pixel",
                1,
                vec![bridge("a", 8080, PortBridgeServer::Host)],
            ),
            candidate(
                "late",
                "Tablet",
                2,
                vec![bridge("b", 8080, PortBridgeServer::Host)],
            ),
        ];
        let mut plan = plan_port_bridges(&candidates, true);
        let mut reports = BTreeMap::new();
        reports.insert(
            "early".to_string(),
            vec![PortBridgeStatus {
                bridge_id: "a".into(),
                state: PortBridgeState::Failed,
                detail: Some("Port 8080 is in use on this phone.".into()),
            }],
        );
        // A device cannot talk its way past the host's arbitration either.
        reports.insert(
            "late".to_string(),
            vec![PortBridgeStatus {
                bridge_id: "b".into(),
                state: PortBridgeState::Failed,
                detail: Some("ignored".into()),
            }],
        );
        merge_device_reports(&mut plan, &reports);

        assert_eq!(state_of(&plan, "early", "a"), PortBridgeState::Failed);
        assert_eq!(
            plan.statuses["early"][0].detail.as_deref(),
            Some("Port 8080 is in use on this phone.")
        );
        assert_eq!(state_of(&plan, "late", "b"), PortBridgeState::Conflict);
    }

    #[test]
    fn a_listening_bridge_whose_target_never_answers_becomes_a_warning() {
        // The failure this exists for: the listener opens on both sides, so
        // everything looks healthy, and every connection through it hangs
        // until the dial times out with nothing recorded anywhere.
        let candidates = vec![candidate(
            "device",
            "Pixel",
            1,
            vec![
                bridge("served-here", 8000, PortBridgeServer::Host),
                bridge("served-there", 5000, PortBridgeServer::Client),
            ],
        )];
        let mut plan = plan_port_bridges(&candidates, true);
        let entries = plan.entries.clone();
        merge_node_statuses(
            &mut plan,
            &entries,
            &NodeBridgeStatusFile {
                bridges: vec![
                    NodeBridgeStatus {
                        id: entry_id("device", "served-here"),
                        state: "unreachable".into(),
                        error: "connection refused".into(),
                    },
                    NodeBridgeStatus {
                        id: entry_id("device", "served-there"),
                        state: "unreachable".into(),
                        error: "i/o timeout".into(),
                    },
                ],
            },
        );

        assert_eq!(
            state_of(&plan, "device", "served-here"),
            PortBridgeState::Failed
        );
        assert_eq!(
            state_of(&plan, "device", "served-there"),
            PortBridgeState::Failed
        );

        // The host serves 8000, so the missing service is on this PC.
        let here = plan.statuses["device"]
            .iter()
            .find(|status| status.bridge_id == "served-here")
            .and_then(|status| status.detail.clone())
            .expect("a reason");
        assert!(here.contains("127.0.0.1:8000"), "{here}");
        assert!(here.contains("on this PC"), "{here}");

        // The device serves 5000, so the user must be sent to the device -
        // pointing at this PC would send them looking in the wrong place.
        let there = plan.statuses["device"]
            .iter()
            .find(|status| status.bridge_id == "served-there")
            .and_then(|status| status.detail.clone())
            .expect("a reason");
        assert!(there.contains("100.64.0.1:5000"), "{there}");
        assert!(there.contains("device did not answer"), "{there}");
        assert!(there.contains("i/o timeout"), "{there}");
    }

    #[test]
    fn a_bridge_the_node_reports_as_listening_stays_active() {
        let candidates = vec![candidate(
            "device",
            "Pixel",
            1,
            vec![bridge("a", 8000, PortBridgeServer::Host)],
        )];
        let mut plan = plan_port_bridges(&candidates, true);
        let entries = plan.entries.clone();
        merge_node_statuses(
            &mut plan,
            &entries,
            &NodeBridgeStatusFile {
                bridges: vec![NodeBridgeStatus {
                    id: entry_id("device", "a"),
                    state: "listening".into(),
                    error: String::new(),
                }],
            },
        );
        assert_eq!(state_of(&plan, "device", "a"), PortBridgeState::Active);
        assert_eq!(plan.statuses["device"][0].detail, None);
    }
}
