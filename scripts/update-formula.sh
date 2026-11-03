#!/usr/bin/env bash
# Sets the version and both sha256s in the Homebrew formula.
# Usage: scripts/update-formula.sh <version> <macos .tar.gz> <linux .tar.gz> [path-to-formula]
set -euo pipefail
VER="${1:?version, e.g. 2.0.1}"
MAC="${2:?path to the macOS .tar.gz}"
LINUX="${3:?path to the Linux .tar.gz}"
FORMULA="${4:-../homebrew-azure-devops-board/Formula/azure-devops-board.rb}"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
MAC_SHA=$(sha "$MAC")
LINUX_SHA=$(sha "$LINUX")
tmp=$(mktemp)
# Each sha256 line follows the url it belongs to.
awk -v ver="$VER" -v mac="$MAC_SHA" -v linux="$LINUX_SHA" '
  /^  version "/ { sub(/"[^"]*"/, "\"" ver "\"") }
  /url .*macos-universal/ { want = mac }
  /url .*linux-x86_64/ { want = linux }
  /sha256 "/ && want != "" { sub(/"[^"]*"/, "\"" want "\""); want = "" }
  { print }
' "$FORMULA" > "$tmp"
if ! grep -q "\"$MAC_SHA\"" "$tmp" || ! grep -q "\"$LINUX_SHA\"" "$tmp"; then
  rm -f "$tmp"
  echo "Could not find a sha256 line after each url in $FORMULA" >&2
  exit 1
fi
cat "$tmp" > "$FORMULA" # keeps the file's permissions, which mv from mktemp would not
rm -f "$tmp"
echo "Updated $FORMULA to $VER (macOS $MAC_SHA, Linux $LINUX_SHA)"
