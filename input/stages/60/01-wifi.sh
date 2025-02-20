#!/bin/sh

chroot_exec apk add wireless-tools wpa_supplicant wpa_supplicant-openrc
chroot_exec rc-update add wpa_supplicant default
chroot_exec rc-update add wpa_cli boot
echo "brcmfmac" >> "$ROOTFS_PATH"/etc/modules

cat >> "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder <<EOF

auto wlan0
iface wlan0 inet dhcp
EOF

cp "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder "$DATAFS_PATH"/etc/network/interfaces
