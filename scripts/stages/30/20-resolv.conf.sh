#!/bin/sh

rm -f "$ROOTFS_PATH"/etc/resolv.conf
ln -fs /data/etc/resolv.conf "$ROOTFS_PATH"/etc/resolv.conf
