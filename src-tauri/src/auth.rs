//! Azure DevOps authentication.
//!
//! * PAT: sent as HTTP Basic (`:<pat>`).
//! * Microsoft Entra ID: OAuth 2.0 authorization code flow with PKCE and a loopback
//!   redirect (`http://localhost:<random port>`), the flow Microsoft recommends for
//!   desktop apps. The refresh token is kept in the OS credential store; access tokens
//!   live only in memory.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::settings::Settings;

/// Azure DevOps resource ID; `.default` asks for the permissions granted to the app registration.
pub const ADO_SCOPE: &str = "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access openid profile";
pub const KEY_PAT: &str = "pat";
pub const KEY_REFRESH: &str = "entra_refresh_token";

#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: String,
    pub expires: Instant,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct TokenError {
    error: Option<String>,
    error_description: Option<String>,
}

pub fn basic_header(pat: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!(":{pat}")))
}

fn authority(s: &Settings) -> String {
    format!("https://login.microsoftonline.com/{}/oauth2/v2.0", s.tenant_id)
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Builds the sign-in URL and returns it with the listener that will receive the redirect.
pub async fn begin_sign_in(s: &Settings) -> Result<PendingSignIn, String> {
    if s.client_id.is_empty() {
        return Err("Microsoft sign-in needs an Application (client) ID. Add it in Settings, or sign in with a PAT instead.".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Could not open a local port for sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://localhost:{port}");
    let verifier = random_url_safe(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_url_safe(24);
    let url = url::Url::parse_with_params(
        &format!("{}/authorize", authority(s)),
        &[
            ("client_id", s.client_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_mode", "query"),
            ("scope", ADO_SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("prompt", "select_account"),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(PendingSignIn { listener, url: url.to_string(), redirect_uri, verifier, state })
}

pub struct PendingSignIn {
    listener: TcpListener,
    pub url: String,
    redirect_uri: String,
    verifier: String,
    state: String,
}

impl PendingSignIn {
    /// Waits (up to 5 minutes) for the browser redirect, then redeems the code.
    pub async fn complete(self, http: &reqwest::Client, s: &Settings) -> Result<(AccessToken, Option<String>), String> {
        let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(&self.listener, &self.state))
            .await
            .map_err(|_| "Sign-in timed out after 5 minutes. Try again.".to_string())??;
        let form = [
            ("client_id", s.client_id.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", self.redirect_uri.as_str()),
            ("code_verifier", self.verifier.as_str()),
            ("scope", ADO_SCOPE),
        ];
        token_request(http, s, &form).await
    }
}

async fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 16 * 1024];
        let mut n = 0;
        // Read the request head (we only need the first line).
        loop {
            let r = sock.read(&mut buf[n..]).await.map_err(|e| e.to_string())?;
            if r == 0 {
                break;
            }
            n += r;
            if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == buf.len() {
                break;
            }
        }
        let head = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string();
        let parsed = url::Url::parse(&format!("http://localhost{target}")).map_err(|e| e.to_string())?;
        if parsed.path() != "/" {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let q: std::collections::HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        let (ok, message, result) = if let Some(err) = q.get("error") {
            let desc = q.get("error_description").cloned().unwrap_or_default();
            (false, format!("Sign-in failed: {err}. {desc}"), Err(format!("Microsoft sign-in failed: {err}. {}", desc.lines().next().unwrap_or(""))))
        } else if q.get("state").map(String::as_str) != Some(expected_state) {
            (false, "Sign-in failed: the response did not match this request.".to_string(), Err("Sign-in response did not match the request (state mismatch).".to_string()))
        } else if let Some(code) = q.get("code") {
            (true, "You're signed in to Azure DevOps. You can close this tab and return to Azure DevOps Board.".to_string(), Ok(code.clone()))
        } else {
            let _ = sock.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        let body = format!(
            "<!doctype html><meta charset=utf-8><title>Azure DevOps Board</title><body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;color:#16212a\"><div style=\"max-width:460px;text-align:center\"><div style=\"font-size:40px\">{}</div><p>{}</p></div>",
            if ok { "✓" } else { "✕" },
            html_escape(&message)
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
        return result;
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Exchanges a refresh token for a new access token (and usually a rotated refresh token).
pub async fn refresh(http: &reqwest::Client, s: &Settings, refresh_token: &str) -> Result<(AccessToken, Option<String>), String> {
    let form = [
        ("client_id", s.client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", ADO_SCOPE),
    ];
    token_request(http, s, &form).await
}

async fn token_request(http: &reqwest::Client, s: &Settings, form: &[(&str, &str)]) -> Result<(AccessToken, Option<String>), String> {
    let res = http
        .post(format!("{}/token", authority(s)))
        .form(form)
        .send()
        .await
        .map_err(|e| format!("Could not reach Microsoft sign-in: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let e: TokenError = serde_json::from_str(&text).unwrap_or(TokenError { error: None, error_description: None });
        let desc = e.error_description.unwrap_or_default();
        let first = desc.lines().next().unwrap_or("").to_string();
        return Err(match e.error.as_deref() {
            Some("invalid_grant") | Some("interaction_required") => format!("Your Microsoft sign-in has expired. Sign in again. ({first})"),
            Some(code) => format!("Microsoft sign-in error {code}: {first}"),
            None => format!("Microsoft sign-in error (HTTP {status})"),
        });
    }
    let t: TokenResponse = serde_json::from_str(&text).map_err(|e| format!("Unexpected sign-in response: {e}"))?;
    let ttl = t.expires_in.unwrap_or(3600).saturating_sub(120).max(60);
    Ok((AccessToken { token: t.access_token, expires: Instant::now() + Duration::from_secs(ttl) }, t.refresh_token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loopback_redirect_and_pkce() {
        let mut s = Settings::default();
        s.client_id = "11111111-2222-3333-4444-555555555555".into();
        let p = begin_sign_in(&s).await.unwrap();
        let u = url::Url::parse(&p.url).unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(u.host_str(), Some("login.microsoftonline.com"));
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], URL_SAFE_NO_PAD.encode(Sha256::digest(p.verifier.as_bytes())));
        assert!(q["redirect_uri"].starts_with("http://localhost:"));
        let port: u16 = q["redirect_uri"].rsplit(':').next().unwrap().parse().unwrap();
        let state = p.state.clone();
        let browser = tokio::spawn(async move {
            // A favicon request first, then the real redirect.
            let http = reqwest::Client::new();
            let _ = http.get(format!("http://127.0.0.1:{port}/favicon.ico")).send().await;
            http.get(format!("http://127.0.0.1:{port}/?code=abc123&state={state}")).send().await.unwrap().text().await.unwrap()
        });
        let code = wait_for_code(&p.listener, &p.state).await.unwrap();
        assert_eq!(code, "abc123");
        assert!(browser.await.unwrap().contains("signed in"));
    }

    #[tokio::test]
    async fn loopback_rejects_wrong_state() {
        let mut s = Settings::default();
        s.client_id = "x".into();
        let p = begin_sign_in(&s).await.unwrap();
        let port = p.listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = reqwest::get(format!("http://127.0.0.1:{port}/?code=abc&state=forged")).await;
        });
        assert!(wait_for_code(&p.listener, &p.state).await.unwrap_err().contains("state"));
    }

    #[test]
    fn requires_client_id() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        assert!(rt.block_on(begin_sign_in(&Settings::default())).is_err());
    }
}
