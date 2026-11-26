#!/bin/sh
set -eu

project=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/desktop-plus-launchers.XXXXXXXX")
trap 'rm -rf -- "$scratch"' 0

linux_bin="$scratch/linux/usr/share/desktop-plus-zh-cn"
mac_app="$scratch/汉化工具.app/Contents"
mac_resources="$mac_app/Resources"
export HOME="$scratch/home"
export TMPDIR="$scratch/tmp"
export PATH="$scratch/bin:$PATH"
mkdir -p "$linux_bin" "$mac_app/MacOS" "$mac_resources" "$HOME/Applications" "$TMPDIR" "$scratch/bin"

cp "$project/packaging/linux-apprun.sh" "$scratch/linux/AppRun"
cp "$project/packaging/macos-launcher.sh" "$mac_app/MacOS/DesktopPlusZhCN"
for dir in "$linux_bin" "$mac_resources"; do
  cp "$project/packaging/unix-runtime.sh" "$dir/"
  chmod +x "$dir/unix-runtime.sh"
  touch "$dir/desktop-plus-zh-cn-unix.mjs"
done
chmod +x "$scratch/linux/AppRun" "$mac_app/MacOS/DesktopPlusZhCN"

cat > "$scratch/bin/id" <<'SH'
#!/bin/sh
printf '%s\n' "${TEST_UID:-1000}"
SH
cat > "$scratch/bin/node" <<'SH'
#!/bin/sh
if [ "$1" = -e ]; then
  [ "${TEST_NODE_OLD:-}" != 1 ] && printf ready
else
  shift
  printf '%s\n' system "$@"
fi
SH
chmod +x "$scratch/bin/"*

sentinel=dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX
write_fuses() {
  printf 'prefix%s\001\010%s0000000suffix\n' "$sentinel" "$1"
}
write_electron() {
  cat <<'SH'
#!/bin/sh
[ "${ELECTRON_RUN_AS_NODE:-}" = 1 ] || exit 91
[ -z "${NODE_OPTIONS:-}" ] || exit 92
if [ "$1" = -e ]; then
  printf ready
else
  shift
  printf '%s\n' electron "$@"
fi
SH
  printf '#'
  write_fuses "$1"
}

mac_target="$HOME/Applications/Desktop Plus.app"
framework="$mac_target/Contents/Frameworks/Electron Framework.framework"
mkdir -p "$mac_target/Contents/MacOS" "$framework"
write_electron 1 > "$mac_target/Contents/MacOS/Desktop Plus"
write_fuses 1 > "$framework/Electron Framework"
chmod +x "$mac_target/Contents/MacOS/Desktop Plus"

# The default macOS target is resolved before the runtime starts.
[ "$("$mac_app/MacOS/DesktopPlusZhCN" check)" = "$(printf '%s\n' electron check)" ]
write_fuses 1 >> "$framework/Electron Framework"
[ "$("$mac_app/MacOS/DesktopPlusZhCN" check)" = "$(printf '%s\n' electron check)" ]
write_fuses 1 > "$framework/Electron Framework"
write_fuses 0 >> "$framework/Electron Framework"
[ "$("$mac_app/MacOS/DesktopPlusZhCN" restore "$mac_target")" = "$(printf '%s\n' system restore "$mac_target")" ]

linux_target="$scratch/安装目录"
mkdir "$linux_target"
write_electron 1 > "$linux_target/desktop-plus"
chmod +x "$linux_target/desktop-plus"
[ "$(NODE_OPTIONS=ignored "$scratch/linux/AppRun" apply "$linux_target")" = "$(printf '%s\n' electron apply "$linux_target")" ]
[ "$(printf '4\n%s\n' "$linux_target" | "$scratch/linux/AppRun" --terminal | tail -n 2)" = "$(printf '%s\n' check "$linux_target")" ]
export TEST_GUI_TARGET="$linux_target"
cat > "$scratch/bin/zenity" <<'SH'
#!/bin/sh
case "$1" in
  --list) printf apply ;;
  --entry) printf '%s' "$TEST_GUI_TARGET" ;;
  --info)
    for argument do
      case "$argument" in --text=*) printf '%s' "${argument#--text=}" ;; esac
    done
    ;;
  *) exit 1 ;;
esac
SH
chmod +x "$scratch/bin/zenity"
[ "$("$scratch/linux/AppRun" < /dev/null)" = "$(printf '%s\n' electron apply "$linux_target")" ]
write_electron 0 > "$linux_target/desktop-plus"
[ "$("$scratch/linux/AppRun" restore "$linux_target")" = "$(printf '%s\n' system restore "$linux_target")" ]
if TEST_NODE_OLD=1 "$scratch/linux/AppRun" check "$linux_target" > "$scratch/error.txt" 2>&1; then
  printf '%s\n' 'Expected a missing-runtime error' >&2
  exit 1
fi
grep -q 'Node.js 22' "$scratch/error.txt"

export TEST_ELECTRON="$scratch/runtime-fixture"
write_electron 1 > "$TEST_ELECTRON"
upstream="$scratch/Desktop Plus.AppImage"
cat > "$upstream" <<'SH'
#!/bin/sh
set -eu
[ "$#" -eq 1 ] && [ "$1" = --appimage-extract ]
[ -z "${APPDIR:-}" ] && [ -z "${APPIMAGE:-}" ]
mkdir squashfs-root
cp "$TEST_ELECTRON" squashfs-root/desktop-plus
cat > squashfs-root/AppRun <<'APP'
#!/bin/sh
set -eu
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
[ "$DESKTOP_PLUS_ZH_CN_RUNTIME_APPDIR" = "$dir" ]
exec "$dir/desktop-plus" "$@"
APP
chmod +x squashfs-root/desktop-plus squashfs-root/AppRun
SH
chmod +x "$upstream"
[ "$(APPDIR="$scratch/bad" APPIMAGE="$scratch/bad" \
    "$scratch/linux/AppRun" launch "$upstream" -- '--example=space here')" = \
  "$(printf '%s\n' electron launch "$upstream" -- '--example=space here')" ]
[ -z "$(ls -A "$TMPDIR")" ]
if TEST_UID=0 "$scratch/linux/AppRun" apply "$upstream" > "$scratch/error.txt" 2>&1; then
  printf '%s\n' 'Expected AppImage execution as root to be rejected' >&2
  exit 1
fi
grep -q '请使用普通用户运行' "$scratch/error.txt"
printf '%s\n' 'Verified macOS and Linux launcher routing, fallback, AppImage extraction and cleanup.'

