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
  - Pi Zero 1 (W) is not supported due to the old architecture
- Working Wi-Fi network
- Car Thing with Nocturne 3.0.0 or later installed

## Usage

1. Plug your Car Thing into a USB 3 port (if applicable) on your Raspberry Pi
2. Remove any SD cards and power the Raspberry Pi

## Donate

Nocturne is a massive endeavor, and the team have spent everyday over the last few months making it a reality out of our passion for creating something that people like you love to use.

All donations are split between the four members of the Nocturne team, and go towards the development of future features. We are so grateful for your support!

[Buy Me a Coffee](https://buymeacoffee.com/brandonsaldan) | [Ko-Fi](https://ko-fi.com/brandonsaldan)

## Building

`curl`, `zip/unzip`, `genimage`, and `mkpasswd` binaries are required.

If you are on an architecture other than arm64, qemu-user-static (+ binfmt, or use `docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`) is required.

Use the `Justfile`. `just run` will output an initramfs and boot image in `output`.

```
$ just -l
Available recipes:
  connector-api
  lint
  run
```

## Tinkering (Advanced)

SSH is open on port 22. Root password is `nocturne`.

You may remount the rootfs as read-write with `mount -o remount,rw /`

Any changes to the rootfs are temporary as the OS is booted from RAM. Please update `/connector.img` on your Car Thing.

## Credits

This software was made possible only through the following individuals and open source programs:

- [Brandon Saldan](https://github.com/brandonsaldan)
- [shadow](https://github.com/68p)
- [Dominic Frye](https://github.com/itsnebulalol)
- [bbaovanc](https://github.com/bbaovanc)

### Image

- [gitlab.com/raspi-alpine/builder](https://gitlab.com/raspi-alpine/builder)

### API

- [kairos-io/kairos](https://github.com/kairos-io/kairos/blob/v1.6.0/pkg/machine/openrc/unit.go) (openrc package)

## License

This project is licensed under the **Apache** license.

---

> © 2025 Nocturne.

> "Spotify" and "Car Thing" are trademarks of Spotify AB. This software is not affiliated with or endorsed by Spotify AB.

> [usenocturne.com](https://usenocturne.com) &nbsp;&middot;&nbsp;
> GitHub [@usenocturne](https://github.com/usenocturne)
