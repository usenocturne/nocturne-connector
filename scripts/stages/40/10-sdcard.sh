#!/bin/sh

# boot
m4 -D xFS=vfat -D xIMAGE=boot.xFS -D xLABEL="BOOT" -D xSIZE="$SIZE_BOOT_FS" \
  "$RES_PATH"/m4/genimage.m4 > "$WORK_PATH"/genimage_boot.cfg
make_image "$BOOTFS_PATH" "$WORK_PATH"/genimage_boot.cfg

# root
m4 -D xFS=ext4 -D xIMAGE=rootfs.xFS -D xLABEL="rootfs" -D xSIZE="$SIZE_ROOT_FS" -D xUSEMKE2FS \
  "$RES_PATH"/m4/genimage.m4 > "$WORK_PATH"/genimage_root.cfg
make_image "$ROOTFS_PATH" "$WORK_PATH"/genimage_root.cfg

# data
m4 -D xFS=ext4 -D xIMAGE=datafs.xFS -D xLABEL="data" -D xSIZE="$SIZE_DATA_FS" -D xUSEMKE2FS \
  "$RES_PATH"/m4/genimage.m4 > "$WORK_PATH"/genimage_data.cfg
make_image "$DATAFS_PATH" "$WORK_PATH"/genimage_data.cfg

## create image
m4 -D xSIZE_ROOT="$SIZE_ROOT_FS" \
  "$RES_PATH"/m4/sdcard.m4 > "$WORK_PATH"/genimage_sdcard.cfg
make_image "$IMAGE_PATH" "$WORK_PATH"/genimage_sdcard.cfg
