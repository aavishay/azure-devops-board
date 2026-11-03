//! `azure-devops-board`: serves the board on 127.0.0.1 and opens it in the default browser.
//! Running it again while it's up just opens the browser at the running board.

mod app;
mod auth;
mod board;
mod secrets;
mod server;
mod settings;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

use app::AppState;

/// Folder name for settings and data, shared with the old desktop app so they carry over.
const IDENT: &str = "com.au10tix.devopsboard";
/// Tried first, so the address stays the same between runs; any free port if it's taken.
const DEFAULT_PORT: u16 = 47180;

const HELP: &str = "\
Azure DevOps Board: your team's Azure DevOps board in the browser.

Usage: azure-devops-board [options]

Starts the board on this computer and opens it in your default browser.
Run it again to reopen the board. Press Ctrl+C to stop it.

Options:
  -p, --port <port>  Listen on this port (default: 47180, or any free port if that's taken)
      --no-open      Don't open the browser; just print the address
  -h, --help         Show this help
  -V, --version      Show the version";

#[derive(Debug, PartialEq)]
struct Args {
    port: Option<u16>,
    open: bool,
}

/// Returns `None` when the arguments asked for help or the version, which are already printed.
fn parse_args(mut it: impl Iterator<Item = String>) -> Result<Option<Args>, String> {
    let mut args = Args { port: None, open: true };
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("azure-devops-board {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--no-open" => args.open = false,
            "-p" | "--port" => {
                let v = it.next().ok_or("--port needs a number")?;
                args.port = Some(v.parse().map_err(|_| format!("Not a port number: {v}"))?);
            }
            _ if a.starts_with("--port=") => {
                let v = &a["--port=".len()..];
                args.port = Some(v.parse().map_err(|_| format!("Not a port number: {v}"))?);
            }
            _ => return Err(format!("Unknown option: {a}. See azure-devops-board --help.")),
        }
    }
    Ok(Some(args))
}

/// The running server's port and the browser's sign-in token, kept between runs so an
/// open tab keeps working after a restart. Readable only by the current user.
#[derive(Serialize, Deserialize)]
struct ServerFile {
    #[serde(skip)]
    path: PathBuf,
    port: Option<u16>,
    token: String,
}

impl ServerFile {
    fn load(path: PathBuf) -> Self {
        let saved: Option<ServerFile> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok());
        match saved {
            Some(f) if f.token.len() >= 32 => ServerFile { path, ..f },
            _ => ServerFile { path, port: None, token: auth::random_url_safe(32) },
        }
    }

    fn save(&self) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        write_private(&self.path, &json).map_err(|e| format!("Could not write {}: {e}", self.path.display()))
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)?.write_all(bytes)
}

/// Asks the server on `port` whether it's this app, signed with our token.
async fn is_running(port: u16, token: &str) -> bool {
    let Ok(http) = reqwest::Client::builder().timeout(Duration::from_secs(2)).build() else { return false };
    let res = http
        .post(format!("http://127.0.0.1:{port}/api/ping"))
        .header("cookie", format!("{}={token}", server::COOKIE))
        .header(server::API_HEADER, "1")
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.is_ok_and(|v| v["app"] == "azure-devops-board"),
        _ => false,
    }
}

async fn bind(port: Option<u16>) -> Result<TcpListener, String> {
    match port {
        Some(p) => TcpListener::bind(("127.0.0.1", p)).await.map_err(|e| format!("Could not listen on port {p}: {e}")),
        None => match TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).await {
            Ok(l) => Ok(l),
            Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Could not open a local port: {e}")),
        },
    }
}

fn open_browser(url: &str) {
    if let Err(e) = open::that_detached(url) {
        eprintln!("Could not open your browser ({e}). Open the address above yourself.");
    }
}

async fn run() -> Result<(), String> {
    let Some(args) = parse_args(std::env::args().skip(1))? else { return Ok(()) };
    let config_dir = dirs::config_dir().ok_or("Could not find your settings folder.")?.join(IDENT);
    let data_dir = dirs::data_dir().ok_or("Could not find your data folder.")?.join(IDENT);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Could not create {}: {e}", data_dir.display()))?;
    let mut file = ServerFile::load(data_dir.join("server.json"));

    if let Some(port) = file.port.filter(|p| args.port.is_none_or(|want| want == *p)) {
        if is_running(port, &file.token).await {
            let url = server::launch_url(port, &file.token);
            println!("Azure DevOps Board is already running at http://127.0.0.1:{port}");
            if args.open {
                open_browser(&url);
            } else {
                println!("Open {url}");
            }
            return Ok(());
        }
    }

    let state = Arc::new(AppState::new(&config_dir, &data_dir)?);
    let listener = bind(args.port).await?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    file.port = Some(port);
    file.save()?;
    let url = server::launch_url(port, &file.token);
    println!("Azure DevOps Board is running at http://127.0.0.1:{port}");
    println!("Open {url} if your browser doesn't open by itself. Press Ctrl+C to stop.");
    if args.open {
        open_browser(&url);
    }

    let ctx = server::Ctx { state, token: file.token.clone(), port };
    let serve = axum::serve(listener, server::router(ctx)).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    });
    tokio::select! {
        r = serve => r.map_err(|e| e.to_string())?,
        // A Microsoft sign-in can hold a request open for minutes; don't wait that long.
        _ = async {
            let _ = tokio::signal::ctrl_c().await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        } => {}
    }
    println!("\nStopped.");
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("azure-devops-board: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(a: &[&str]) -> Result<Option<Args>, String> {
        parse_args(a.iter().map(|s| s.to_string()))
    }

    #[test]
    fn args() {
        assert_eq!(parse(&[]).unwrap(), Some(Args { port: None, open: true }));
        assert_eq!(parse(&["--no-open", "-p", "8080"]).unwrap(), Some(Args { port: Some(8080), open: false }));
        assert_eq!(parse(&["--port=9000"]).unwrap(), Some(Args { port: Some(9000), open: true }));
        assert!(parse(&["--port", "x"]).is_err());
        assert!(parse(&["--bogus"]).is_err());
    }
}
