#!/sbin/openrc-run
# shellcheck shell=ash
# shellcheck disable=SC2034

command="/usr/bin/connector-api"
pidfile="/var/run/connector-api.pid"
command_args=""
command_background=true

depend() {
  use logger
  after networking
}
