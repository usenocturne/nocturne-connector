#!/bin/sh

"$HELPERS_PATH"/chroot_exec.sh apk add openssh

rm -f "$ROOTFS_PATH"/etc/motd "$ROOTFS_PATH"/etc/fstab
cp "$RES_PATH"/config/motd "$ROOTFS_PATH"/etc/motd
cp "$RES_PATH"/config/fstab "$ROOTFS_PATH"/etc/fstab

echo "$DEFAULT_HOSTNAME" > "$ROOTFS_PATH"/etc/hostname

root_pw=$(mkpasswd -m sha-512 -s "$DEFAULT_ROOT_PASSWORD")
sed -i "/^root/d" "$ROOTFS_PATH"/etc/shadow
echo "root:${root_pw}:19000:0:99999::::" >> "$ROOTFS_PATH"/etc/shadow

sed -i 's/^#PermitRootLogin prohibit-password/PermitRootLogin yes/' "$ROOTFS_PATH"/etc/ssh/sshd_config

sed -i 's/^#\(ttyS0::respawn:\/sbin\/getty -L 115200 ttyS0 vt100\)/\1/' "$ROOTFS_PATH"/etc/inittab

sed -i 's/^#rc_parallel="NO"/rc_parallel="YES"/' "$ROOTFS_PATH"/etc/rc.conf

DEFAULT_SERVICES="$DEFAULT_SERVICES sshd"
