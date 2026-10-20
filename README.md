# Azure DevOps Board (desktop)

A native desktop app for **Windows, macOS and Linux** that shows the Azure DevOps team's **New**, **To Do · Committed** and **In Progress** work as a kanban board. It's built with **Rust + Tauri 2**:

- The Rust backend handles sign-in, Azure DevOps API calls, credential storage and change tracking.
- The board UI runs in the system webview: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux.

Each person runs it on their own machine and signs in with **their own Azure DevOps access**. No server is needed, and there is no shared token to manage.

## What you get

| Area | Features |
|---|---|
| **Board** | Two lanes, grouped by workstream or by person. Incidents and P1 items are highlighted, and tasks link to their parent PBI. |
| **Overview** | Summary tiles, a load-by-owner chart, filters by type, workstream and person, and search. |
| **Changes** | New and Reassigned tags for the last 24 hours, plus a Recent changes log kept on this computer. |
| **Refresh** | Automatic every 10 minutes (configurable). Also on window focus when the data is stale, and on demand with Refresh. |
| **Sign-in** | **Sign in with Microsoft** (Entra ID, browser-based, with automatic token renewal), or a **Personal Access Token**. |
| **Security** | Credentials live in the OS keychain. Links open in your normal browser. |

## Install

### macOS (Homebrew)

```sh
brew tap aavishay/azure-devops-board
brew install --cask azure-devops-board
```

Upgrade with `brew upgrade --cask azure-devops-board`. `brew uninstall --zap --cask azure-devops-board` also removes settings and the board cache.

Before the first GitHub release exists, build and install it on your Mac in one step: `scripts/install-mac.sh` (installs Rust through Homebrew if it's missing).

### Windows and Linux

Homebrew casks are macOS-only. Download the installer from the [GitHub releases](https://github.com/aavishay/azure-devops-board/releases):

| OS | File | Note |
|---|---|---|
| Windows | `azure-devops-board-<ver>-windows-x64.msi` or `…-setup.exe` | WebView2 ships with Windows 10/11. |
| Linux | `.deb` (Ubuntu/Debian), `.rpm` (Fedora/RHEL) or `.AppImage` (any distro) | Needs WebKitGTK 4.1 (preinstalled on current GNOME/KDE desktops). |

## First run

1. **Settings** opens on first run. Enter your organization, project and area path (for example `contoso`, `Fabrikam`, `Fabrikam\DevOps`) and save.
2. **Sign in** with one of the two options:
   - **Sign in with Microsoft.** Your browser opens. Pick your work account, approve, and return to the app. The refresh token is saved in your keychain, so you stay signed in. This needs a one-time app registration (below).
   - **Personal Access Token.** In Azure DevOps go to **User settings → Personal access tokens → New token**, give it the scope **Work Items → Read**, then paste it into the app.
3. Pick your name in **I am**; it's preselected from your sign-in. Your tickets then show as "You".

## One-time setup for "Sign in with Microsoft" (Entra admin, ~3 minutes)

An Azure admin creates one app registration for the whole team:

1. Go to **Entra ID → App registrations → New registration**.
   - Name: `Azure DevOps Board`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Public client/native (mobile & desktop)**, URI `http://localhost`. Any port is accepted for localhost.
2. Under **Authentication**, set **Allow public client flows** to **Yes**.
3. Under **API permissions → Add a permission → Azure DevOps → Delegated → user_impersonation**, then **Grant admin consent**. Admin consent is optional, but without it users see a consent prompt on first sign-in.
4. Copy the **Application (client) ID**. Set **Tenant** to your domain (for example `contoso.com`) or the **Directory (tenant) ID**; the default, `organizations`, accepts any work account.

Each user pastes these into **Settings → Microsoft sign-in**, or you ship them pre-filled (see *Pre-filling settings*).

The sign-in uses the OAuth 2.0 authorization-code flow with PKCE and a loopback redirect, which is Microsoft's recommended flow for desktop apps.
- **Requested scope:** Azure DevOps (`499b84ac-1321-427f-aa17-267ca6975798/.default`) plus `offline_access`.
- **No client secret.** None is stored or needed.
- **Conditional Access** (MFA, compliant device) applies as it does for any Microsoft sign-in.

## Where things are stored

| What | Where |
|---|---|
| Settings | `settings.json` in the app config folder: `%APPDATA%\com.au10tix.devopsboard` (Windows), `~/Library/Application Support/com.au10tix.devopsboard` (macOS), `~/.config/com.au10tix.devopsboard` (Linux) |
| PAT / refresh token | OS credential store: Windows Credential Manager, macOS Keychain, or the Linux Secret Service (GNOME Keyring / KWallet). If no keyring is running on Linux, the app falls back to `credentials.fallback.json` with `0600` permissions. |
| Board snapshot + change log | `board/` in the app data folder |

**Sign out** removes the saved credentials from this computer.

## Pre-filling settings

To give the team a ready-to-go install, edit the defaults in `src-tauri/src/settings.rs` (`impl Default for Settings`) before building. Set `tenant_id` and `client_id` there and nobody has to type them.

Workstream grouping rules are in `ui/workstreams.js`.

## Building

You need:
- [Rust](https://rustup.rs) (stable)
- The Tauri CLI: `cargo install tauri-cli --version "^2" --locked`
- On Linux only: `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev libdbus-1-dev libssl-dev patchelf`

```sh
cd src-tauri
cargo tauri dev      # run with live reload of ui/
cargo tauri build    # installers in src-tauri/target/release/bundle/
```

There is no Node.js or npm step. The UI is plain HTML, CSS and JavaScript in `ui/`.

### Releasing (GitHub + Homebrew)

Each OS's installer must be built on that OS, so releases are built in CI:

1. Push this folder to `github.com/aavishay/azure-devops-board` and create the tap repo `github.com/aavishay/homebrew-azure-devops-board` from `~/src/homebrew-azure-devops-board`.
2. The workflow is `.github/workflows/release.yml`.
3. Add a repo secret `HOMEBREW_TAP_TOKEN`: a fine-grained token with **Contents: read and write** on `homebrew-azure-devops-board`. Without it, releases still build but the cask is not updated.
4. Tag and push: `git tag v1.0.0 && git push --tags`.

The workflow builds the macOS universal `.dmg`, Linux `.deb`/`.rpm`/`.AppImage` and Windows `.msi`/`.exe`, attaches them to the release, then sets the new version and sha256 in the cask (`scripts/update-cask.sh`). `azure-pipelines.yml` still builds the same installers as Azure DevOps pipeline artifacts if you prefer that.

Builds are unsigned. The cask clears the macOS quarantine flag on install, so Homebrew users don't see the Gatekeeper prompt; Windows SmartScreen will still warn once. To sign, see Tauri's [signing guides](https://v2.tauri.app/distribute/sign/).

## Testing

```sh
cd src-tauri
cargo test                                   # change tracking + name parsing
MOCK_ADO_URL=http://127.0.0.1:9090 cargo test  # also exercises the Azure DevOps client against a fake server
```

## Project layout

```
ui/                    board UI (HTML/CSS/JS), talks to Rust via window.__TAURI__.core.invoke
src-tauri/src/
  lib.rs               Tauri commands: settings, sign-in/out, load/refresh board
  auth.rs              PAT + Entra ID (PKCE, loopback redirect, token refresh)
  board.rs             WIQL + workitemsbatch queries, snapshot, change log
  secrets.rs           OS keychain storage (chunked for Windows limits)
  settings.rs          settings model and defaults
```
