#!/bin/sh

(
  cd "$ROOTFS_PATH" || exit 1
  mkdir -p proc sys tmp run dev/pts dev/shm boot data uboot
  mkdir -p "$DATAFS_PATH"/etc/wpa_supplicant
  mkdir -p "$DATAFS_PATH"/nocturne-connector "$DATAFS_PATH"/root "$DATAFS_PATH"/var/lib "$DATAFS_PATH"/var/log
)
