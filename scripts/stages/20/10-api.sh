#!/bin/sh

cp "$CONNECTOR_PATH"/connector-api "$ROOTFS_PATH"/usr/sbin/connector-api
cp "$SCRIPTS_PATH"/services/connector-api.sh "$ROOTFS_PATH"/etc/init.d/connector-api

mkdir "$ROOTFS_PATH"/etc/nocturne-connector
echo "$CONNECTOR_IMAGE_VERSION" > "$ROOTFS_PATH"/etc/nocturne-connector/version.txt

DEFAULT_SERVICES="${DEFAULT_SERVICES} connector-api"
