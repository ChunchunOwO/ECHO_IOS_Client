#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS because iOS builds require Xcode." >&2
  exit 1
fi

echo "Installing JavaScript dependencies..."
npm install

echo "Generating iOS native project..."
npx expo prebuild --platform ios --clean

if command -v pod >/dev/null 2>&1; then
  echo "Installing CocoaPods dependencies..."
  (cd ios && pod install)
fi

WORKSPACE="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
PROJECT="$(find ios -maxdepth 1 -name '*.xcodeproj' -print -quit)"

echo
echo "Open this in Xcode, select your free Apple ID Team, connect iPhone, then press Run:"
if [[ -n "${WORKSPACE:-}" ]]; then
  echo "$ROOT_DIR/$WORKSPACE"
  open "$WORKSPACE"
else
  echo "$ROOT_DIR/$PROJECT"
  open "$PROJECT"
fi
echo
echo "This installs directly to your phone with a free Apple ID. It usually expires after 7 days."
