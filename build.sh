#!/usr/bin/env sh
set -e

cd "$(dirname "$0")"

usage() {
  echo
  echo "Usage: build.sh [-i IMAGE] [-f|-7|-8] [-p]"
  echo "           -i is the docker image to use for the build"
  echo "           -p pulls newest version of the image before running"
  echo "           -f builds armhf section"
  echo "           -7 builds armv7 section"
  echo "           -8 builds armv8 (arm64) section"
  echo
  echo "           if -f -7 or -8 is not used all sections are built"
  exit 1
}

failed() {
  echo "--<< Failed on build: $1 >>--"
  exit 1
}

while getopts "i:f78p" OPTS; do
  case ${OPTS} in
    i) IMG=${OPTARG} ;;
    f) ARMHF="true" ;;
    7) ARMV7="true" ;;
    8) ARMV8="true" ;;
    p) PULL="true" ;;
    *) usage ;;
  esac
done

if [ -z "$ARMHF" ] && [ -z "$ARMV7" ] && [ -z "$ARMV8" ]; then
  ARMHF="true"
  ARMV7="true"
  ARMV8="true"
fi
[ -z "$IMG" ] && IMG="ghcr.io/raspi-alpine/builder"
[ -n "$PULL" ] && docker image pull "$IMG"

docker run --rm -v "$PWD"/input:/input -v "$PWD"/src:/work -w /work -e GOOS=linux -e GOARCH=arm -e GOARM=5 golang:1.22-alpine go build -v -o /input/connector-api .

if [ -n "$ARMV7" ]; then
  docker run --rm -v "$PWD"/input:/input -v "$PWD"/output/armv7:/output -v "$PWD"/cache:/cache \
    --env ARCH=armv7 --env-file=builder.env "$IMG" || failed "armv7"
fi

if [ -n "$ARMHF" ]; then
  docker run --rm -v "$PWD"/input:/input -v "$PWD"/output/armhf:/output -v "$PWD"/cache:/cache \
    --env ARCH=armhf --env-file=builder.env "$IMG" || failed "armhf"
fi

if [ -n "$ARMV8" ]; then
  docker run --rm -v "$PWD"/input:/input -v "$PWD"/output/aarch64:/output -v "$PWD"/cache:/cache \
    --env ARCH=aarch64 --env-file=builder.env "$IMG" || failed "aarch64"
fi
