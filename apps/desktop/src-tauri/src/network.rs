//! Network defaults shared by the native desktop host.
//!
//! The TypeScript client carries the same public defaults in
//! `packages/protocol/src/index.ts`. Environment variables are deliberately
//! supported for self-hosted deployments, but the stock build points at the
//! public Headscale hostname.

pub const DEFAULT_CONTROL_URL: &str = "https://node.hopto.org";
pub const DEFAULT_TAILNET_DOMAIN: &str = "agent-terminal.internal";

pub fn control_url() -> String {
    std::env::var("AGENT_TERMINAL_CONTROL_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_CONTROL_URL.to_string())
}

pub fn embedded_node_auth_key() -> Option<String> {
    std::env::var("AGENT_TERMINAL_NODE_AUTH_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

pub fn tailnet_domain() -> String {
    std::env::var("AGENT_TERMINAL_TAILNET_DOMAIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().trim_end_matches('.').to_string())
        .unwrap_or_else(|| DEFAULT_TAILNET_DOMAIN.to_string())
}
