use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::network;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest<'a> {
    nonce: &'a str,
    host_id: &'a str,
    device_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentKey {
    pub auth_key: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Activation {
    activation_token: String,
}

pub async fn issue_mobile_key(
    host_id: &str,
    device_id: &str,
    nonce: &str,
) -> Result<EnrollmentKey> {
    let token = network::provisioning_token().ok_or_else(|| {
        anyhow!("Mobile enrollment is not configured on this desktop installation.")
    })?;
    let client = reqwest::Client::new();
    let base_url = network::provisioning_url();
    let request = EnrollmentRequest {
        nonce,
        host_id,
        device_id,
    };
    let activation_response = client
        .post(format!("{base_url}/v1/activate"))
        .bearer_auth(token)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .json(&request)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .context("the enrollment service could not be reached")?;

    if !activation_response.status().is_success() {
        return Err(anyhow!(
            "the enrollment service rejected activation (HTTP {})",
            activation_response.status().as_u16()
        ));
    }
    let activation = activation_response
        .json::<Activation>()
        .await
        .context("the enrollment service returned an invalid activation")?;
    if activation.activation_token.len() < 32 {
        return Err(anyhow!(
            "the enrollment service returned an invalid activation"
        ));
    }

    let enrollment_response = client
        .post(format!("{base_url}/v1/enroll"))
        .bearer_auth(activation.activation_token)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .json(&request)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .context("the enrollment service could not issue a key")?;
    if !enrollment_response.status().is_success() {
        return Err(anyhow!(
            "the enrollment service rejected enrollment (HTTP {})",
            enrollment_response.status().as_u16()
        ));
    }
    let key = enrollment_response
        .json::<EnrollmentKey>()
        .await
        .context("the enrollment service returned an invalid response")?;
    if key.auth_key.len() < 20 || key.expires_at.is_empty() {
        return Err(anyhow!(
            "the enrollment service returned an invalid response"
        ));
    }
    Ok(key)
}
