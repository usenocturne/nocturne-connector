#!/bin/sh

m4 -D xSIZE_ROOT="$SIZE_ROOT" \
  "$RES_PATH"/m4/sdcard.m4 > "$WORK_PATH"/genimage_sdcard.cfg
make_image "$IMAGE_PATH" "$WORK_PATH"/genimage_sdcard.cfg
