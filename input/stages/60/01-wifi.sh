#!/bin/sh

chroot_exec apk add wireless-tools wpa_supplicant wpa_supplicant-openrc

sed -i 's|default_conf=/etc/wpa_supplicant/wpa_supplicant.conf|default_conf=/data/etc/wpa_supplicant/wpa_supplicant.conf|' "$ROOTFS_PATH"/etc/init.d/wpa_supplicant
mkdir -p "$DATAFS_PATH"/etc/wpa_supplicant
cat > "$DATAFS_PATH"/etc/wpa_supplicant/wpa_supplicant.conf <<EOF
ctrl_interface=/run/wpa_supplicant
update_config=1
EOF

chroot_exec rc-update add wpa_supplicant default
chroot_exec rc-update add wpa_cli default

echo "brcmfmac" >> "$ROOTFS_PATH"/etc/modules

cat >> "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder <<EOF

auto wlan0
iface wlan0 inet dhcp
EOF

cp "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder "$DATAFS_PATH"/etc/network/interfaces
