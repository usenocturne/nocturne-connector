#!/usr/bin/env bash
set -euo pipefail

# Build a distributable, optionally notarized DMG for the Nocturne macOS connector.
#
# Usage:
#   scripts/build-macos-dmg.sh                   # Developer ID DMG + notarization
#   scripts/build-macos-dmg.sh --skip-notarize   # Developer ID DMG, no notary submit
#   scripts/build-macos-dmg.sh --local           # local ad-hoc DMG, no notary submit
#
# Env overrides:
#   SCHEME          Xcode scheme (default: "Nocturne")
#   TEAM_ID         Apple Developer team ID (default: A8CCNQDH4A)
#   NOTARY_PROFILE  notarytool keychain profile (default: nocturne-notary)

SKIP_NOTARIZE=0
LOCAL_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --local) LOCAL_BUILD=1; SKIP_NOTARIZE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT="${REPO_ROOT}/macos/Nocturne.xcodeproj"
SCHEME="${SCHEME:-Nocturne}"
APP_NAME="Nocturne"
TEAM_ID="${TEAM_ID:-A8CCNQDH4A}"
EXPORT_OPTIONS="${REPO_ROOT}/macos/ExportOptions.plist"
DMG_ASSETS_DIR="${REPO_ROOT}/macos/dmg-assets"
DMG_BACKGROUND="${DMG_ASSETS_DIR}/background.png"
DMG_SETTINGS="${DMG_ASSETS_DIR}/dmg-settings.py"
NOTARY_PROFILE="${NOTARY_PROFILE:-nocturne-notary}"

BUILD_DIR="${REPO_ROOT}/build/macos"
OUTPUT_DIR="${REPO_ROOT}/output"
ARCHIVE_PATH="${BUILD_DIR}/${APP_NAME}.xcarchive"
EXPORT_PATH="${BUILD_DIR}/export"
APP_PATH="${EXPORT_PATH}/${APP_NAME}.app"
DERIVED_DATA="${BUILD_DIR}/DerivedData"
DMG_VENV="${BUILD_DIR}/dmgvenv"

color() { printf "\033[0;36m%s\033[0m\n" "$1"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

has_developer_id() {
  security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"
}

check_notary_profile() {
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1
}

prepare_dmgbuild() {
  if [ ! -x "${DMG_VENV}/bin/dmgbuild" ]; then
    color "   (setting up dmgbuild venv)"
    python3 -m venv "$DMG_VENV"
    "${DMG_VENV}/bin/pip" install --quiet --upgrade pip dmgbuild
  fi
}

build_developer_id_app() {
  color ">> Archiving '${SCHEME}' (Release, Developer ID)"
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=macOS' \
    -archivePath "$ARCHIVE_PATH" \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="Developer ID Application" \
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
    ENABLE_HARDENED_RUNTIME=YES \
    archive

  color ">> Exporting Developer ID app"
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_PATH" \
    -exportOptionsPlist "$EXPORT_OPTIONS"
}

build_local_app() {
  color ">> Building '${SCHEME}' (Release, local ad-hoc signing)"
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" \
    -configuration Release \
    -destination 'platform=macOS' \
    -derivedDataPath "$DERIVED_DATA" \
    -skipPackagePluginValidation \
    -skipMacroValidation \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="-" \
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
    DEVELOPMENT_TEAM="" \
    ENABLE_HARDENED_RUNTIME=YES \
    build

  local built_app="${DERIVED_DATA}/Build/Products/Release/${APP_NAME}.app"
  [ -d "$built_app" ] || fail "Build produced no ${APP_NAME}.app at ${built_app}"
  mkdir -p "$EXPORT_PATH"
  ditto "$built_app" "$APP_PATH"
}

build_dmg() {
  [ -d "$APP_PATH" ] || fail "No ${APP_NAME}.app found at ${APP_PATH}"

  local version
  version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "${APP_PATH}/Contents/Info.plist")"
  local suffix=""
  if [ "$LOCAL_BUILD" -eq 1 ]; then
    suffix="-local"
  fi
  DMG_PATH="${OUTPUT_DIR}/${APP_NAME}-${version}${suffix}.dmg"
  rm -f "$DMG_PATH"

  color ">> Building DMG: $(basename "$DMG_PATH")"
  prepare_dmgbuild

  local bg_define=()
  if [ -f "$DMG_BACKGROUND" ]; then
    local bg_width
    bg_width="$(sips -g pixelWidth "$DMG_BACKGROUND" 2>/dev/null | awk '/pixelWidth/{print $2}')"
    if [ "${bg_width:-0}" -ge 1000 ]; then
      sips -z 400 660 "$DMG_BACKGROUND" --out "${BUILD_DIR}/dmg-bg-1x.png" >/dev/null 2>&1
      tiffutil -cathidpicheck "${BUILD_DIR}/dmg-bg-1x.png" "$DMG_BACKGROUND" \
        -out "${BUILD_DIR}/dmg-bg.tiff" >/dev/null 2>&1
      bg_define=(-D "bg=${BUILD_DIR}/dmg-bg.tiff")
    else
      bg_define=(-D "bg=${DMG_BACKGROUND}")
    fi
  else
    echo "  (no background.png in macos/dmg-assets/; building a plain window)" >&2
  fi

  "${DMG_VENV}/bin/dmgbuild" -s "$DMG_SETTINGS" \
    -D "app=${APP_PATH}" "${bg_define[@]}" \
    "$APP_NAME" "$DMG_PATH"
}

require_tool python3
require_tool xcodebuild
require_tool xcrun
require_tool security
[ -f "$DMG_SETTINGS" ] || fail "Missing DMG settings at ${DMG_SETTINGS}"

if [ "$LOCAL_BUILD" -eq 0 ]; then
  if ! has_developer_id; then
    fail "No 'Developer ID Application' certificate found. Install one or use --local for a non-notarizable test DMG."
  fi
  if [ "$SKIP_NOTARIZE" -eq 0 ] && ! check_notary_profile; then
    fail "No notarytool keychain profile '${NOTARY_PROFILE}'. Run: xcrun notarytool store-credentials ${NOTARY_PROFILE}"
  fi
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"
rm -rf "$ARCHIVE_PATH" "$EXPORT_PATH" "$DERIVED_DATA"

if [ "$LOCAL_BUILD" -eq 1 ]; then
  build_local_app
else
  build_developer_id_app
fi

build_dmg

if [ "$SKIP_NOTARIZE" -eq 1 ]; then
  color ">> Skipping notarization"
  if [ "$LOCAL_BUILD" -eq 1 ]; then
    echo "Local DMG ready (NOT Developer ID signed, NOT notarized): $DMG_PATH"
  else
    echo "Developer ID DMG ready (NOT notarized): $DMG_PATH"
  fi
  exit 0
fi

color ">> Notarizing (profile: ${NOTARY_PROFILE})"
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait

color ">> Stapling ticket"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

color ">> Finished"
echo "Notarized DMG: $DMG_PATH"
