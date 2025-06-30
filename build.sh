#!/usr/bin/env bash
set -e

# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
# Image build config
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
: "${CONNECTOR_IMAGE_VERSION:="v3.0.0-beta3"}"

: "${UBOOT_PROJ_ID:="32838267"}"
: "${UBOOT_TOOL_PROJ_ID:="33098050"}"

: "${VOID_BUILD:="20250202"}"

# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
# System config
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
: "${DEFAULT_HOSTNAME:="nocturne-connector"}"
: "${DEFAULT_ROOT_PASSWORD:="nocturne"}"
: "${DEFAULT_SERVICES:=""}"

: "${SIZE_BOOT_FS:="128M"}"
: "${SIZE_ROOT_FS:="1024M"}"
: "${SIZE_DATA_FS:="512M"}"

: "${STAGES:="00 10 20 30 40"}"

# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
# Static config
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
REQUIRED_CMDS=(curl zip unzip genimage m4 xbps-install mkpasswd mkimage mkdosfs mcopy)
for cmd in "${REQUIRED_CMDS[@]}"; do
  if ! command -v "$cmd" > /dev/null 2>&1; then
    echo "$cmd is required to run this script."
    exit 1
  fi
done

SAVED_PWD="$(pwd)"

WORK_PATH=$(mktemp -d)
export BOOTFS_PATH="${WORK_PATH}/bootfs"
export ROOTFS_PATH="${WORK_PATH}/rootfs"
export DATAFS_PATH="${WORK_PATH}/datafs"
IMAGE_PATH="${WORK_PATH}/img"
export OUTPUT_PATH="${SAVED_PWD}/output"
export CACHE_PATH="${SAVED_PWD}/cache"

export SCRIPTS_PATH="${SAVED_PWD}/scripts"
export HELPERS_PATH="${SAVED_PWD}/scripts/build-helpers"
export M4_PATH="${SAVED_PWD}/m4"
export RES_PATH="${SAVED_PWD}/resources"
DEF_STAGE_PATH="${SAVED_PWD}/scripts/stages"

mkdir -p "$IMAGE_PATH" "$BOOTFS_PATH" "$ROOTFS_PATH" "$DATAFS_PATH" "$OUTPUT_PATH" "$CACHE_PATH"

# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
# Arguments
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
while getopts "68" OPTS; do
  case ${OPTS} in
    6) ARMV6="true" ;;
    8) ARMV8="true" ;;
    *) usage ;;
  esac
done

if [ -z "$ARMV6" ] && [ -z "$ARMV8" ]; then
  ARMV6="true"
  ARMV8="true"
fi

# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
# Functions
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
make_image() {
  [ -d /tmp/genimage ] && rm -rf /tmp/genimage
  genimage --rootpath "$1" \
    --tmppath /tmp/genimage \
    --inputpath "${IMAGE_PATH}" \
    --outputpath "${IMAGE_PATH}" \
    --config "$2"
}

color_echo() {
  ColourOff='\033[0m'
  Prefix='\033[0;'
  Index=31
  Colours_Name="Red Green Yellow Blue Purple Cyan White"
  COLOUR="Green"
  Text=""

  while [ $# -gt 0 ]; do
    if echo "$1" | grep -q "^-"; then
      COLOUR="${1#-}"
    else
      Text="$1"
    fi
    shift
  done

  for col in ${Colours_Name}; do
    [ "$col" = "$COLOUR" ] && break
    Index=$((Index + 1))
  done

  printf "%b\n" "${Prefix}${Index}m${Text}${ColourOff}"
}

run_stage_scripts() {
  for S in "${DEF_STAGE_PATH}/$1"/*.sh; do
    _sname=$(basename "$S")
    [ "$_sname" = "*.sh" ] && break
    [ "$_sname" = "00-echo.sh" ] || color_echo "  Stage $1 - Running $_sname" -Cyan
    # shellcheck disable=SC1090
    . "$S"
  done
}

# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
# Stage 00 - Prepare root FS
# Stage 10 - Configure system
# Stage 20 - Nocturne configuration
# Stage 30 - Cleanup
# Stage 40 - Create images
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #

if [ -n "$ARMV6" ]; then
    export XBPS_ARCH="armv6l"

    for _stage in ${STAGES}; do
        run_stage_scripts "$_stage"
    done
    
    color_echo ">> Finished armv6 <<"
fi

if [ -n "$ARMV8" ]; then
    export XBPS_ARCH="aarch64"

    for _stage in ${STAGES}; do
        run_stage_scripts "$_stage"
    done

    color_echo ">> Finished armv8 <<"
fi
