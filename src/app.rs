//! The board's commands. The web UI (../ui) calls them as `POST /api/<command>` (see server.rs).
//! All Azure DevOps traffic and credentials stay in this Rust process.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::auth::{self, AccessToken, KEY_PAT, KEY_REFRESH};
use crate::board::{Ado, Change, Created, NewTicket, Snapshot, Store, TicketType};
use crate::secrets::Secrets;
use crate::settings::{AuthMode, Settings};

pub struct AppState {
    http: reqwest::Client,
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    secrets: Secrets,
    token: Mutex<Option<AccessToken>>,
    user: Mutex<Option<String>>,
    store: Mutex<Store>,
    last_error: Mutex<Option<ErrorInfo>>,
    /// Serializes refreshes so a click during an auto-refresh doesn't double the calls.
    refresh_lock: Mutex<Option<Instant>>,
    /// Only one interactive sign-in at a time.
    signing_in: Mutex<()>,
    cancel_sign_in: tokio::sync::Notify,
}

#[derive(Clone, Serialize)]
pub struct ErrorInfo {
    at: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    mode: AuthMode,
    signed_in: bool,
    user: Option<String>,
    has_pat: bool,
    has_microsoft: bool,
    microsoft_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardPayload {
    title: String,
    subtitle: String,
    board_url: String,
    time_zone: String,
    lookback_days: u32,
    refresh_minutes: u32,
    last_error: Option<ErrorInfo>,
    snapshot: Option<Snapshot>,
    history: Vec<Change>,
    user: Option<String>,
    configured: bool,
    new_lane: bool,
}

#[derive(Serialize)]
pub struct RefreshResult {
    ok: bool,
    skipped: bool,
    changes: Vec<Change>,
    error: Option<String>,
    message: Option<String>,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn scope_of(s: &Settings) -> String {
    format!("{}|{}|{}|{}|{}", s.ado_url, s.org, s.project, s.area_path, s.query_states().join(","))
}

impl AppState {
    /// Returns an Authorization header value, refreshing the Entra token when needed.
    async fn auth_header(&self) -> Result<String, String> {
        let s = self.settings.lock().await.clone();
        match s.auth_mode {
            AuthMode::Pat => {
                let pat = self.secrets.get(KEY_PAT).ok_or("Not signed in. Add a Personal Access Token in Sign in.")?;
                Ok(auth::basic_header(&pat))
            }
            AuthMode::Entra => {
                {
                    let t = self.token.lock().await;
                    if let Some(t) = t.as_ref() {
                        if t.expires > Instant::now() {
                            return Ok(format!("Bearer {}", t.token));
                        }
                    }
                }
                let rt = self.secrets.get(KEY_REFRESH).ok_or("Not signed in. Choose Sign in with Microsoft.")?;
                match auth::refresh(&self.http, &s, &rt).await {
                    Ok((at, new_rt)) => {
                        if let Some(nrt) = new_rt {
                            let _ = self.secrets.set(KEY_REFRESH, &nrt);
                        }
                        let h = format!("Bearer {}", at.token);
                        *self.token.lock().await = Some(at);
                        Ok(h)
                    }
                    Err(e) => {
                        if e.contains("expired") {
                            self.secrets.delete(KEY_REFRESH);
                            *self.user.lock().await = None;
                        }
                        Err(e)
                    }
                }
            }
        }
    }

    async fn status(&self) -> AuthStatus {
        let s = self.settings.lock().await.clone();
        let has_pat = self.secrets.get(KEY_PAT).is_some();
        let has_microsoft = self.secrets.get(KEY_REFRESH).is_some();
        AuthStatus {
            mode: s.auth_mode,
            signed_in: match s.auth_mode {
                AuthMode::Pat => has_pat,
                AuthMode::Entra => has_microsoft,
            },
            user: self.user.lock().await.clone(),
            has_pat,
            has_microsoft,
            microsoft_ready: !s.client_id.is_empty(),
        }
    }

    async fn set_error(&self, msg: &str) {
        *self.last_error.lock().await = Some(ErrorInfo { at: now_iso(), message: msg.to_string() });
    }

