#!/bin/sh

rm -f "$ROOTFS_PATH"/etc/resolv.conf
ln -fs /tmp/resolv.conf "$ROOTFS_PATH"/etc/resolv.conf
