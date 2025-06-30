#!/bin/sh

rm -f "$ROOTFS_PATH"/etc/motd
cp "$INPUT_PATH"/motd "$ROOTFS_PATH"/etc/motd
