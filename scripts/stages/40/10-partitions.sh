#!/bin/sh

# boot
rsync -a "$WORK_PATH"/kernel/boot/ "$BOOTFS_PATH"/
cp "$RES_PATH"/config/cmdline.txt "$BOOTFS_PATH"/
m4 "$RES_PATH"/m4/config.txt.m4 > "$BOOTFS_PATH"/config.txt
mkimage -A arm64 -T script -C none -n "Nocturne Connector A/B boot" \
  -d "$RES_PATH"/m4/boot.cmd.m4 "$BOOTFS_PATH"/boot.scr

m4 -D xFS=vfat -D xIMAGE=boot.xFS -D xLABEL="BOOT" -D xSIZE="$SIZE_BOOT" \
  -D xEXTRAARGS="-F 32 -h 8192" \
  "$RES_PATH"/m4/genimage.m4 > "$WORK_PATH"/genimage_boot.cfg
make_image "$BOOTFS_PATH" "$WORK_PATH"/genimage_boot.cfg

# root
mkdir -p "$ROOTFS_PATH"/lib/modules
cp -r "$WORK_PATH"/kernel/lib/modules/* "$ROOTFS_PATH"/lib/modules/
mkdir -p "$ROOTFS_PATH"/boot
rsync -a "$WORK_PATH"/kernel/boot/ "$ROOTFS_PATH"/boot/

m4 -D xFS=ext4 -D xIMAGE=rootfs.xFS -D xLABEL="rootfs" -D xSIZE="$SIZE_ROOT" -D xUSEMKE2FS \
  "$RES_PATH"/m4/genimage.m4 > "$WORK_PATH"/genimage_root.cfg
make_image "$ROOTFS_PATH" "$WORK_PATH"/genimage_root.cfg

# data
m4 -D xFS=ext4 -D xIMAGE=datafs.xFS -D xLABEL="data" -D xSIZE="$SIZE_DATA" -D xUSEMKE2FS \
  "$RES_PATH"/m4/genimage.m4 > "$WORK_PATH"/genimage_data.cfg
make_image "$DATAFS_PATH" "$WORK_PATH"/genimage_data.cfg
