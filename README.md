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

<div align="center">
  <a href="https://usenocturne.com"><img alt="Website" src="https://img.shields.io/badge/website-gray?style=flat-square&logo=react&logoColor=FFFFFF"></a>
  <a href="https://discord.gg/mnURjt3M6m"><img alt="Discord" src="https://img.shields.io/discord/1304909652387172493?style=flat-square&logo=discord&logoColor=FFFFFF&label=discord"></a>
</div>

## Prerequisites

- Car Thing with Nocturne 4.1.0 or later installed
- Raspberry Pi with networking, or a Mac with macOS 15.0 or newer.
  - Pi 1 and 2 are not supported due to the lack of onboard Wi-Fi
  - Pi Zero 1 (W) is not supported due to the old architecture
- SD card (Raspberry Pi)
  - An 8 GB or larger card is required.
- Working Wi-Fi network

## Usage

<details>
<summary><img src="https://camo.githubusercontent.com/b9c79d36777ba11fe5423f498b522f7b786898772a1ddbb44074fb6bc59adf06/68747470733a2f2f7573656e6f637475726e652e636f6d2f696d616765732f6c6f676f2e706e67" height="14" style="vertical-align: middle;"> Raspberry Pi</summary>

1. Download the [img.gz from the latest release](https://github.com/usenocturne/nocturne-connector/releases/latest).
2. Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/), [balenaEtcher](https://etcher.balena.io/), or `dd` to flash the image to your SD card.
    - In Raspberry Pi Imager, click "OS" on the left side and use "Use custom", select your SD card, and press write.
3. If you are using Wi-Fi, download [wpa_supplicant.conf](https://raw.githubusercontent.com/usenocturne/nocturne-connector/refs/heads/main/wpa_supplicant.conf), and fill in your SSID and password (inside of quotes). Then, place it on the root of the SD card.
    - If your country is not the United States, replace the `US` in the file with your country code.
4. Power the Raspberry Pi & visit `nocturne-connector.local` in any browser.
    - If this does not work, you will need to find the IP address of the Raspberry Pi from your router, and use that IP address instead of `nocturne-connector.local`.
5. Finish setting up Nocturne Connector by following the steps on screen.

</details>

<details>
<summary><img src="https://usenocturne.com/favicon.ico" height="14" style="vertical-align: middle;"> macOS 15.0+ </summary>

1. Download the macOS disk image from the [latest release](https://github.com/usenocturne/nocturne-connector/releases/latest).
2. Open the disk image and drag Nocturne Connector into your Applications folder.
3. Open Nocturne Connector from your Applications folder.
4. Finish setting up Nocturne Connector by following the steps on screen.

</details>

## Donate

Nocturne is a massive endeavor, and the team has spent every day over the last year making it a reality out of our passion for creating something that people like you love to use.

All donations are split between the three members of the Nocturne team and go towards the development of future features. We are so grateful for your support!

[Donation Page](https://usenocturne.com/donate)

## Building

`curl`, `zip/unzip`, `genimage`, `mkpasswd`, `m4`, and `mkimage` binaries are required.

If you are on an architecture other than arm64, qemu-user-static and binfmt (or use `docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`) are required.

Use the `Justfile`. `just run` will output a flashable `img.gz` in `output`, plus a rootfs-only `_update.img.gz` package used by Connector self-updates.

```
$ just -l
Available recipes:
  connector-api
  docker-build
  docker-run
  docker-qemu
  lint
  run
  windows-check
  windows-host-check
  windows-host-test
  windows-server
  windows-test
  windows-universal
```

## Updating

Connector images use an A/B root partition layout. The boot partition runs U-Boot, which selects either root slot A or B and rolls back to the previous slot if a new slot fails to boot twice.

Full SD-card images are named `nocturne-connector_<version>.img.gz`. Self-update packages are named `nocturne-connector_<version>_update.img.gz` and must be published with the matching `.sha256` file in the GitHub release. The web UI Settings page checks for that rootfs-only asset and flashes it to the inactive slot before prompting for a reboot.

The selector helper writes U-Boot's CRC in big-endian byte order and accepts legacy little-endian records during migration. Existing devices running an older helper need the fixed helper installed once, or a full-image reflash, before a rootfs-only update can switch slots.

Persistent connector state, setup/auth data, analytics queue data, and Wi-Fi config live under `/data` so they survive slot changes.

## Tinkering (Advanced)

UART (with a TTY) is enabled and is the recommended way to debug and interact with the system. SSH is open on port 22 if you'd like instead. Root password is `nocturne`.

The boot filesystem is mounted read-only at `/uboot`, root slots are `/dev/mmcblk0p2` and `/dev/mmcblk0p3`, and persistent data is `/dev/mmcblk0p4`. Use `ab_active` to inspect the current slot and `ab_flash <update.img.gz>` to manually flash the inactive slot.

## Credits

This software was made possible only through the following individuals and open source programs:

- [Dominic Frye](https://github.com/itsnebulalol)
- [Neel Patel](https://github.com/68p)

### Image

- [gitlab.com/raspi-alpine/builder](https://gitlab.com/raspi-alpine/builder)

## License

This project is licensed under the **Apache** license.

---

> © 2026 Vanta Labs.

> "Spotify" and "Car Thing" are trademarks of Spotify AB. This software is not affiliated with or endorsed by Spotify AB.

> [usenocturne.com](https://usenocturne.com) &nbsp;&middot;&nbsp;
> [GitHub](https://github.com/usenocturne) &nbsp;&middot;&nbsp;
> [Discord](https://discord.gg/mnURjt3M6m)
