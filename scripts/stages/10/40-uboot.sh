#!/bin/sh

(
  cd "$WORK_PATH" || exit 1
  "$HELPERS_PATH"/gitlab_packages.sh -p "$UBOOT_PROJ_ID" -a u-boot-blob -d uboot
  "$HELPERS_PATH"/gitlab_packages.sh -p "$UBOOT_TOOL_PROJ_ID" -a uboot-tool
)

cp "$WORK_PATH"/uboot_tool "$ROOTFS_PATH"/usr/sbin/uboot_tool
chmod +x "$ROOTFS_PATH"/usr/sbin/uboot_tool

cp "$WORK_PATH"/uboot/* "$BOOTFS_PATH"/

mkimage -A arm64 -T script -C none -n "Boot script" -d "$RES_PATH"/config/boot.cmd "$BOOTFS_PATH"/boot.scr

cp "$RES_PATH"/config/config.txt "$BOOTFS_PATH"/config.txt
