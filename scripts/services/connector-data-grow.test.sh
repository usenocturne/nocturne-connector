#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SERVICE=${SCRIPT_DIR}/connector-data-grow.sh
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
TEST_LOG=${TEST_ROOT}/commands

# shellcheck source=connector-data-grow.sh
. "$SERVICE"

is_block_device() {
  return 0
}

ebegin() {
  :
}

eend() {
  return "$1"
}

blkid() {
  case "$2:${MOCK_LABEL:-data}:${MOCK_TYPE:-ext4}" in
    LABEL:*) printf '%s\n' "${MOCK_LABEL:-data}" ;;
    TYPE:*) printf '%s\n' "${MOCK_TYPE:-ext4}" ;;
    *) return 2 ;;
  esac
}

growpart() {
  printf 'growpart %s %s\n' "$1" "$2" >> "$TEST_LOG"
  if [ "${MOCK_GROWPART:-changed}" = nochange ]; then
    echo "NOCHANGE: partition 4 cannot be grown"
    return 1
  fi
  echo "CHANGED: partition 4 expanded"
}

e2fsck() {
  printf 'e2fsck %s %s\n' "$1" "$2" >> "$TEST_LOG"
}

resize2fs() {
  printf 'resize2fs %s\n' "$1" >> "$TEST_LOG"
}

run_start() {
  NOCTURNE_CONNECTOR_DATA_DISK=/test/disk
  NOCTURNE_CONNECTOR_DATA_PARTITION=/test/data
  export NOCTURNE_CONNECTOR_DATA_DISK NOCTURNE_CONNECTOR_DATA_PARTITION
  set +e
  start
  status=$?
  set -e
  return "$status"
}

: > "$TEST_LOG"
MOCK_GROWPART=changed run_start
grep -qx 'growpart /test/disk 4' "$TEST_LOG"
grep -qx 'e2fsck -pf /test/data' "$TEST_LOG"
grep -qx 'resize2fs /test/data' "$TEST_LOG"

: > "$TEST_LOG"
MOCK_GROWPART=nochange run_start
grep -qx 'growpart /test/disk 4' "$TEST_LOG"
grep -qx 'resize2fs /test/data' "$TEST_LOG"

: > "$TEST_LOG"
MOCK_LABEL=wrong
export MOCK_LABEL
if run_start; then
  echo "data grow accepted an unexpected filesystem label" >&2
  exit 1
fi
test ! -s "$TEST_LOG"
unset MOCK_LABEL

: > "$TEST_LOG"
MOCK_TYPE=xfs
export MOCK_TYPE
if run_start; then
  echo "data grow accepted a non-ext4 filesystem" >&2
  exit 1
fi
test ! -s "$TEST_LOG"
unset MOCK_TYPE

echo "connector-data-grow tests passed"
