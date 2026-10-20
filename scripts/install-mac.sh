#!/usr/bin/env bash
# Builds Azure DevOps Board on this Mac and installs it into /Applications.
# Use this before the first GitHub release exists; afterwards `brew install --cask azure-devops-board` is simpler.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"

# Homebrew's rustup is keg-only: its cargo/rustc proxies live under $(brew --prefix rustup)/bin.
if command -v brew >/dev/null; then
  brew list rustup >/dev/null 2>&1 || brew install rustup
  export PATH="$(brew --prefix rustup)/bin:$PATH"
elif ! command -v rustup >/dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"   # where `cargo install` puts tauri-cli

# Make sure a toolchain is installed (fresh rustup has none).
cargo --version >/dev/null 2>&1 || rustup default stable
echo "Using $(cargo --version)"

cargo tauri --version >/dev/null 2>&1 || cargo install tauri-cli --version "^2" --locked

cargo tauri build --bundles app
APP="target/release/bundle/macos/Azure DevOps Board.app"
rm -rf "/Applications/Azure DevOps Board.app"
cp -R "$APP" /Applications/
xattr -dr com.apple.quarantine "/Applications/Azure DevOps Board.app" 2>/dev/null || true
echo "Installed /Applications/Azure DevOps Board.app"
open "/Applications/Azure DevOps Board.app"
