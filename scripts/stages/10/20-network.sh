#!/bin/sh

xbps-install -r "$ROOTFS_PATH" -y NetworkManager dbus nftables runit-nftables

echo "net.ipv4.ip_forward=1" >> "$ROOTFS_PATH"/etc/sysctl.conf
echo "net.ipv6.conf.all.forwarding=1" >> "$ROOTFS_PATH"/etc/sysctl.conf

echo "172.16.42.2 superbird" >> "$ROOTFS_PATH"/etc/hosts

rm -f "$ROOTFS_PATH"/etc/nftables.nft
cp "$RES_PATH"/config/nftables.nft "$ROOTFS_PATH"/etc/nftables.nft

echo "SUBSYSTEM==\"net\", ATTRS{idVendor}==\"0000\", ATTRS{idProduct}==\"1014\", NAME=\"usb0\"" > "$ROOTFS_PATH"/usr/lib/udev/rules.d/carthing.rules

cat > "$ROOTFS_PATH"/etc/NetworkManager/NetworkManager.conf << EOF
[main]
dhcp=internal
dns=default
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

rm -f "$ROOTFS_PATH"/etc/runit/runsvdir/default/dhcpcd

DEFAULT_SERVICES="${DEFAULT_SERVICES} NetworkManager dbus"
