# nocturne-connector
OS for Raspberry Pi to make connecting a Car Thing for desk use easy.

# Prerequisites

- Raspberry Pi with networking
- Working Wi-Fi network or Ethernet 
- 8GB or larger micro-SD card
- Car Thing with Nocturne 3.0.0 or later installed

# Usage

1. Flash the correct image (see table below) with Raspberry Pi Imager (recommended) or any other img flasher
2. Plug your Car Thing into a USB port (USB3/blue ports recommended for more power)
3. Plug your Pi into power

| Board           | armhf | armv7 | aarch64 |
| --------------- | :---: | :---: | :-----: |
| pi0             |   ✅   |       |         |
| pi1             |   ✅   |       |         |
| pi2             |   ✅   |   ✅   |         |
| pi3, pi0w2, cm3 |   ✅   |   ✅   |    ✅    |
| pi4, pi400, cm4 |       |   ✅   |    ✅    |
| pi5, pi500, cm5 |       |       |    ✅    |


TODO: Set up Wi-Fi

# Updating

Nocturne will alert you when Connector has an update. Updates are small (under 150 MB compressed) and flash quickly.

Connector images use an A/B partition scheme (thanks to raspi-alpine), which means that updates will be flashed to an inactive boot slot.

If an update fails, your Pi will revert back to the old boot slot and Connector will continue operating as normal.

# Building

Docker is required. Use `./build.sh` to build an image.

```
Usage: build.sh [-i IMAGE] [-f|-7|-8] [-p]
           -i is the docker image to use for the build
           -p pulls newest version of the image before running
           -f builds armhf section
           -7 builds armv7 section
           -8 builds armv8 (arm64) section

           if -f -7 or -8 is not used all sections are built
```

# Tinkering (Advanced)

SSH is open on port 22. Root password is `alpine`.

You may remount the rootfs as read-write with `mount -o remount,rw /`

You can set the active boot slot using the `ab_active` utility, or flash an image to the inactive slot using the `ab_flash` utility.

# Credits
- [gitlab.com/raspi-alpine/builder](https://gitlab.com/raspi-alpine/builder)