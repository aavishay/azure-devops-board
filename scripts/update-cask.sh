#!/usr/bin/env bash
# Sets the version and sha256 in the Homebrew cask.
# Usage: scripts/update-cask.sh <version> <path-to-dmg> [path-to-cask]
set -euo pipefail
VER="${1:?version, e.g. 1.0.1}"
DMG="${2:?path to the macOS .dmg}"
CASK="${3:-../homebrew-azure-devops-board/Casks/azure-devops-board.rb}"
if command -v sha256sum >/dev/null; then SHA=$(sha256sum "$DMG" | cut -d' ' -f1); else SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1); fi
# Portable in-place edit (GNU and BSD sed differ on -i).
tmp=$(mktemp)
sed -E \
  -e "s/^(  version )\"[^\"]*\"/\1\"$VER\"/" \
  -e "s/^(  sha256 ).*/\1\"$SHA\"/" \
  "$CASK" > "$tmp"
mv "$tmp" "$CASK"
echo "Updated $CASK to $VER ($SHA)"
