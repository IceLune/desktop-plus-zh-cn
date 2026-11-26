#!/bin/sh
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
launcher=$app_dir/AppRun
if [ -n "${APPIMAGE:-}" ] && [ -f "$APPIMAGE" ]; then
  launcher=$APPIMAGE
fi

# A selected upstream AppImage must get its own mount and extraction environment.
unset APPIMAGE APPDIR ARGV0 OWD APPIMAGE_EXTRACT_AND_RUN APPIMAGE_EXTRACT_AND_RUN_NO_CLEANUP ELECTRON_RUN_AS_NODE
runtime="$app_dir/usr/share/desktop-plus-zh-cn/unix-runtime.sh"
title='Desktop Plus 简体中文插件'

if [ "${1:-}" = --terminal ]; then
  shift
  exec "$runtime" linux "$@"
fi
if [ "$#" -gt 0 ] || [ -t 0 ]; then
  exec "$runtime" linux "$@"
fi

if command -v zenity >/dev/null 2>&1; then
  action=$(zenity --list --title="$title" --text='请选择操作' \
    --column=命令 --column=操作 --hide-column=1 --print-column=1 \
    launch '启动汉化版' apply '应用汉化' restore '恢复英文' check '检查状态') || exit 0
  [ -n "$action" ] || exit 0
  target=$(zenity --entry --title="$title" \
    --text='输入 Desktop Plus 安装目录或原始 AppImage 路径。留空使用系统安装位置。') || exit 0
  show_result() {
    if [ "$1" -eq 0 ]; then
      zenity --info --title="$title" --no-markup --text="$2"
    else
      zenity --error --title="$title" --no-markup --text="$2"
    fi
  }
elif command -v kdialog >/dev/null 2>&1; then
  action=$(kdialog --title "$title" --menu '请选择操作' \
    launch '启动汉化版' apply '应用汉化' restore '恢复英文' check '检查状态') || exit 0
  [ -n "$action" ] || exit 0
  target=$(kdialog --title "$title" \
    --inputbox '输入 Desktop Plus 安装目录或原始 AppImage 路径。留空使用系统安装位置。') || exit 0
  show_result() {
    if [ "$1" -eq 0 ]; then
      kdialog --title "$title" --msgbox "$2"
    else
      kdialog --title "$title" --error "$2"
    fi
  }
else
  for terminal in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
    if command -v "$terminal" >/dev/null 2>&1; then
      case "$terminal" in
        gnome-terminal) exec "$terminal" -- "$launcher" --terminal ;;
        xfce4-terminal) exec "$terminal" --execute "$launcher" --terminal ;;
        *) exec "$terminal" -e "$launcher" --terminal ;;
      esac
    fi
  done
  printf '%s\n' '请在终端运行此 AppImage，或安装 Zenity/KDialog 后双击。' >&2
  exit 1
fi

set -- "$action"
if [ -n "$target" ]; then set -- "$@" "$target"; fi
status=0
result=$("$runtime" linux "$@" 2>&1) || status=$?
show_result "$status" "$result" || :
exit "$status"
