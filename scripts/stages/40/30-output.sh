#!/bin/sh

echo
color_echo ">> Uncompressed Sizes"
color_echo "size of boot partition: $SIZE_BOOT_FS ($(du -sh "$BOOTFS_PATH" | sed "s/\s.*//") used)\n" -Yellow
color_echo "size of root partition: $SIZE_ROOT_FS ($(du -sh "$ROOTFS_PATH" | sed "s/\s.*//") used)\n" -Yellow
color_echo "size of data partition: $SIZE_DATA_FS ($(du -sh "$DATAFS_PATH" | sed "s/\s.*//") used)\n" -Yellow

color_echo ">> Compressed Sizes"
color_echo "size of sdcard image: $(du -sh "$OUTPUT_PATH"/nocturne-connector.img.gz | sed "s/\s.*//")" -Yellow
color_echo "size of update: $(du -sh "$OUTPUT_PATH"/nocturne-connector_update.img.gz | sed "s/\s.*//")\n" -Yellow

color_echo "$WORK_PATH" -Yellow
echo
