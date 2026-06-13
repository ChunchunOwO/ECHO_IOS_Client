#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS because iOS builds require Xcode." >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild not found. Install Xcode from the App Store first." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Install Node.js first." >&2
  exit 1
fi

echo "Installing JavaScript dependencies..."
npm install

echo "Generating iOS native project..."
npx expo prebuild --platform ios --clean

if command -v pod >/dev/null 2>&1; then
  echo "Installing CocoaPods dependencies..."
  (cd ios && pod install)
else
  echo "CocoaPods not found. Expo may have installed pods during prebuild; continuing." >&2
fi

WORKSPACE="$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)"
PROJECT="$(find ios -maxdepth 1 -name '*.xcodeproj' -print -quit)"
BUILD_DIR="$ROOT_DIR/build/ios-unsigned"
ARCHIVE_ROOT="$BUILD_DIR/archive"
PAYLOAD_DIR="$BUILD_DIR/Payload"
IPA_PATH="$BUILD_DIR/ECHO-iPhone-unsigned.ipa"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

if [[ -n "${WORKSPACE:-}" ]]; then
  LIST_JSON="$(xcodebuild -workspace "$WORKSPACE" -list -json)"
  BUILD_TARGET_ARGS=(-workspace "$WORKSPACE")
else
  LIST_JSON="$(xcodebuild -project "$PROJECT" -list -json)"
  BUILD_TARGET_ARGS=(-project "$PROJECT")
fi

SCHEME="$(node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const schemes=(data.workspace||data.project||{}).schemes||[]; console.log(schemes[0]||"")' <<< "$LIST_JSON")"

if [[ -z "$SCHEME" ]]; then
  echo "Could not detect an Xcode scheme." >&2
  exit 1
fi

echo "Building unsigned iphoneos app with scheme: $SCHEME"
xcodebuild \
  "${BUILD_TARGET_ARGS[@]}" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath "$BUILD_DIR/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

APP_PATH="$(find "$BUILD_DIR/DerivedData/Build/Products/Release-iphoneos" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$APP_PATH" ]]; then
  echo "Could not find built .app output." >&2
  exit 1
fi

mkdir -p "$PAYLOAD_DIR"
cp -R "$APP_PATH" "$PAYLOAD_DIR/"
(cd "$BUILD_DIR" && /usr/bin/zip -qry "$IPA_PATH" Payload)

echo
echo "Unsigned IPA created:"
echo "$IPA_PATH"
echo
echo "Install path:"
echo "1. Open Sideloadly on Windows or macOS."
echo "2. Select this IPA."
echo "3. Sign/install with a free Apple ID."
echo "4. On iPhone, trust the Apple ID profile in Settings > General > VPN & Device Management."
echo
echo "Free Apple ID signing usually expires after 7 days."
