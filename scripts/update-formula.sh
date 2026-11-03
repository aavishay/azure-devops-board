#!/usr/bin/env bash
# Sets the version in each url and the sha256 after it in the Homebrew formula. The
# formula has no version line: brew audit rejects one the urls already give.
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
# Each sha256 line follows the url it belongs to; the version is the x.y.z in each url.
awk -v ver="$VER" -v mac="$MAC_SHA" -v linux="$LINUX_SHA" '
  /url "/ { gsub(/[0-9]+\.[0-9]+\.[0-9]+/, ver) }
  /url .*macos-universal/ { want = mac }
  /url .*linux-x86_64/ { want = linux }
  /sha256 "/ && want != "" { sub(/"[^"]*"/, "\"" want "\""); want = "" }
  { print }
' "$FORMULA" > "$tmp"
if ! grep -q "\"$MAC_SHA\"" "$tmp" || ! grep -q "\"$LINUX_SHA\"" "$tmp" \
  || grep 'url "' "$tmp" | grep -qv "/v$VER/azure-devops-board-$VER-"; then
  rm -f "$tmp"
  echo "Could not set the version in each url and a sha256 after it in $FORMULA" >&2
  exit 1
fi
cat "$tmp" > "$FORMULA" # keeps the file's permissions, which mv from mktemp would not
rm -f "$tmp"
echo "Updated $FORMULA to $VER (macOS $MAC_SHA, Linux $LINUX_SHA)"
