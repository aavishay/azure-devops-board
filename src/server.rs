//! The local web server: the embedded UI plus `POST /api/<command>`.
//!
//! It listens on 127.0.0.1 only, but any web page open in the browser can still send
//! requests to localhost, so API calls must prove they come from our own page:
//!
//! * The CLI opens `/#t=<token>`. The fragment never leaves the browser; the page keeps the
//!   token in its own localStorage, which browsers isolate per origin (port included), and
//!   sends it in the `X-Board` header. Nothing is stored in cookies, which browsers share
//!   between all ports on a host.
//! * Browsers label requests made by other sites, other ports included, with
//!   `Sec-Fetch-Site`; only our own page and direct navigation are served.
//! * The `Host` header must be this server's own address, which defeats DNS rebinding.
//!
//! `/hello` lets a second run of the CLI check that this is its own server without
//! sending the token: it answers a random challenge with an HMAC keyed by the token.

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;

use crate::app::{self, AppState};

/// The header every API call carries the token in.
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
        .route("/hello", get(hello))
        .fallback(page)
        .layer(middleware::from_fn_with_state(ctx.clone(), guard))
        .with_state(ctx)
}

/// The URL the CLI opens. The token is in the fragment, so it never reaches a server.
pub fn launch_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/#t={token}")
}

