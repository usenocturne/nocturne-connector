#!/sbin/openrc-run
# shellcheck shell=ash
# shellcheck disable=SC2034

description="Import WiFi config from boot partition"

depend() {
  before wpa_supplicant networking
  need localmount connector-data
}

find_wifi_config() {
  for name in wpa_supplicant wpa-supplicant; do
    for ext in "" .conf .txt; do
      if [ -f "/uboot/${name}${ext}" ]; then
        echo "/uboot/${name}${ext}"
        return 0
      fi
      if [ -f "/boot/${name}${ext}" ]; then
        echo "/boot/${name}${ext}"
        return 0
      fi
    done
  done
  return 1
}

import_config() {
  local src="$1"
  local dst="/data/etc/wpa_supplicant/wpa_supplicant.conf"

  mkdir -p /data/etc/wpa_supplicant /etc/wpa_supplicant
  cp "$src" "$dst" || return 1
  grep -q "ctrl_interface" "$dst" || \
    sed -i '1i ctrl_interface=/run/wpa_supplicant' "$dst"
  grep -q "update_config" "$dst" || \
    sed -i '2i update_config=1' "$dst"

  rm -f /etc/wpa_supplicant/wpa_supplicant.conf
  ln -s "$dst" /etc/wpa_supplicant/wpa_supplicant.conf
}

start() {
  ebegin "Checking boot partition for WiFi config"

  src=$(find_wifi_config)
  if [ -n "$src" ]; then
    einfo "Found $(basename "$src") on boot partition, importing..."

    if ! import_config "$src"; then
      eerror "Failed to import $(basename "$src"); leaving it on the boot partition"
      eend 1
      return 1
    fi

    boot_mount=$(dirname "$src")
    mount -o remount,rw "$boot_mount" 2>/dev/null
    rm -f "$src"
    mount -o remount,ro "$boot_mount" 2>/dev/null

    einfo "WiFi config imported and removed from boot partition"
  fi

  eend 0
}
