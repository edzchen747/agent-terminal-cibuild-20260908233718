//! Network defaults shared by the native desktop host.
//!
//! The TypeScript client carries the same public defaults in
//! `packages/protocol/src/index.ts`. Environment variables are deliberately
//! supported for self-hosted deployments, but the stock build points at the
//! public Headscale hostname.

use std::net::{TcpStream, ToSocketAddrs};

pub const DEFAULT_CONTROL_URL: &str = "https://node.hopto.org";
pub const DEFAULT_TAILNET_DOMAIN: &str = "agent-terminal.internal";

pub fn control_url() -> String {
    std::env::var("AGENT_TERMINAL_CONTROL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_CONTROL_URL.to_string())
}

pub fn provisioning_url() -> String {
    std::env::var("AGENT_TERMINAL_PROVISIONING_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| format!("{}/api/provision", control_url()))
}

pub fn tailnet_domain() -> String {
    std::env::var("AGENT_TERMINAL_TAILNET_DOMAIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().trim_end_matches('.').to_string())
        .unwrap_or_else(|| DEFAULT_TAILNET_DOMAIN.to_string())
}

/// Public anycast addresses used to probe for internet access. They are
/// literal IPs so the probe has no DNS dependency: a broken resolver alone,
/// or the overlay control server being down, must not be reported as a lost
/// network connection.
pub const INTERNET_PROBE_ENDPOINTS: &[(&str, u16)] = &[
    ("1.1.1.1", 53),
    ("8.8.8.8", 53),
    ("1.1.1.1", 443),
];

/// Returns true when any public probe endpoint accepts a TCP connection
/// within a short timeout.
pub fn internet_connected() -> bool {
    INTERNET_PROBE_ENDPOINTS.iter().any(|&(host, port)| {
        (host, port)
            .to_socket_addrs()
            .ok()
            .and_then(|mut addresses| addresses.next())
            .is_some_and(|address| {
                TcpStream::connect_timeout(&address, std::time::Duration::from_secs(2)).is_ok()
            })
    })
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use super::INTERNET_PROBE_ENDPOINTS;

    #[test]
    fn connectivity_probes_borrow_no_dns_resolution() {
        assert!(!INTERNET_PROBE_ENDPOINTS.is_empty());
        for &(host, port) in INTERNET_PROBE_ENDPOINTS {
            assert!(
                host.parse::<IpAddr>().is_ok(),
                "{host} must be a literal IP address"
            );
            assert_ne!(port, 0);
        }
    }
}
