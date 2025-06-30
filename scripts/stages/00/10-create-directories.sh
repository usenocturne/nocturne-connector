#!/bin/sh

(
  cd "$ROOTFS_PATH" || exit 1
  mkdir -p proc sys tmp run dev/pts dev/shm
  mkdir -p data uboot "$DATAFS_PATH"/etc "$DATAFS_PATH"/root "$DATAFS_PATH"/etc/network "$DATAFS_PATH"/var/lib "$DATAFS_PATH"/var/log
)
