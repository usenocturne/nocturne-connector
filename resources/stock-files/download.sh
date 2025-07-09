#!/usr/bin/env bash
set -e
set -x

: "${FIRMWARE_RELEASE:="bookworm"}"
: "${FIRMWARE_DATE:="2025-05-13"}"

WORK_PATH=$(mktemp -d)
BOOT_MNT_PATH="$WORK_PATH/boot"
ROOT_MNT_PATH="$WORK_PATH/root"
EXTRACT_PATH="$WORK_PATH/extract"
OUTPUT_PATH="$(pwd)/output"

LOOP_DEV=""

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root."
    exit 1
fi

cleanup() {
  if mountpoint -q "${BOOT_MNT_PATH}"; then
    sudo umount "${BOOT_MNT_PATH}"
  fi
  if mountpoint -q "${ROOT_MNT_PATH}"; then
    sudo umount "${ROOT_MNT_PATH}"
  fi
  if [ -n "$LOOP_DEV" ]; then
    sudo losetup -d "$LOOP_DEV"
  fi
  rm -rf "${WORK_PATH}"
}
trap cleanup EXIT

REQUIRED_CMDS=(curl unxz parted losetup)
for cmd in "${REQUIRED_CMDS[@]}"; do
  if ! command -v "$cmd" > /dev/null 2>&1; then
    echo "$cmd is required to run this script."
    exit 1
  fi
done

########################

FIRMWARE_URL="https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-$FIRMWARE_DATE/$FIRMWARE_DATE-raspios-$FIRMWARE_RELEASE-arm64-lite.img.xz"
FIRMWARE_BASENAME=$(basename "$FIRMWARE_URL")
FIRMWARE_FILE="${WORK_PATH}/${FIRMWARE_BASENAME}"

echo "Downloading ${FIRMWARE_URL}"
curl -Lo "$FIRMWARE_FILE" "$FIRMWARE_URL"

echo "Unzipping firmware"
rm "$EXTRACT_PATH"/* 2> /dev/null || true
mkdir -p "$EXTRACT_PATH"
unxz -c "$FIRMWARE_FILE" > "$EXTRACT_PATH"/firmware.img

echo "Mounting boot partition"
BOOT_PART_INFO=$(parted "$EXTRACT_PATH"/firmware.img unit b --machine print | awk -F: '$1 == "1" {print $2}')
BOOT_PART_START="${BOOT_PART_INFO//B/}"
BOOT_LOOP_DEV=$(losetup --find --show --offset "$BOOT_PART_START" "$EXTRACT_PATH"/firmware.img)

ROOT_PART_INFO=$(parted "$EXTRACT_PATH"/firmware.img unit b --machine print | awk -F: '$1 == "2" {print $2}')
ROOT_PART_START="${ROOT_PART_INFO//B/}"
ROOT_LOOP_DEV=$(losetup --find --show --offset "$ROOT_PART_START" "$EXTRACT_PATH"/firmware.img)

mkdir -p "$BOOT_MNT_PATH" "$ROOT_MNT_PATH"
mount "$BOOT_LOOP_DEV" "$BOOT_MNT_PATH"
mount "$ROOT_LOOP_DEV" "$ROOT_MNT_PATH"

echo "Copying files"
rm "$OUTPUT_PATH"/* 2> /dev/null || true

(
  mkdir -p "$OUTPUT_PATH"
  cd "$OUTPUT_PATH" || exit 1
  mkdir -p boot root
)

cp -r "$BOOT_MNT_PATH"/* "$OUTPUT_PATH"/boot/
rm "$OUTPUT_PATH"/boot/initramfs* "$OUTPUT_PATH"/boot/issue.txt "$OUTPUT_PATH"/boot/cmdline.txt "$OUTPUT_PATH"/boot/config.txt "$OUTPUT_PATH"/boot/kernel_2712.img

mkdir -p "$OUTPUT_PATH"/root/lib/modules
cp -r "$ROOT_MNT_PATH"/lib/modules/* "$OUTPUT_PATH"/root/lib/modules
rm -rf "$OUTPUT_PATH"/root/lib/modules/*rpi-2712
rm -rf "$OUTPUT_PATH"/root/lib/modules/*/kernel/{fs,sound,lib}
rm -rf "$OUTPUT_PATH"/root/lib/modules/*/kernel/drivers/{ata,auxdisplay,accessibility,base,bcma,block,bluetooth,cdrom,clk,connector,gpu,hid,iio,input,i2c,leds,md,mfd,mmc,mtd,mux,nvmem,pinctrl,pps,rtc,scsi,spi,ssb,staging,uio,vhost,video,w1}
rm -rf "$OUTPUT_PATH"/root/lib/modules/*/kernel/drivers/media/{cec,common,dvb-core,dvb-frontends,i2c,mc,pci,radio,rc,spi,test-drivers,tuners,v4l2-core}

chown -R root:root "$OUTPUT_PATH"/*

echo "Done!"