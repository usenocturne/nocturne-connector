#!/sbin/openrc-run
# shellcheck shell=ash
# shellcheck disable=SC2034

description="Mark the active U-Boot slot as successfully booted"

depend() {
  need localmount
  before connector-api
}

start() {
  ebegin "Resetting U-Boot boot counter"

  if [ ! -x /usr/sbin/uboot_tool ]; then
    ewarn "uboot_tool is missing"
    eend 0
    return 0
  fi

  if ! mountpoint -q /uboot; then
    ewarn "/uboot is not mounted"
    eend 0
    return 0
  fi

  mount -o remount,rw /uboot
  if ! /usr/sbin/uboot_tool reset_counter; then
    ewarn "Failed to reset U-Boot boot counter"
  fi
  sync
  mount -o remount,ro /uboot

  eend 0
}
