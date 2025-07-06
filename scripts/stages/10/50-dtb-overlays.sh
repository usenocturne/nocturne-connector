#!/bin/sh

cp -a "$ROOTFS_PATH"/boot/* "$BOOTFS_PATH"/

echo "console=serial0,115200 console=tty1 root=/dev/mmcblk0p2 rootfstype=ext4 fsck.repair=yes ro rootwait quiet net.ifnames=0" > "$BOOTFS_PATH"/cmdline.txt