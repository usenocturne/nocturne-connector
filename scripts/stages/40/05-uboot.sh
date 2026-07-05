#!/bin/sh

download_gitlab_package() {
  proj="$1"
  artifact="$2"
  dest="$3"
  version="$4"

  rm -rf "$dest"
  mkdir -p "$dest"

  tmpdir=$(mktemp -d)
  if [ -n "$version" ]; then
    (cd "$tmpdir" && "$HELPERS_PATH"/gitlab_packages.sh -p "$proj" -a "$artifact" -v "$version" -d "$dest")
  else
    (cd "$tmpdir" && "$HELPERS_PATH"/gitlab_packages.sh -p "$proj" -a "$artifact" -d "$dest")
  fi
  rm -rf "$tmpdir"
}

UBOOT_POSTFIX=""
[ -n "$UBOOT_PACKAGE" ] && UBOOT_POSTFIX="-$UBOOT_PACKAGE"

UBOOT_CACHE="$CACHE_PATH/uboot${UBOOT_POSTFIX}${UBOOT_VERSION:+-$UBOOT_VERSION}"
UBOOT_TOOL_CACHE="$CACHE_PATH/uboot-tool"

if [ ! -f "$UBOOT_CACHE/u-boot_rpi-64.bin" ]; then
  color_echo "  Fetching U-Boot artifacts" -Cyan
  download_gitlab_package "$UBOOT_PROJ_ID" "u-boot${UBOOT_POSTFIX}-blob" "$UBOOT_CACHE" "$UBOOT_VERSION"
fi

if [ ! -f "$UBOOT_TOOL_CACHE/uboot_tool" ]; then
  color_echo "  Fetching U-Boot tool" -Cyan
  download_gitlab_package "$UBOOT_TOOL_PROJ_ID" "uboot-tool" "$UBOOT_TOOL_CACHE" ""
fi

cp "$UBOOT_CACHE"/* "$BOOTFS_PATH"/
install -m 755 "$UBOOT_TOOL_CACHE"/uboot_tool "$ROOTFS_PATH"/usr/sbin/uboot_tool
