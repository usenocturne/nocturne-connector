#!/bin/sh
set -e

if [ $# -ne 1 ]; then
  echo "USAGE: $0 PARAM" >&2
  exit 1
fi

value=$(tr ' ' '\n' < /proc/cmdline | sed -n "s/^$1=//p" | head -n1)
if [ -z "$value" ]; then
  exit 1
fi

echo "$value"
