#!/bin/sh
set -e

image_file="$1"

if [ -z "$image_file" ]; then
  echo "USAGE: $0 IMAGE_PATH" >&2
  exit 1
fi

if [ "$image_file" != "-" ]; then
  cd "$(dirname "$image_file")"
  sha256sum -c "$(basename "$image_file").sha256"
fi

current_idx=$(ab_bootparam root | grep -Eo '[0-9]+$')
uboot_idx=$(uboot_tool part_current)

ab_active

if [ "$current_idx" -eq 2 ]; then
  flash_idx=3
  echo "Start update for partition B"
else
  flash_idx=2
  echo "Start update for partition A"
fi

flash_device="$(ab_bootparam root | sed -E "s/[0-9]+$/${flash_idx}/")"
echo "Flashing: $flash_device"

if [ "$image_file" = "-" ]; then
  gunzip -c | dd of="$flash_device" status=progress bs=2M iflag=fullblock
else
  gunzip -c "$image_file" | dd of="$flash_device" status=progress bs=2M iflag=fullblock
fi

if [ "$current_idx" != "$uboot_idx" ]; then
  echo "U-Boot already points at the inactive partition"
else
  mount -o remount,rw /uboot
  uboot_tool part_switch
  sync
  mount -o remount,ro /uboot
fi

echo "Update complete; reboot to switch slots"
