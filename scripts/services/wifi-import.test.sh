#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SERVICE=${SCRIPT_DIR}/wifi-import.sh
TEST_ROOT=$(mktemp -d)
trap 'command rm -rf "$TEST_ROOT"' EXIT
TEST_LOG=${TEST_ROOT}/commands

# shellcheck source=wifi-import.sh
. "$SERVICE"

ebegin() { :; }
einfo() { :; }
eerror() { :; }
eend() { return "$1"; }
find_wifi_config() { echo "${MOCK_SRC:-/uboot/wpa_supplicant.conf}"; }
mkdir() { :; }
mount() {
  printf 'mount %s\n' "$*" >> "$TEST_LOG"
}
grep() { return 0; }
sed() { :; }
ln() { :; }
cp() {
  printf 'cp %s %s\n' "$1" "$2" >> "$TEST_LOG"
  return "${MOCK_CP_STATUS:-0}"
}
rm() {
  printf 'rm %s\n' "$*" >> "$TEST_LOG"
}

: > "$TEST_LOG"
MOCK_CP_STATUS=1
if start; then
  echo "expected start to fail when the WiFi config cannot be copied" >&2
  exit 1
fi
if command grep -q '^rm -f /uboot/wpa_supplicant.conf$' "$TEST_LOG"; then
  echo "boot partition WiFi config was deleted after a failed import" >&2
  exit 1
fi

: > "$TEST_LOG"
MOCK_CP_STATUS=0
start
command grep -q '^rm -f /uboot/wpa_supplicant.conf$' "$TEST_LOG"


: > "$TEST_LOG"
MOCK_SRC=/boot/wpa_supplicant.conf
start
command grep -q '^mount -o remount,rw /boot$' "$TEST_LOG"
command grep -q '^rm -f /boot/wpa_supplicant.conf$' "$TEST_LOG"
command grep -q '^mount -o remount,ro /boot$' "$TEST_LOG"
if command grep -q '/uboot' "$TEST_LOG"; then
  echo "remounted /uboot for a config found under /boot" >&2
  exit 1
fi

echo "wifi-import tests passed"
