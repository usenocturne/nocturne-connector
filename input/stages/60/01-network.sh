#!/bin/sh

chroot_exec apk add wireless-tools wpa_supplicant wpa_supplicant-openrc nftables dropbear-dbclient

sed -i 's|default_conf=/etc/wpa_supplicant/wpa_supplicant.conf|default_conf=/data/etc/wpa_supplicant/wpa_supplicant.conf|' "$ROOTFS_PATH"/etc/init.d/wpa_supplicant
mkdir -p "$DATAFS_PATH"/etc/wpa_supplicant
cat > "$DATAFS_PATH"/etc/wpa_supplicant/wpa_supplicant.conf <<EOF
ctrl_interface=/run/wpa_supplicant
update_config=1
EOF

chroot_exec rc-update add wpa_supplicant default
chroot_exec rc-update add wpa_cli default
chroot_exec rc-update add nftables boot

echo "brcmfmac" >> "$ROOTFS_PATH"/etc/modules

cat >> "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder <<EOF

auto wlan0
iface wlan0 inet dhcp

auto usb0
allow-hotplug usb0
iface usb0 inet static
    address 172.16.42.1
    netmask 255.255.255.0

auto eth1
allow-hotplug eth1
iface eth1 inet static
    address 172.16.42.1
    netmask 255.255.255.0
EOF

cp "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder "$DATAFS_PATH"/etc/network/interfaces

echo "net.ipv4.ip_forward=1" >> "$ROOTFS_PATH"/etc/sysctl.conf
echo "net.ipv6.conf.all.forwarding=1" >> "$ROOTFS_PATH"/etc/sysctl.conf

echo "172.16.42.2 superbird" >> "$ROOTFS_PATH"/etc/hosts

rm -f "$ROOTFS_PATH"/etc/nftables.nft
cp "$INPUT_PATH"/nftables.nft "$ROOTFS_PATH"/etc/nftables.nft
