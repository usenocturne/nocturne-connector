#!/sbin/openrc-run
# shellcheck shell=ash
# shellcheck disable=SC2034

description="Prepare persistent Nocturne Connector data"

depend() {
  need localmount
  before wpa_supplicant networking connector-api
}

ensure_wifi_config() {
  mkdir -p /data/etc/wpa_supplicant /etc/wpa_supplicant

  if [ ! -f /data/etc/wpa_supplicant/wpa_supplicant.conf ]; then
    cp /usr/share/nocturne-connector/defaults/wpa_supplicant.conf \
      /data/etc/wpa_supplicant/wpa_supplicant.conf
  fi

  rm -f /etc/wpa_supplicant/wpa_supplicant.conf
  ln -s /data/etc/wpa_supplicant/wpa_supplicant.conf \
    /etc/wpa_supplicant/wpa_supplicant.conf
}

start() {
  ebegin "Preparing persistent connector data"

  mkdir -p /data/nocturne-connector /data/root /data/var/lib /data/var/log
  ensure_wifi_config

  eend 0
}
