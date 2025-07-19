<h1 align="center">
  <br>
  <img src="https://usenocturne.com/images/logo.png" alt="Nocturne" width="200">
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
- SD card
  - Nocturne Connector is super small (~60 MB) so you have many choices for SD cards
- Working Wi-Fi network
- Car Thing with Nocturne 3.0.0 or later installed

## Usage

1. Flash the [img.gz from the latest release](https://github.com/usenocturne/nocturne-connector/releases) to your SD card
2. Insert the SD card into your Raspberry Pi
3. Plug your Car Thing into a USB 3 port (if applicable) on your Raspberry Pi
  - If you are using a Pi Zero, plug your Car Thing into the data port.
4. Power the Raspberry Pi & set up Wi-Fi on your Car Thing

## Donate

Nocturne is a massive endeavor, and the team have spent everyday over the last few months making it a reality out of our passion for creating something that people like you love to use.

All donations are split between the four members of the Nocturne team, and go towards the development of future features. We are so grateful for your support!

[Buy Me a Coffee](https://buymeacoffee.com/brandonsaldan) | [Ko-Fi](https://ko-fi.com/brandonsaldan)

## Building

`curl`, `zip/unzip`, `genimage`, `mkpasswd`, and `m4` binaries are required.

If you are on an architecture other than arm64, qemu-user-static (+ binfmt, or use `docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`) is required.

Use the `Justfile`. `just run` will output an initramfs and boot image in `output`.

```
$ just -l
Available recipes:
  connector-api
  docker-qemu
  lint
  run
```

## Tinkering (Advanced)

UART (with a TTY) is enabled and is the recommended way to debug and interact with the system without the need for SSH. SSH is open on port 22 if you'd like instead. Root password is `nocturne`.

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
