#!/bin/sh

cp "$INPUT_PATH"/connector-api "$ROOTFS_PATH"/usr/bin/connector-api
cp "$INPUT_PATH"/init.sh "$ROOTFS_PATH"/etc/init.d/connector-api

chroot_exec rc-update add connector-api default

mkdir "$ROOTFS_PATH"/etc/nocturne-connector
echo "1.0.0" > "$ROOTFS_PATH"/etc/nocturne-connector/version.txt
