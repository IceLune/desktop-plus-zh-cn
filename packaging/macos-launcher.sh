#!/bin/sh
set -eu

resources=$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd -P)
runtime="$resources/unix-runtime.sh"

if [ "$#" -gt 0 ]; then
  exec "$runtime" macos "$@"
fi
exec /usr/bin/osascript "$resources/macos-dialog.applescript" "$runtime"

