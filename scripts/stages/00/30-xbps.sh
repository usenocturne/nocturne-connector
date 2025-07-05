#!/bin/sh

curl -L https://repo-default.voidlinux.org/live/current/void-rpi-"$XBPS_ARCH"-musl-PLATFORMFS-"$VOID_BUILD".tar.xz | tar -xJ -C "$ROOTFS_PATH"

xbps-install -r "$ROOTFS_PATH" -Suy xbps
xbps-install -r "$ROOTFS_PATH" -uy
xbps-install -r "$ROOTFS_PATH" -y ifupdown-ng util-linux rng-tools

DEFAULT_SERVICES="${DEFAULT_SERVICES} rngd"
