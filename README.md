<h1 align="center">
  <br>
  <img src="https://usenocturne.com/images/logo.png" alt="Nocturne" width="200">
  <br>
  Nocturne Connector
  <br>
</h1>

<p align="center">Raspberry Pi OS for Wi-Fi connectivity on the Spotify Car Thing</p>

<p align="center">
  <a href="#prerequisites">Prerequisites</a> •
  <a href="#usage">Usage</a> •
  <a href="#donate">Donate</a> •
  <a href="#building">Building</a> •
  <a href="#tinkering-advanced">Tinkering (Advanced)</a> •
  <a href="#credits">Credits</a> •
  <a href="#license">License</a>
</p>

<br>

## Prerequisites

- Raspberry Pi with networking
  - Pi 1 and 2 are not supported due to the lack of onboard Wi-Fi
  - Pi Zero 1 (W) is not supported due to the old architecture
- SD card
  - Nocturne Connector is super small (~60 MB), so you have many choices for SD cards
- Working Wi-Fi network
- Car Thing with Nocturne 3.0.0 or later installed

## Usage

1. Download the [img.gz from the latest release](https://github.com/usenocturne/nocturne-connector/releases/latest)
2. Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/), [balenaEtcher](https://etcher.balena.io/), or dd to flash the image to your SD card
   - In Raspberry Pi Imager, choose your Pi model, use "Use custom" in "Choose OS", select your SD card, press next, then choose "No" for customization.
4. Insert the SD card into your Raspberry Pi
5. Plug your Car Thing into a USB 3 port (if applicable) on your Raspberry Pi
   - If you are using a Pi Zero, plug your Car Thing into the data port.
6. Power the Raspberry Pi & set up Wi-Fi on your Car Thing

## Donate

Nocturne is a massive endeavor, and the team has spent every day over the last year making it a reality out of our passion for creating something that people like you love to use.

All donations are split between the three members of the Nocturne team and go towards the development of future features. We are so grateful for your support!

[Donation Page](https://usenocturne.com/donate)

## Building

`curl`, `zip/unzip`, `genimage`, `mkpasswd`, and `m4` binaries are required.

If you are on an architecture other than arm64, qemu-user-static (+ binfmt, or use `docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`) is required.

Use the `Justfile`. `just run` will output a flashable `img.gz` in `output`.

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

- [shadow](https://github.com/68p)
- [Dominic Frye](https://github.com/itsnebulalol)

### Image

- [gitlab.com/raspi-alpine/builder](https://gitlab.com/raspi-alpine/builder)

### API

- [kairos-io/kairos](https://github.com/kairos-io/kairos/blob/v1.6.0/pkg/machine/openrc/unit.go) (openrc package)

## License

This project is licensed under the **Apache** license.

---

> © 2025 Vanta Labs.

> "Spotify" and "Car Thing" are trademarks of Spotify AB. This software is not affiliated with or endorsed by Spotify AB.

> [usenocturne.com](https://usenocturne.com) &nbsp;&middot;&nbsp;
> GitHub [@usenocturne](https://github.com/usenocturne)
