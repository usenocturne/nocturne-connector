#!/usr/bin/env bash

mkdir -p "$WORK_PATH"/kernel "$ROOTFS_PATH"/tempapk

"$HELPERS_PATH"/chroot_exec.sh apk fetch linux-rpi -o /tempapk
tar -C "$WORK_PATH"/kernel -zxf "$ROOTFS_PATH"/tempapk/linux-rpi* 2> /dev/null || return 1
rm "$ROOTFS_PATH"/tempapk/linux-rpi*

for i in raspberrypi-bootloader-common raspberrypi-bootloader; do
  "$HELPERS_PATH"/chroot_exec.sh apk fetch $i -o /tempapk
  tar -C "$WORK_PATH"/kernel/boot -zxf "$ROOTFS_PATH"/tempapk/$i* --strip=1 boot/ 2> /dev/null || return 1
  rm "$ROOTFS_PATH"/tempapk/$i*
done

rmdir "$ROOTFS_PATH"/tempapk

(
  cd "$WORK_PATH"/kernel || exit 1
  rm -f boot/System.map-* boot/config-*

  rm -rf lib/modules/*/kernel/{arch,fs,sound,security,lib,kernel}
  find lib/modules/*/kernel/crypto ! -name 'zstd.ko.xz' -exec rm -rf {} + 2> /dev/null
  rm -rf lib/modules/*/kernel/drivers/{ata,auxdisplay,accessibility,base,bcma,block,bluetooth,cdrom,clk,connector,gpu,hid,iio,input,i2c,leds,md,mfd,mmc,mtd,mux,nvmem,pinctrl,pps,rtc,scsi,spi,ssb,staging,uio,vhost,video,w1}
  rm -rf lib/modules/*/kernel/drivers/media/{cec,common,dvb-core,dvb-frontends,i2c,mc,pci,radio,rc,spi,test-drivers,tuners,v4l2-core,platform}
  rm -rf lib/modules/*/kernel/net/{6lowpan,9p,802,8021q,appletalk,atm,ax25,batman-adv,bluetooth,can,ceph,core,ieee802154,key,l2tp,llc,mpls,mptcp,netrom,nfc,nsh,openvswitch,rose,sched,sctp,vmw_vsock,xfrm}
)
