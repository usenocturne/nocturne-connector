# U-Boot A/B selector. State is persisted in /uboot/uboot.dat:
# byte 0 = format version, byte 1 = boot counter, byte 2 = active root partition,
# bytes 1020-1023 = CRC32 over bytes 0-1019.

setenv boot_partition_a 0x02
setenv boot_partition_b 0x03
setenv boot_limit 0x02

setenv addr_version 0x10000
setenv addr_boot_counter 0x10001
setenv addr_boot_partition 0x10002

version
if test -e mmc 0:1 boot.scr; then
  setenv boot_partition_base "/dev/mmcblk0p"
  setenv boot_dev mmc
else
  setenv boot_partition_base "/dev/sda"
  setenv boot_dev usb
fi
echo "booting from: ${boot_dev}"

mw.b 0x10000 0 0x404
fatload ${boot_dev} 0:1 0x10000 uboot.dat 0x400

crc32 0x10000 0x3FC 0x10400
if itest *0x103FC -ne *0x10400; then
  echo "invalid CRC -> fallback to root A"
  mw.b ${addr_version} 0x01
  mw.b ${addr_boot_counter} 0x00
  mw.b ${addr_boot_partition} ${boot_partition_a}
fi

if itest.b *${addr_boot_partition} -ne ${boot_partition_a} && itest.b *${addr_boot_partition} -ne ${boot_partition_b}; then
  echo "invalid boot partition -> root A"
  mw.b ${addr_boot_partition} ${boot_partition_a}
fi

setexpr.b boot_counter *${addr_boot_counter}
setexpr.b boot_partition *${addr_boot_partition}
echo "> boot counter:   ${boot_counter}"
echo "> boot partition: ${boot_partition}"

if itest.b *${addr_boot_counter} -ge ${boot_limit}; then
  echo "boot limit exceeded, rolling back"
  if itest.b *${addr_boot_partition} -eq ${boot_partition_a}; then
    mw.b ${addr_boot_partition} ${boot_partition_b}
  else
    mw.b ${addr_boot_partition} ${boot_partition_a}
  fi
  mw.b ${addr_boot_counter} 0
else
  setexpr.b tmp *${addr_boot_counter} + 1
  mw.b ${addr_boot_counter} ${tmp}
fi

setexpr.b boot_partition *${addr_boot_partition}
mw.b ${addr_version} 0x01
crc32 0x10000 0x3FC 0x103FC
fatwrite ${boot_dev} 0:1 0x10000 uboot.dat 0x400

setenv boot_kernel "/boot/vmlinuz-rpi"
echo "Load kernel ${boot_kernel} from ${boot_partition_base}${boot_partition}"

fdt addr ${fdt_addr} && fdt get value bootargs /chosen bootargs
setexpr bootargs sub " root=[^ ]+" " root=${boot_partition_base}${boot_partition}" "${bootargs}"

ext4load ${boot_dev} 0:${boot_partition} ${kernel_addr_r} ${boot_kernel}

booti ${kernel_addr_r} - ${fdt_addr}
bootz ${kernel_addr_r} - ${fdt_addr}

sleep 3
reset
