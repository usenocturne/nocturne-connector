#!/bin/sh

rm "$OUTPUT_PATH"/*"$XBPS_ARCH"* 2> /dev/null || true

pigz -c "$IMAGE_PATH"/sdcard.img > "$OUTPUT_PATH"/nocturne-connector_"$XBPS_ARCH".img.gz
pigz -c "$IMAGE_PATH"/rootfs.ext4 > "$OUTPUT_PATH"/nocturne-connector_update_"$XBPS_ARCH".img.gz

cd "$OUTPUT_PATH"/ || exit 1
sha256sum nocturne-connector_"$XBPS_ARCH".img.gz > nocturne-connector_"$XBPS_ARCH".img.gz.sha256
sha256sum nocturne-connector_update_"$XBPS_ARCH".img.gz > nocturne-connector_update_"$XBPS_ARCH".img.gz.sha256
