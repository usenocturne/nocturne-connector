# nocturne-connector
OS for Raspberry Pi to make connecting a Car Thing for desk use easy.

# Usage

1. Flash with Raspberry Pi Imager (recommended) or any other img flasher
2. Plug your Car Thing flashed with Nocturne 3.0.0 or greater into a USB port (USB3 recommended for more power)
3. Plug your Pi into power

TODO: Set up Wi-Fi

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

# Credits
- [gitlab.com/raspi-alpine/builder](https://gitlab.com/raspi-alpine/builder)