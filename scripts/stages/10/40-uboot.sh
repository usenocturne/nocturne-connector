#!/bin/sh

(
  cd "$WORK_PATH" || exit 1
  "$HELPERS_PATH"/gitlab_packages.sh -p "$UBOOT_PROJ_ID" -a u-boot-blob -d uboot
  "$HELPERS_PATH"/gitlab_packages.sh -p "$UBOOT_TOOL_PROJ_ID" -a uboot-tool
)

cp "$WORK_PATH"/uboot_tool "$ROOTFS_PATH"/usr/sbin/uboot_tool
chmod +x "$ROOTFS_PATH"/usr/sbin/uboot_tool

cp "$WORK_PATH"/uboot/* "$BOOTFS_PATH"/

case "$XBPS_ARCH" in
  aarch64)
    A=arm64
    ;;
  *)
    A=arm
    ;;
esac

mkimage -A "$A" -T script -C none -n "Boot script" -d "$RES_PATH"/config/boot.cmd "$BOOTFS_PATH"/boot.scr

eval m4 -D xARCH="$XBPS_ARCH" "$RES_PATH"/m4/config.txt.m4 > "$BOOTFS_PATH"/config.txt

echo "console=serial0,115200 console=tty1 root=/dev/root rootfstype=ext4 fsck.repair=yes ro rootwait quiet" > "$BOOTFS_PATH"/cmdline.txt
