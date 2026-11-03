# Azure DevOps Board

A team board for **Azure DevOps** that runs in your browser. It shows the team's **New**, **To Do · Committed** and **In Progress** work as a kanban board.

Run `azure-devops-board` and it opens the board in your default browser. A small Rust program runs on your computer while you use it:

- It serves the board UI at `http://127.0.0.1` (this computer only).
- It handles sign-in, Azure DevOps API calls, credential storage and change tracking, so your credentials never reach the browser.

Each person runs it on their own machine and signs in with **their own Azure DevOps access**. No shared server is needed, and there is no shared token to manage. It works on **macOS, Linux and Windows**.

## What you get

| Area | Features |
|---|---|
| **Board** | Lanes for New, To Do and In Progress, grouped by workstream or by person. Incidents and P1 items are highlighted, tasks link to their parent PBI, and duplicates are merged into one card. |
| **Overview** | Summary tiles, a load-by-owner chart, filters by type, workstream and person, search, and hiding people you don't need to see. |
| **Changes** | An Added tag for the last 24 hours, plus a Recent changes log kept on this computer. |
| **Refresh** | Automatic every 10 minutes (configurable). Also when you return to the tab and the data is stale, and on demand with Refresh or Cmd/Ctrl+R. |
| **New tickets** | **+ New ticket** (or press **N**) creates a work item without opening Azure DevOps: any of the project's types, with title, description, priority, assignee and parent. It goes to the board's area path, and the board refreshes to show it (in the New lane, if that's on). |
| **Sign-in** | **Sign in with Microsoft** (Entra ID, browser-based, with automatic token renewal), or a **Personal Access Token**. |
| **Security** | Credentials live in the OS keychain. The local server only answers the tab it opened (see *Security*). |

## Install

### Homebrew (macOS and Linux)

```sh
brew tap aavishay/azure-devops-board
brew trust aavishay/azure-devops-board   # Homebrew 7+ asks you to trust third-party taps
brew install azure-devops-board
```

Upgrade with `brew upgrade azure-devops-board`.

If you used the old desktop app, remove it first with `brew uninstall --cask azure-devops-board`. Your settings, saved sign-in and board history carry over.

### Windows, or without Homebrew

Download the archive for your system from the [GitHub releases](https://github.com/aavishay/azure-devops-board/releases) and put the `azure-devops-board` program somewhere on your `PATH`:

| OS | File |
|---|---|
| macOS (Apple Silicon and Intel) | `azure-devops-board-<ver>-macos-universal.tar.gz` |
| Linux (x86-64) | `azure-devops-board-<ver>-linux-x86_64.tar.gz` |
| Windows (x64) | `azure-devops-board-<ver>-windows-x64.zip` |

With Rust installed, `cargo install --git https://github.com/aavishay/azure-devops-board` also works.

## Running it

```sh
azure-devops-board
```

The board opens in your default browser. Leave the terminal open while you use it, and press **Ctrl+C** to stop. Running the command again while the board is already running just reopens it in the browser.

| Option | |
|---|---|
| `-p`, `--port <port>` | Listen on this port. Without it, the board reuses the port it used last time, then tries `47180`, then any free port. |
| `--no-open` | Don't open the browser; just print the address. |
| `-h`, `--help` / `-V`, `--version` | Show help or the version. |

Your filters and other view choices are remembered by the browser for that address, which is why the board keeps using the same port.

## First run

1. **Settings** opens on first run. Enter your organization, project and area path (for example `contoso`, `Fabrikam`, `Fabrikam\DevOps`) and save.
2. **Sign in** with one of the two options:
   - **Sign in with Microsoft.** A new tab opens. Pick your work account, approve, and return to the board. The refresh token is saved in your keychain, so you stay signed in. This needs a one-time app registration (below).
   - **Personal Access Token.** In Azure DevOps go to **User settings → Personal access tokens → New token**, give it the scope **Work Items → Read & write**, then paste it into the board. **Read** is enough if you only view the board; creating tickets needs write.
3. Pick your name in **I am**; it's preselected from your sign-in. Your tickets then show as "You".

On macOS, the first time the program reads a credential saved by an earlier version, the Keychain asks whether `azure-devops-board` may use it. Choose **Always Allow**.

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

The sign-in uses the OAuth 2.0 authorization-code flow with PKCE and a loopback redirect, which is Microsoft's recommended flow for native apps.
- **Requested scope:** Azure DevOps (`499b84ac-1321-427f-aa17-267ca6975798/.default`) plus `offline_access`.
- **No client secret.** None is stored or needed.
- **Conditional Access** (MFA, compliant device) applies as it does for any Microsoft sign-in.

## Security

The server listens on `127.0.0.1` only, so nothing else on the network can reach it. Web pages open in your browser can still send requests to localhost, so the board's API only answers its own tab:

- The command opens the board with a secret token in the address's `#` fragment, which browsers never send to any server. The page keeps the token in its own storage, which browsers keep separate for each port, and sends it with every API call. No cookies are used, because browsers share cookies between all ports on `127.0.0.1`.
- Requests that the browser marks as coming from another site, including another port on this computer, are refused.
- The `Host` header must be the server's own address, which blocks DNS-rebinding attacks.
- When you run the command again, it checks for a running board by asking it to prove it knows the token (a challenge answered with an HMAC). The token itself is never sent, so a program that took over the old port learns nothing.
- Startup takes a lock, so two runs at the same moment start one server, not two.

The token is kept in `server.json` (readable only by you), so an open tab keeps working after you restart the command.

## Where things are stored

| What | Where |
|---|---|
| Settings | `settings.json` in the config folder: `%APPDATA%\com.au10tix.devopsboard` (Windows), `~/Library/Application Support/com.au10tix.devopsboard` (macOS), `~/.config/com.au10tix.devopsboard` (Linux) |
| PAT / refresh token | OS credential store: Windows Credential Manager, macOS Keychain, or the Linux Secret Service (GNOME Keyring / KWallet). If no keyring is running on Linux, it falls back to `credentials.fallback.json` with `0600` permissions. |
| Board snapshot + change log | `board/` in the data folder (the same as the config folder on Windows and macOS, `~/.local/share/com.au10tix.devopsboard` on Linux) |
| Server port and browser token | `server.json` (and its `server.lock`) in the data folder |

**Sign out** removes the saved credentials from this computer.

## Pre-filling settings

To give the team a ready-to-go build, edit the defaults in `src/settings.rs` (`impl Default for Settings`) before building. Set `tenant_id` and `client_id` there and nobody has to type them.

Workstream grouping rules are in `ui/workstreams.js`.

## Building

You need [Rust](https://rustup.rs) (stable). On Linux, also `sudo apt install libdbus-1-dev pkg-config` for the keyring.

```sh
cargo run                # build and start the board
cargo build --release    # the program is target/release/azure-devops-board
```

The UI in `ui/` is plain HTML, CSS and JavaScript with no build step. It is embedded into the program at build time, so rebuild after changing it. There is no Node.js or npm step.

### Releasing (GitHub + Homebrew)

Each OS's program must be built on that OS, so releases are built in CI:

1. The workflow is `.github/workflows/release.yml`.
2. Add a deploy key with **write access** to `homebrew-azure-devops-board`, and store its private key as the repo secret `TAP_DEPLOY_KEY`. Without it, releases still build but the formula is not updated.
3. Tag and push: `git tag v2.0.0 && git push --tags`. Tags must be plain versions like `v2.0.0`.

The macOS job runs the tests, builds a universal binary and creates the release. The Linux and Windows builds come from `linux.yml` and `windows.yml`, which also run on every pull request as build checks, so a release builds exactly what PRs test. Each build starts the program and checks that it serves the board. Each platform attaches its own `SHA256SUMS` file, and each publish step checks that its files really landed on the release. The formula job then sets the new version and checksums in the Homebrew formula (`scripts/update-formula.sh`). To re-cut an existing tag, run the release workflow by hand from the Actions tab.

Builds are unsigned. Homebrew installs don't trigger Gatekeeper. If you download the macOS archive in a browser, clear the quarantine flag once: `xattr -d com.apple.quarantine azure-devops-board`.

## Testing

```sh
cargo test                                     # server checks, change tracking, sign-in, name parsing
scripts/smoke-test.sh target/debug/azure-devops-board  # start the program and check what it serves
MOCK_ADO_URL=http://127.0.0.1:9090 cargo test  # also exercises the Azure DevOps client against a fake server
```

## Project layout

```
ui/                board UI (HTML/CSS/JS), calls POST /api/<command> on the local server
src/
  main.rs          the command: options, single instance, opening the browser
  server.rs        local web server: embedded UI, API routes, request checks
  app.rs           the commands: settings, sign-in/out, load/refresh board, new tickets
  auth.rs          PAT + Entra ID (PKCE, loopback redirect, token refresh)
  board.rs         WIQL + workitemsbatch queries, creating work items, snapshot, change log
  secrets.rs       OS keychain storage (chunked for Windows limits)
  settings.rs      settings model and defaults
```
