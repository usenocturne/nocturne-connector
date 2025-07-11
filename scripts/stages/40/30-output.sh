#!/bin/sh

echo
color_echo ">> Uncompressed Sizes"
color_echo "used on rootfs: $(du -sh "$ROOTFS_PATH" | sed "s/\s.*//")" -Yellow
echo

color_echo ">> Compressed Sizes"
color_echo "size of initramfs: $(du -sh "$OUTPUT_PATH"/initramfs.cpio.zst | sed "s/\s.*//")" -Yellow
color_echo "size of connector image: $(du -sh "$OUTPUT_PATH"/connector.img | sed "s/\s.*//")" -Yellow
echo

color_echo "$WORK_PATH" -Yellow
echo
