#!/bin/sh

rm "$OUTPUT_PATH"/* 2> /dev/null || true

pigz -c "$IMAGE_PATH"/sdcard.img > "$OUTPUT_PATH"/nocturne-connector.img.gz
pigz -c "$IMAGE_PATH"/rootfs.ext4 > "$OUTPUT_PATH"/nocturne-connector_update.img.gz

cd "$OUTPUT_PATH"/ || exit 1
sha256sum nocturne-connector.img.gz > nocturne-connector.img.gz.sha256
sha256sum nocturne-connector_update.img.gz > nocturne-connector_update.img.gz.sha256
