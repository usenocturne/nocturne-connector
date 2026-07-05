#!/sbin/openrc-run
# shellcheck shell=ash
# shellcheck disable=SC2034

description="Set the /dev/root symlink for the selected A/B root slot"

depend() {
  need dev
  keyword -docker -lxc -openvz -prefix -systemd-nspawn -uml -vserver -xenu
}

start() {
  ebegin "Setting /dev/root symlink"
  ln -fs "$(ab_bootparam root)" /dev/root
  eend 0
}
