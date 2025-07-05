<h1 align="center">
  <br>
  <a href="http://www.amitmerchant.com/electron-markdownify"><img src="https://usenocturne.com/images/logo.png" alt="Nocturne" width="200"></a>
  <br>
  Nocturne Connector
  <br>
</h1>

<h4 align="center">OS for Raspberry Pi to make connecting a <a href="https://carthing.spotify.com/" target="_blank">Spotify Car Thing</a> for desk use easy.</h4>

<p align="center">
  <a href="#prerequisites">Prerequisites</a> •
  <a href="#usage">Usage</a> •
  <a href="#updating">Updating</a> •
  <a href="#donate">Donate</a> •
  <a href="#building">Building</a> •
  <a href="#credits">Credits</a> •
  <a href="#license">License</a>
</p>

<br>

## Prerequisites

- Raspberry Pi with networking
  - Pi 1 and 2 are not supported due to lack of onboard Wi-Fi
- Working Wi-Fi network
- 8GB or larger micro-SD card
- Car Thing with Nocturne 3.0.0 or later installed

## Usage

1. Flash the correct image (see table below) with Raspberry Pi Imager (recommended) or any other img flasher
2. Plug your Car Thing into a USB port (USB3/blue ports recommended for more power)
3. Plug your Pi into power
4. On the No Internet/Connection Lost screen on Nocturne, press the button underneath the message to log into your Wi-Fi network

| Board             | armhf | aarch64 |
| ----------------- | :---: | :-----: |
| Pi 3, Pi Zero W 2 |       |    ✅    |
| Pi 4              |       |    ✅    |
| Pi 5              |       |    ✅    |


## Updating

Nocturne will alert you when Connector has an update. Updates are small (under 150 MB compressed) and flash quickly.

Connector images use an A/B partition scheme, which means that updates will be flashed to an inactive boot slot. If an update fails, your Pi will revert back to the old boot slot and Connector will continue operating as normal.

If you do not want to update through Nocturne, you can:

- Reflash the SD card with a PC (loses saved Wi-Fi networks)
- Use Connector API to POST /update (Advanced, see `src/main.go` for reference)
- Use `pv`/`cat` and `ssh` to copy over the update bundle and manually run `ab_flash` (Advanced)

## Donate

Nocturne is a massive endeavor, and the team have spent everyday over the last few months making it a reality out of our passion for creating something that people like you love to use.

All donations are split between the four members of the Nocturne team, and go towards the development of future features. We are so grateful for your support!

[Buy Me a Coffee](https://buymeacoffee.com/brandonsaldan) | [Ko-Fi](https://ko-fi.com/brandonsaldan)

## Building

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

## Tinkering (Advanced)

SSH is open on port 22. Root password is `alpine`.

You may remount the rootfs as read-write with `mount -o remount,rw /`

You can set the active boot slot using the `ab_active` utility, or flash an image to the inactive slot using the `ab_flash` utility.

## Credits

This software was made possible only through the following individuals and open source programs:

- [Brandon Saldan](https://github.com/brandonsaldan)
- [shadow](https://github.com/68p)
- [Dominic Frye](https://github.com/itsnebulalol)
- [bbaovanc](https://github.com/bbaovanc)

### Image

- [gitlab.com/raspi-alpine/builder](https://gitlab.com/raspi-alpine/builder)

### API

- [gitlab.com/raspi-alpine/go-raspi-alpine](https://gitlab.com/raspi-alpine/go-raspi-alpine)
- [kairos-io/kairos](https://github.com/kairos-io/kairos/blob/v1.6.0/pkg/machine/openrc/unit.go) (openrc package)

## License

This project is licensed under the **Apache** license.

---

> © 2025 Nocturne.

> "Spotify" and "Car Thing" are trademarks of Spotify AB. This software is not affiliated with or endorsed by Spotify AB.

> [usenocturne.com](https://usenocturne.com) &nbsp;&middot;&nbsp;
> GitHub [@usenocturne](https://github.com/usenocturne)
