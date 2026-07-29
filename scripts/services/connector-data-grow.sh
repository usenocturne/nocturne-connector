#!/sbin/openrc-run
# shellcheck shell=ash
# shellcheck disable=SC2034

description="Expand the persistent Nocturne Connector data partition"

depend() {
  need devfs
  before localmount
}

is_block_device() {
  [ -b "$1" ]
}

start() {
  local disk=${NOCTURNE_CONNECTOR_DATA_DISK:-/dev/mmcblk0}
  local partition=${NOCTURNE_CONNECTOR_DATA_PARTITION:-/dev/mmcblk0p4}
  local data_label
  local data_type
  local grow_output
  local grow_status
  local fsck_status

  ebegin "Expanding persistent connector data"

  if ! is_block_device "$disk" || ! is_block_device "$partition"; then
    eend 1 "Connector data partition is unavailable"
    return 1
  fi

  data_label=$(blkid -s LABEL -o value "$partition" 2> /dev/null || true)
  data_type=$(blkid -s TYPE -o value "$partition" 2> /dev/null || true)
  if [ "$data_label" != data ] || [ "$data_type" != ext4 ]; then
    eend 1 "Refusing to resize unexpected partition $partition (label=$data_label type=$data_type)"
    return 1
  fi

  grow_output="$(growpart "$disk" 4 2>&1)"
  grow_status=$?
  if [ "$grow_status" -ne 0 ]; then
    case "$grow_output" in
      NOCHANGE:*) ;;
      *)
        eend "$grow_status" "$grow_output"
        return "$grow_status"
        ;;
    esac
  fi

  e2fsck -pf "$partition"
  fsck_status=$?
  case "$fsck_status" in
    0 | 1) ;;
    *)
      eend "$fsck_status" "Data filesystem check failed"
      return "$fsck_status"
      ;;
  esac

  if ! resize2fs "$partition" > /dev/null; then
    eend 1 "Data filesystem expansion failed"
    return 1
  fi

  eend 0
}
