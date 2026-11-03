//! The local web server: the embedded UI plus `POST /api/<command>`.
//!
//! It listens on 127.0.0.1 only, but any web page open in the browser can still send
//! requests to localhost, so every request must prove it comes from our own page:
//!
//! * The CLI opens `/?t=<token>`, which sets the token as an HttpOnly, SameSite=Strict
//!   cookie and redirects to `/`. Requests without that cookie are refused. SameSite=Strict
//!   means other sites' pages never send it.
//! * API calls must also carry the `X-Board: 1` header. A cross-site page can only add a
//!   custom header after a CORS preflight, which this server never approves.
//! * The `Host` header must be this server's own address, which defeats DNS rebinding.

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::post;
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::app::{self, AppState};

pub const COOKIE: &str = "azure-devops-board";
/// The header every API call carries; see the module docs.
pub const API_HEADER: &str = "x-board";

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

#[derive(RustEmbed)]
#[folder = "ui/"]
struct Ui;

#[derive(Clone)]
pub struct Ctx {
    pub state: Arc<AppState>,
    pub token: String,
    pub port: u16,
}

pub fn router(ctx: Ctx) -> Router {
    Router::new()
        .route("/api/{cmd}", post(api))
        .fallback(page)
        .layer(middleware::from_fn_with_state(ctx.clone(), guard))
        .with_state(ctx)
}

/// The URL the CLI opens: it signs the browser in to this server.
pub fn launch_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/?t={token}")
}

/* ------------------------------------------------------------- the guard */

async fn guard(State(ctx): State<Ctx>, req: Request, next: Next) -> Response {
    let res = match check(&ctx, &req) {
        Some(refused) => refused,
        None => next.run(req).await,
    };
    secure_headers(res)
}

/// Returns the response to send instead when the request is refused or is the
/// handshake, or `None` to let it through.
fn check(ctx: &Ctx, req: &Request) -> Option<Response> {
    let h = req.headers();
    if !host_ok(h, ctx.port) {
        return Some((StatusCode::MISDIRECTED_REQUEST, "Unknown host.").into_response());
    }
    // The handshake: /?t=<token> sets the cookie, then drops the token from the address bar.
    if req.method() == Method::GET && req.uri().path() == "/" {
        if let Some(t) = query_param(req.uri().query().unwrap_or(""), "t") {
            if !same(&t, &ctx.token) {
                return Some(not_signed_in(false));
            }
            let mut r = Redirect::to("/").into_response();
            let cookie = format!("{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict", ctx.token);
            r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).expect("the token is URL-safe"));
            return Some(r);
        }
    }
    let is_api = req.uri().path().starts_with("/api/");
    if !cookie_of(h).is_some_and(|c| same(&c, &ctx.token)) {
        return Some(not_signed_in(is_api));
    }
    if is_api && (h.get(API_HEADER).map(|v| v.as_bytes()) != Some(b"1") || !origin_ok(h, ctx.port)) {
        return Some((StatusCode::FORBIDDEN, Json(json!({ "error": "Request refused." }))).into_response());
    }
    None
}

fn host_ok(h: &HeaderMap, port: u16) -> bool {
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// Browsers send Origin on POSTs. When present it must be this server.
fn origin_ok(h: &HeaderMap, port: u16) -> bool {
    match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        None => true,
        Some(o) => o == format!("http://127.0.0.1:{port}") || o == format!("http://localhost:{port}"),
    }
}

fn cookie_of(h: &HeaderMap) -> Option<String> {
    h.get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
}

fn query_param(q: &str, name: &str) -> Option<String> {
    url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// Compares in constant time, so the token can't be guessed byte by byte.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn not_signed_in(api: bool) -> Response {
    if api {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "This tab is no longer connected. Run azure-devops-board again to reopen the board." }))).into_response();
    }
    let body = "<!doctype html><meta charset=utf-8><title>Azure DevOps Board</title><body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;color:#16212a\"><div style=\"max-width:460px;text-align:center\"><p>Open the board by running <code>azure-devops-board</code> in a terminal.</p></div>";
    (StatusCode::UNAUTHORIZED, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

fn secure_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/* ------------------------------------------------------------ the routes */

async fn page(req: Request) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Ui::get(path) {
        Some(f) => ([(header::CONTENT_TYPE, f.metadata.mimetype().to_string())], Body::from(f.data.into_owned())).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `POST /api/<command>` with the command's arguments as a JSON object. A failed command
/// answers 400 with `{"error": "<message>"}`, the message the UI shows.
async fn api(State(ctx): State<Ctx>, Path(cmd): Path<String>, body: Option<Json<Value>>) -> Response {
    let args = body.map(|Json(v)| v).unwrap_or(Value::Null);
    let s = &*ctx.state;
    let r = match cmd.as_str() {
        "ping" => Ok(json!({ "app": "azure-devops-board", "version": env!("CARGO_PKG_VERSION") })),
        "get_settings" => to_json(app::get_settings(s).await),
        "save_settings" => match serde_json::from_value(args.get("settings").cloned().unwrap_or(Value::Null)) {
            Ok(settings) => to_json(app::save_settings(s, settings).await),
            Err(e) => Err(format!("Invalid settings: {e}")),
        },
        "auth_status" => to_json(app::auth_status(s).await),
        "save_pat" => to_json(app::save_pat(s, str_arg(&args, "pat").unwrap_or_default()).await),
        "sign_in_microsoft" => to_json(app::sign_in_microsoft(s).await),
        "cancel_sign_in" => to_json(app::cancel_sign_in(s).await),
        "sign_out" => to_json(app::sign_out(s).await),
        "load_board" => to_json(app::load_board(s).await),
        "refresh_board" => to_json(app::refresh_board(s, str_arg(&args, "reason")).await),
        _ => return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("Unknown command: {cmd}") }))).into_response(),
    };
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

