#!/bin/sh

cp "$RES_PATH"/bins/ab_active.sh "$ROOTFS_PATH"/usr/sbin/ab_active
cp "$RES_PATH"/bins/ab_bootparam.sh "$ROOTFS_PATH"/usr/sbin/ab_bootparam
cp "$RES_PATH"/bins/ab_flash.sh "$ROOTFS_PATH"/usr/sbin/ab_flash

chmod +x "$ROOTFS_PATH"/usr/sbin/ab_active "$ROOTFS_PATH"/usr/sbin/ab_bootparam "$ROOTFS_PATH"/usr/sbin/ab_flash
