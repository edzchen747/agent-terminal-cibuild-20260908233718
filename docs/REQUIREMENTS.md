# Updated acceptance criteria

## Pairing

- QR scanning is a one-time device-binding process for each phone.
- The user should not need to scan the QR code again for ordinary reconnects.
- The phone stores only the desktop host endpoint, host ID, phone device ID, and its device credential.
- The desktop stores the authorized device record and can revoke it.
- Revoking a device invalidates its saved credential and disconnects it.
- A new QR scan is required only when adding a new phone or after revocation.

## Network reachability

- After pairing, a phone can reconnect when the desktop and phone are on different Wi-Fi networks, mobile data, or behind separate NAT/firewall boundaries.
- Neither endpoint requires an inbound port-forwarding rule.
- The desktop and phone each make outbound WebSocket connections to a relay.
- The relay routes an authenticated phone connection to the paired desktop host ID and does not own project or terminal state.
- The relay must use wss:// in a production deployment.
- Direct LAN WebSocket remains available only as a local-development fallback when no relay URL is configured.
- The desktop QR modal and mobile onboarding must describe pairing as a one-time device binding, not a one-time reconnect code.
- Pairing UI must not label the QR as a one-time code or present its setup-grant expiry as the lifetime of the device pairing.
- The confirmation language must state that the phone remains authorized until explicitly revoked.

## Session behavior

- Projects and authorized devices remain desktop-owned and persistent.
- Live sessions are discovered after every successful reconnect.
- New projects open desktop windows; additional sessions in one project open desktop tabs.
- Temporary projects are derived from live sessions and are not persisted.
- Terminal bytes travel over the live paired connection with resize and scrollback support.
- Desktop Ctrl+C copies when terminal text is selected; with no selection it must continue to send the shell interrupt signal.
- A successful selection copy displays a brief toast positioned above the selected terminal text.