/// What `/hello` answers for `nonce`: proof of knowing the token without revealing it.
pub fn proof(token: &str, nonce: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC takes any key length");
    mac.update(nonce.as_bytes());
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/* ------------------------------------------------------------- the guard */

async fn guard(State(ctx): State<Ctx>, req: Request, next: Next) -> Response {
    let res = match check(&ctx, &req) {
        Some(refused) => refused,
        None => next.run(req).await,
    };
    secure_headers(res)
}

/// Returns the response to send instead when the request is refused, or `None` to let it through.
fn check(ctx: &Ctx, req: &Request) -> Option<Response> {
    let h = req.headers();
    if !host_ok(h, ctx.port) {
        return Some((StatusCode::MISDIRECTED_REQUEST, "Unknown host.").into_response());
    }
    // "same-origin" is our own page, "none" a navigation the user or the CLI started.
    // Pages on other sites, and on other ports of this computer, get "same-site" or "cross-site".
    if !matches!(h.get("sec-fetch-site").map(HeaderValue::as_bytes), None | Some(b"same-origin") | Some(b"none")) {
        return Some((StatusCode::FORBIDDEN, "Request refused.").into_response());
    }
    if req.uri().path().starts_with("/api/") {
        let token = h.get(API_HEADER).and_then(|v| v.to_str().ok()).unwrap_or("");
        if !same(token, &ctx.token) {
            return Some((StatusCode::UNAUTHORIZED, Json(json!({ "error": "This tab isn't connected to the board. Run azure-devops-board to open it again." }))).into_response());
        }
        if !origin_ok(h, ctx.port) {
            return Some((StatusCode::FORBIDDEN, Json(json!({ "error": "Request refused." }))).into_response());
        }
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

/// Compares in constant time, so the token can't be guessed byte by byte.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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

async fn hello(State(ctx): State<Ctx>, Query(q): Query<HashMap<String, String>>) -> Response {
    match q.get("n").filter(|n| (16..=128).contains(&n.len())) {
        Some(n) => Json(json!({ "app": "azure-devops-board", "proof": proof(&ctx.token, n) })).into_response(),
        None => StatusCode::BAD_REQUEST.into_response(),
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
        "ticket_types" => to_json(app::ticket_types(s).await),
        "create_ticket" => match serde_json::from_value(args.get("ticket").cloned().unwrap_or(Value::Null)) {
            Ok(ticket) => to_json(app::create_ticket(s, ticket).await),
            Err(e) => Err(format!("Invalid ticket: {e}")),
        },
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
        (port, reqwest::Client::new())
    }

    fn unique_id() -> String {
        format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect()
    }

    #[test]
    fn launch_url_keeps_the_token_in_the_fragment() {
        assert_eq!(launch_url(47180, "abc"), "http://127.0.0.1:47180/#t=abc");
    }

    #[tokio::test]
    async fn page_is_served_with_strict_headers() {
        let (port, http) = start().await;
        let r = http.get(format!("http://127.0.0.1:{port}/")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.headers()["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
        assert_eq!(r.headers()["referrer-policy"], "no-referrer");
        assert!(r.text().await.unwrap().contains("app.js"));
        let js = http.get(format!("http://127.0.0.1:{port}/app.js")).header("sec-fetch-site", "same-origin").send().await.unwrap();
        assert!(js.headers()["content-type"].to_str().unwrap().contains("javascript"));
    }

    #[tokio::test]
    async fn api_needs_the_token_and_own_origin() {
        let (port, http) = start().await;
        let ping = format!("http://127.0.0.1:{port}/api/ping");
        let post = |h: &[(&str, String)]| {
            let mut r = http.post(&ping);
            for (k, v) in h {
                r = r.header(*k, v);
            }
            r.send()
        };
        assert_eq!(post(&[]).await.unwrap().status(), 401);
        assert_eq!(post(&[(API_HEADER, "wrong".into())]).await.unwrap().status(), 401);
        assert_eq!(post(&[(API_HEADER, TOKEN.into()), ("origin", "https://evil.example".into())]).await.unwrap().status(), 403);
        let ok = post(&[(API_HEADER, TOKEN.into()), ("origin", format!("http://127.0.0.1:{port}"))]).await.unwrap();
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.json::<Value>().await.unwrap()["app"], "azure-devops-board");
    }

    #[tokio::test]
    async fn refuses_other_sites_and_ports() {
        // A page on another port of this computer is "same-site"; one elsewhere is "cross-site".
        let (port, http) = start().await;
        for site in ["same-site", "cross-site"] {
            let page = http.get(format!("http://127.0.0.1:{port}/workstreams.js")).header("sec-fetch-site", site).send().await.unwrap();
            assert_eq!(page.status(), 403, "{site} page");
            let api = http.post(format!("http://127.0.0.1:{port}/api/ping")).header(API_HEADER, TOKEN).header("sec-fetch-site", site).send().await.unwrap();
            assert_eq!(api.status(), 403, "{site} API call");
        }
    }

    #[tokio::test]
    async fn rejects_other_hosts() {
        // What a DNS-rebinding page would send: our port, its own host name.
        let (port, http) = start().await;
        let r = http.get(format!("http://127.0.0.1:{port}/")).header("host", format!("evil.example:{port}")).send().await.unwrap();
        assert_eq!(r.status(), 421);
    }

    #[tokio::test]
    async fn hello_proves_the_token_without_sending_it() {
        let (port, http) = start().await;
        let nonce = "0123456789abcdefghij";
        let r = http.get(format!("http://127.0.0.1:{port}/hello?n={nonce}")).send().await.unwrap();
        let body = r.json::<Value>().await.unwrap();
        assert_eq!(body["proof"], proof(TOKEN, nonce));
        assert_ne!(proof("another-token", nonce), proof(TOKEN, nonce));
        assert!(!body.to_string().contains(TOKEN));
        assert_eq!(http.get(format!("http://127.0.0.1:{port}/hello?n=short")).send().await.unwrap().status(), 400);
    }

    #[tokio::test]
    async fn commands_answer_json() {
        let (port, http) = start().await;
        let call = |cmd: &str, body: Value| http.post(format!("http://127.0.0.1:{port}/api/{cmd}")).header(API_HEADER, TOKEN).json(&body).send();
        let board = call("load_board", json!({})).await.unwrap();
        assert_eq!(board.status(), 200);
        assert_eq!(board.json::<Value>().await.unwrap()["configured"], false);
        let bad = call("save_pat", json!({ "pat": "  " })).await.unwrap();
        assert_eq!(bad.status(), 400);
        assert!(bad.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("Personal Access Token"));
        let untitled = call("create_ticket", json!({ "ticket": { "type": "Bug", "title": " " } })).await.unwrap();
        assert_eq!(untitled.status(), 400);
        assert!(untitled.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("title"));
        let unset = call("ticket_types", json!({})).await.unwrap();
        assert_eq!(unset.status(), 400);
        assert!(unset.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("Settings"));
        assert_eq!(call("no_such_thing", json!({})).await.unwrap().status(), 404);
    }
}
