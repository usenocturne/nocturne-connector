#!/bin/sh

FS_FILE="/tmp/boot.img"
STAGE_DIR="$(mktemp -d)"
MNT_DIR="$(mktemp -d)"

rm -f "$FS_FILE"

cp "$OUTPUT_PATH/initramfs.cpio.zst" "$STAGE_DIR"/
cp "$RES_PATH/config/cmdline.txt" "$RES_PATH/config/config.txt" "$STAGE_DIR"/
rsync -a "$RES_PATH/stock-files/output/boot/" "$STAGE_DIR"/

CONTENT_SIZE_BYTES=$(du -sb "$STAGE_DIR" | awk '{print $1}')
OVERHEAD_BYTES=$((5 * 1024 * 1024))
TOTAL_SIZE_BYTES=$((CONTENT_SIZE_BYTES + OVERHEAD_BYTES))
TOTAL_SIZE_MIB=$(awk "BEGIN {printf \"%d\", ($TOTAL_SIZE_BYTES / (1024*1024)) + 1}")
echo "Total size: $TOTAL_SIZE_MIB"

#

dd if=/dev/zero of="$FS_FILE" bs=1M count="$TOTAL_SIZE_MIB"
mkfs.vfat -F 32 "$FS_FILE"

mount -o loop "$FS_FILE" "$MNT_DIR"
rsync -a "$STAGE_DIR/" "$MNT_DIR/"
ls "$MNT_DIR"

umount "$MNT_DIR"
rmdir "$MNT_DIR"
rm -rf "$STAGE_DIR"
mv "$FS_FILE" "$OUTPUT_PATH"/boot.img