fn str_arg(args: &Value, name: &str) -> Option<String> {
    args.get(name).and_then(Value::as_str).map(str::to_string)
}

fn to_json<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "test-token-0123456789abcdef0123456789";

    /// Starts the server on a free port with throwaway folders.
    async fn start() -> (u16, reqwest::Client) {
        let dir = std::env::temp_dir().join(format!("adb-test-{}", unique_id()));
        let state = Arc::new(AppState::new(&dir.join("config"), &dir.join("data")).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = router(Ctx { state, token: TOKEN.into(), port });
        tokio::spawn(async move { axum::serve(listener, app).await });
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        (port, http)
    }

    fn unique_id() -> String {
        format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect()
    }

    fn signed_in() -> String {
        format!("{COOKIE}={TOKEN}")
    }

    #[tokio::test]
    async fn handshake_sets_a_strict_cookie() {
        let (port, http) = start().await;
        let r = http.get(launch_url(port, TOKEN)).send().await.unwrap();
        assert_eq!(r.status(), 303);
        assert_eq!(r.headers()["location"], "/");
        let cookie = r.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.starts_with(&signed_in()) && cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));

        let wrong = http.get(launch_url(port, "nope")).send().await.unwrap();
        assert_eq!(wrong.status(), 401);
        assert!(wrong.headers().get("set-cookie").is_none());
    }

    #[tokio::test]
    async fn page_needs_the_cookie() {
        let (port, http) = start().await;
        let url = format!("http://127.0.0.1:{port}/");
        assert_eq!(http.get(&url).send().await.unwrap().status(), 401);
        let r = http.get(&url).header("cookie", signed_in()).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.headers()["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
        assert!(r.text().await.unwrap().contains("app.js"));
        let js = http.get(format!("{url}app.js")).header("cookie", signed_in()).send().await.unwrap();
        assert!(js.headers()["content-type"].to_str().unwrap().contains("javascript"));
    }

    #[tokio::test]
    async fn api_needs_cookie_header_and_own_origin() {
        let (port, http) = start().await;
        let ping = format!("http://127.0.0.1:{port}/api/ping");
        let post = |h: &[(&str, String)]| {
            let mut r = http.post(&ping);
            for (k, v) in h {
                r = r.header(*k, v);
            }
            r.send()
        };
        assert_eq!(post(&[(API_HEADER, "1".into())]).await.unwrap().status(), 401);
        assert_eq!(post(&[("cookie", signed_in())]).await.unwrap().status(), 403);
        let evil = [("cookie", signed_in()), (API_HEADER, "1".into()), ("origin", "https://evil.example".into())];
        assert_eq!(post(&evil).await.unwrap().status(), 403);
        let ok = post(&[("cookie", signed_in()), (API_HEADER, "1".into()), ("origin", format!("http://127.0.0.1:{port}"))]).await.unwrap();
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.json::<Value>().await.unwrap()["app"], "azure-devops-board");
    }

    #[tokio::test]
    async fn rejects_other_hosts() {
        // What a DNS-rebinding page would send: our port, its own host name.
        let (port, http) = start().await;
        let r = http.get(format!("http://127.0.0.1:{port}/")).header("host", format!("evil.example:{port}")).header("cookie", signed_in()).send().await.unwrap();
        assert_eq!(r.status(), 421);
    }

    #[tokio::test]
    async fn commands_answer_json() {
        let (port, http) = start().await;
        let call = |cmd: &str, body: Value| {
            http.post(format!("http://127.0.0.1:{port}/api/{cmd}")).header("cookie", signed_in()).header(API_HEADER, "1").json(&body).send()
        };
        let board = call("load_board", json!({})).await.unwrap();
        assert_eq!(board.status(), 200);
        assert_eq!(board.json::<Value>().await.unwrap()["configured"], false);
        let bad = call("save_pat", json!({ "pat": "  " })).await.unwrap();
        assert_eq!(bad.status(), 400);
        assert!(bad.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("Personal Access Token"));
        assert_eq!(call("no_such_thing", json!({})).await.unwrap().status(), 404);
    }
}
