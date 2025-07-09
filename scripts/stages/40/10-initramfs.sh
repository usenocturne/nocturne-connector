#!/bin/sh

rm "$OUTPUT_PATH"/initramfs.cpio.zst 2> /dev/null || true

cp "$SCRIPTS_PATH"/init.sh "$ROOTFS_PATH"/init
chmod +x "$ROOTFS_PATH"/init

mkdir -p "$ROOTFS_PATH"/lib/modules
cp -r "$RES_PATH"/stock-files/output/root/lib/modules/* "$ROOTFS_PATH"/lib/modules/

cd "$ROOTFS_PATH" || exit 1
find . -print0 | cpio --null -ov --format=newc | zstd -19 -o "$OUTPUT_PATH"/initramfs.cpio.zst