    /// The settings and an Authorization header, for a call made on the user's behalf.
    async fn signed_in(&self) -> Result<(Settings, String), String> {
        let s = self.settings.lock().await.clone();
        if !s.is_configured() {
            return Err("Set your Azure DevOps organization and project in Settings.".into());
        }
        let auth = self.auth_header().await?;
        Ok((s, auth))
    }
}

/* ------------------------------------------------------------- commands */

pub async fn get_settings(state: &AppState) -> Result<Settings, String> {
    Ok(state.settings.lock().await.clone())
}

pub async fn save_settings(state: &AppState, settings: Settings) -> Result<Settings, String> {
    let s = settings.normalized();
    s.save(&state.settings_path)?;
    let mut cur = state.settings.lock().await;
    let identity_changed = cur.org != s.org || cur.ado_url != s.ado_url || cur.tenant_id != s.tenant_id || cur.client_id != s.client_id || cur.auth_mode != s.auth_mode;
    *cur = s.clone();
    drop(cur);
    if identity_changed {
        *state.token.lock().await = None;
        *state.user.lock().await = None;
    }
    Ok(s)
}

pub async fn auth_status(state: &AppState) -> Result<AuthStatus, String> {
    Ok(state.status().await)
}

/// Validates a PAT against the organization, then stores it in the OS keychain.
pub async fn save_pat(state: &AppState, pat: String) -> Result<AuthStatus, String> {
    let pat = pat.trim().to_string();
    if pat.is_empty() {
        return Err("Paste a Personal Access Token first.".into());
    }
    let s = state.settings.lock().await.clone();
    let ado = Ado { http: &state.http, settings: &s, auth: auth::basic_header(&pat) };
    let name = ado.whoami().await?;
    state.secrets.set(KEY_PAT, &pat)?;
    {
        let mut cur = state.settings.lock().await;
        cur.auth_mode = AuthMode::Pat;
        let _ = cur.save(&state.settings_path);
    }
    *state.user.lock().await = Some(name);
    *state.token.lock().await = None;
    Ok(state.status().await)
}

/// Opens the system browser for Microsoft sign-in and waits for the redirect.
pub async fn sign_in_microsoft(state: &AppState) -> Result<AuthStatus, String> {
    let _guard = state.signing_in.try_lock().map_err(|_| "A sign-in is already open in your browser.".to_string())?;
    let s = state.settings.lock().await.clone();
    let pending = auth::begin_sign_in(&s).await?;
    open::that_detached(&pending.url).map_err(|e| format!("Could not open the browser: {e}"))?;
    let (at, rt) = tokio::select! {
        r = pending.complete(&state.http, &s) => r?,
        _ = state.cancel_sign_in.notified() => return Err("Sign-in cancelled.".into()),
    };
    let ado = Ado { http: &state.http, settings: &s, auth: format!("Bearer {}", at.token) };
    let name = ado.whoami().await?;
    match rt {
        Some(rt) => state.secrets.set(KEY_REFRESH, &rt)?,
        None => return Err("Microsoft did not return a refresh token. Make sure the app registration allows offline_access.".into()),
    }
    {
        let mut cur = state.settings.lock().await;
        cur.auth_mode = AuthMode::Entra;
        let _ = cur.save(&state.settings_path);
    }
    *state.token.lock().await = Some(at);
    *state.user.lock().await = Some(name);
    Ok(state.status().await)
}

pub async fn cancel_sign_in(state: &AppState) -> Result<(), String> {
    state.cancel_sign_in.notify_waiters();
    Ok(())
}

pub async fn sign_out(state: &AppState) -> Result<AuthStatus, String> {
    state.secrets.delete(KEY_PAT);
    state.secrets.delete(KEY_REFRESH);
    *state.token.lock().await = None;
    *state.user.lock().await = None;
    Ok(state.status().await)
}

pub async fn load_board(state: &AppState) -> Result<BoardPayload, String> {
    let s = state.settings.lock().await.clone();
    let store = state.store.lock().await;
    let snapshot = store.snapshot.clone().filter(|sn| sn.scope == scope_of(&s));
    Ok(BoardPayload {
        title: s.title.clone(),
        subtitle: format!("{} › {} · Azure Boards", s.org, s.area_path),
        board_url: s.effective_board_url(),
        time_zone: s.time_zone.clone(),
        lookback_days: s.lookback_days,
        refresh_minutes: s.refresh_minutes,
        last_error: state.last_error.lock().await.clone(),
        history: if snapshot.is_some() { store.tracking.history.iter().take(50).cloned().collect() } else { vec![] },
        snapshot,
        user: state.user.lock().await.clone(),
        configured: s.is_configured(),
        new_lane: !s.new_states.is_empty(),
    })
}

pub async fn refresh_board(state: &AppState, reason: Option<String>) -> Result<RefreshResult, String> {
    let reason = reason.unwrap_or_else(|| "manual".into());
    let mut last = state.refresh_lock.lock().await; // held for the whole refresh
    if reason == "manual" {
        if let Some(t) = *last {
            if t.elapsed() < Duration::from_secs(5) {
                return Ok(RefreshResult { ok: true, skipped: true, changes: vec![], error: None, message: Some("Just refreshed.".into()) });
            }
        }
    }
    *last = Some(Instant::now());
    let s = state.settings.lock().await.clone();
    if !s.is_configured() {
        let e = "Set your Azure DevOps organization and project in Settings.".to_string();
        state.set_error(&e).await;
        return Ok(RefreshResult { ok: false, skipped: false, changes: vec![], error: Some(e), message: None });
    }
    let auth = match state.auth_header().await {
        Ok(a) => a,
        Err(e) => {
            state.set_error(&e).await;
            return Ok(RefreshResult { ok: false, skipped: false, changes: vec![], error: Some(e), message: None });
        }
    };
    let ado = Ado { http: &state.http, settings: &s, auth };
    if state.user.lock().await.is_none() {
        if let Ok(name) = ado.whoami().await {
            *state.user.lock().await = Some(name);
        }
    }
    match ado.fetch().await {
        Ok((items, parents)) => {
            let changes = state.store.lock().await.apply(scope_of(&s), &reason, items, parents);
            *state.last_error.lock().await = None;
            Ok(RefreshResult { ok: true, skipped: false, changes, error: None, message: None })
        }
        Err(e) => {
            if e.starts_with("Unauthorized") {
                *state.token.lock().await = None;
            }
            state.set_error(&e).await;
            Ok(RefreshResult { ok: false, skipped: false, changes: vec![], error: Some(e), message: None })
        }
    }
}

/// The work item types the "New ticket" form offers.
pub async fn ticket_types(state: &AppState) -> Result<Vec<TicketType>, String> {
    let (s, auth) = state.signed_in().await?;
    Ado { http: &state.http, settings: &s, auth }.ticket_types().await
}

/// Creates a work item in the board's area path. The UI refreshes the board afterwards.
pub async fn create_ticket(state: &AppState, ticket: NewTicket) -> Result<Created, String> {
    let title = ticket.title.trim();
    if title.is_empty() {
        return Err("Give the ticket a title.".into());
    }
    if title.chars().count() > 255 {
        return Err("The title can be at most 255 characters.".into());
    }
    let (s, auth) = state.signed_in().await?;
    let ado = Ado { http: &state.http, settings: &s, auth };
    // Looked up again rather than trusted from the form, so the fields match the type.
    let types = ado.ticket_types().await?;
    let ty = types.iter().find(|t| t.name == ticket.kind).ok_or_else(|| format!("You can't create a {} in {}.", ticket.kind, s.project))?;
    ado.create(&ticket, ty).await
}

/* ---------------------------------------------------------------- state */

impl AppState {
    /// Loads settings from `config_dir` and the board cache and credential fallback from `data_dir`.
    pub fn new(config_dir: &Path, data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(config_dir).map_err(|e| format!("Could not create {}: {e}", config_dir.display()))?;
        std::fs::create_dir_all(data_dir).map_err(|e| format!("Could not create {}: {e}", data_dir.display()))?;
        let settings_path = config_dir.join("settings.json");
        let settings = Settings::load(&settings_path);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("DevOpsBoard/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(AppState {
            http,
            settings_path,
            settings: Mutex::new(settings),
            secrets: Secrets::new(data_dir.join("credentials.fallback.json")),
            token: Mutex::new(None),
            user: Mutex::new(None),
            store: Mutex::new(Store::open(data_dir.join("board"))),
            last_error: Mutex::new(None),
            refresh_lock: Mutex::new(None),
            signing_in: Mutex::new(()),
            cancel_sign_in: tokio::sync::Notify::new(),
        })
    }
}
