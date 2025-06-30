#!/bin/sh

xbps-install -r "$ROOTFS_PATH" -y NetworkManager dhclient

DEFAULT_SERVICES="${DEFAULT_SERVICES} NetworkManager"
