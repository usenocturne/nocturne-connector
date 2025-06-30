#!/bin/sh

cp "$INPUT_PATH"/connector-api "$ROOTFS_PATH"/usr/bin/connector-api
cp "$INPUT_PATH"/init.sh "$ROOTFS_PATH"/etc/init.d/connector-api

chroot_exec rc-update add connector-api default

mkdir "$ROOTFS_PATH"/etc/nocturne-connector
echo "1.0.0" > "$ROOTFS_PATH"/etc/nocturne-connector/version.txt

curl -Lo mkcert https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-amd64
chmod +x mkcert
./mkcert -cert-file "$ROOTFS_PATH"/etc/nocturne-connector/cert.crt -key-file "$ROOTFS_PATH"/etc/nocturne-connector/cert.key localhost 127.0.0.1 ::1
