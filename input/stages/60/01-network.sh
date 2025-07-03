#!/bin/sh

chroot_exec apk add wireless-tools wpa_supplicant wpa_supplicant-openrc nftables dropbear-dbclient eudev udev-init-scripts networkmanager networkmanager-cli

sed -i 's|default_conf=/etc/wpa_supplicant/wpa_supplicant.conf|default_conf=/data/etc/wpa_supplicant/wpa_supplicant.conf|' "$ROOTFS_PATH"/etc/init.d/wpa_supplicant
mkdir -p "$DATAFS_PATH"/etc/wpa_supplicant
cat > "$DATAFS_PATH"/etc/wpa_supplicant/wpa_supplicant.conf <<EOF
ctrl_interface=/run/wpa_supplicant
update_config=1
EOF

chroot_exec rc-update add wpa_supplicant default
chroot_exec rc-update add wpa_cli default
chroot_exec rc-update add nftables default
chroot_exec rc-update add udev sysinit
chroot_exec rc-update add udev-trigger sysinit
chroot_exec rc-update add udev-settle sysinit
chroot_exec rc-update add udev-postmount default

echo "brcmfmac" >> "$ROOTFS_PATH"/etc/modules

cat >> "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder <<EOF

auto wlan0
iface wlan0 inet dhcp
EOF

cp "$ROOTFS_PATH"/etc/network/interfaces.alpine-builder "$DATAFS_PATH"/etc/network/interfaces

echo "net.ipv4.ip_forward=1" >> "$ROOTFS_PATH"/etc/sysctl.conf
echo "net.ipv6.conf.all.forwarding=1" >> "$ROOTFS_PATH"/etc/sysctl.conf

echo "172.16.42.2 superbird" >> "$ROOTFS_PATH"/etc/hosts

rm -f "$ROOTFS_PATH"/etc/nftables.nft
cp "$INPUT_PATH"/nftables.nft "$ROOTFS_PATH"/etc/nftables.nft

echo "SUBSYSTEM==\"net\", ATTRS{idVendor}==\"0000\", ATTRS{idProduct}==\"1014\", NAME=\"usb0\"" > "$ROOTFS_PATH"/usr/lib/udev/rules.d/carthing.rules

cat > "$ROOTFS_PATH"/etc/NetworkManager/NetworkManager.conf << EOF
[main]
dhcp=internal
rc-manager=file
EOF

cat > "$ROOTFS_PATH"/etc/NetworkManager/system-connections/usb0.nmconnection << EOF
[connection]
id=usb0
type=ethernet
interface-name=usb0
autoconnect=true

[ipv4]
method=manual
address1=172.16.42.1/24
dns=1.1.1.1;8.8.8.8;
EOF
chmod 600 "$ROOTFS_PATH"/etc/NetworkManager/system-connections/usb0.nmconnection

echo "ENV{DEVTYPE}==\"gadget\", ENV{NM_UNMANAGED}=\"0\"" > "$ROOTFS_PATH"/usr/lib/udev/rules.d/98-network.rules

chroot_exec rc-update add networkmanager default
