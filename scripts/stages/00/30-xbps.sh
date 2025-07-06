#!/bin/sh

curl -L https://repo-default.voidlinux.org/live/current/void-aarch64-musl-ROOTFS-"$VOID_BUILD".tar.xz | tar -xJ -C "$ROOTFS_PATH"

xbps-install -r "$ROOTFS_PATH" -Suy xbps
xbps-install -r "$ROOTFS_PATH" -uy
xbps-install -r "$ROOTFS_PATH" --repository "$RES_PATH"/xbps -y base-nocturne-connector
xbps-remove -r "$ROOTFS_PATH" -Ry base-container-full
xbps-install -r "$ROOTFS_PATH" -y rpi-firmware rpi-kernel

"$HELPERS_PATH"/chroot_exec.sh /bin/sh -c "
  for util in \$(/usr/bin/busybox --list); do
    [ ! -f \"/usr/bin/\$util\" ] && /usr/bin/busybox ln -sfv busybox \"/usr/bin/\$util\"
  done
  install -dm1777 /tmp
  xbps-reconfigure -fa
"
