#!/bin/sh
set -eu

platform=$1
shift
tool_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
tool="$tool_dir/desktop-plus-zh-cn-unix.mjs"
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS

if [ "$#" -eq 0 ]; then
  printf '%s\n' '1. 启动汉化版' '2. 应用汉化' '3. 恢复英文' '4. 检查状态'
  printf '%s' '请选择 1–4，直接回车退出：'
  IFS= read -r choice || exit 0
  case "$choice" in
    1) action=launch ;;
    2) action=apply ;;
    3) action=restore ;;
    4) action=check ;;
    '') exit 0 ;;
    *) printf '%s\n' '请选择 1–4。' >&2; exit 1 ;;
  esac
  printf '%s' '应用路径（默认位置直接回车）：'
  IFS= read -r selected || exit 0
  set -- "$action"
  if [ -n "$selected" ]; then set -- "$@" "$selected"; fi
fi

case "$1" in
  check|apply|restore|launch) ;;
  *) printf '%s\n' '用法：<check|apply|restore|launch> [应用路径] [-- 启动参数]' >&2; exit 1 ;;
esac
target=
if [ "$#" -ge 2 ] && [ "$2" != -- ]; then target=${2:-$PWD}; fi

if [ "$platform" = macos ]; then
  PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
  local_app="$HOME/Applications/Desktop Plus.app"
  default_app='/Applications/Desktop Plus.app'
  if [ -d "$local_app" ]; then default_app=$local_app; fi
else
  default_app=/usr/lib/desktop-plus
  if [ ! -d "$default_app" ] && [ -d /usr/lib64/desktop-plus ]; then
    default_app=/usr/lib64/desktop-plus
  fi
fi
target=${target:-$default_app}
case "$target" in
  /*) ;;
  *) target="$PWD/$target" ;;
esac

runtime_dir=
app_run=
root_user=$(id -u)
if [ "$root_user" = 0 ]; then
  case "$platform:$1:$target" in
    macos:*|linux:launch:*|*.[Aa][Pp][Pp][Ii][Mm][Aa][Gg][Ee])
      printf '%s\n' '请使用普通用户运行；只有 Linux 系统安装的 apply 和 restore 可能需要 sudo。' >&2
      exit 1 ;;
  esac
fi

# Only use a root-controlled executable for operations started via sudo.
trusted_system_executable() {
  path=$(readlink -f -- "$1") || return 1
  [ -f "$path" ] || return 1
  executable=$path
  while :; do
    policy=$(stat -c '%u:%a' -- "$path") || return 1
    case "$policy" in
      0:*) mode=${policy#*:} ;;
      *) return 1 ;;
    esac
    [ "$((0$mode & 022))" -eq 0 ] || return 1
    [ "$path" != / ] || break
    path=$(dirname -- "$path")
  done
  printf '%s\n' "$executable"
}

can_run_as_node() {
  # Electron fuse wire v1 stores RunAsNode at index zero, after two header bytes.
  # Check every slice of a universal macOS binary before attempting the probe.
  wire_file=$1
  sentinel=dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX
  offsets=$(LC_ALL=C grep -aobF "$sentinel" < "$wire_file") || return 1
  for hit in $offsets; do
    offset=${hit%%:*}
    wire=$(LC_ALL=C od -An -t u1 -j "$((offset + ${#sentinel}))" -N 3 "$wire_file") || return 1
    set -- $wire
    [ "$#" -eq 3 ] && [ "$1" -eq 1 ] && [ "$2" -ge 1 ] && [ "$3" -eq 49 ] || return 1
  done
}

run_electron() {
  if [ -n "$app_run" ]; then
    DESKTOP_PLUS_ZH_CN_RUNTIME_APPDIR="$app_dir" ELECTRON_RUN_AS_NODE=1 "$app_run" "$@"
  else
    ELECTRON_RUN_AS_NODE=1 "$electron" "$@"
  fi
}

case "$platform:$target" in
  macos:*)
    electron="$target/Contents/MacOS/Desktop Plus"
    fuse_file="$target/Contents/Frameworks/Electron Framework.framework/Electron Framework"
    ;;
  linux:*.[Aa][Pp][Pp][Ii][Mm][Aa][Gg][Ee])
    electron=
    fuse_file=
    if [ -f "$target" ] && [ -x "$target" ] &&
       runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/desktop-plus-zh-cn.XXXXXXXX"); then
      trap 'rm -rf -- "$runtime_dir"' 0
      trap 'exit 130' INT
      trap 'exit 143' TERM
      if (cd -- "$runtime_dir" && "$target" --appimage-extract) >/dev/null 2>&1; then
        app_dir=$(CDPATH= cd -- "$runtime_dir/squashfs-root" && pwd -P) || app_dir=
        if [ -n "$app_dir" ] && [ -x "$app_dir/AppRun" ]; then
          app_run="$app_dir/AppRun"
          electron="$app_dir/desktop-plus"
          fuse_file=$electron
        fi
      fi
    fi
    ;;
  linux:*)
    electron="$target/desktop-plus"
    fuse_file=$electron
    ;;
esac

if [ "$root_user" = 0 ]; then
  electron=$(trusted_system_executable "$electron") || electron=
  fuse_file=$electron
fi

probe='if (Number(process.versions.node.split(".")[0]) >= 22) process.stdout.write("ready")'
if [ -f "$electron" ] && [ -x "$electron" ] && [ -f "$fuse_file" ] &&
   can_run_as_node "$fuse_file" &&
   [ "$(run_electron -e "$probe" 2>/dev/null)" = ready ]; then
  run_electron "$tool" "$@"
elif command -v node >/dev/null 2>&1 && [ "$(node -e "$probe" 2>/dev/null)" = ready ]; then
  node "$tool" "$@"
else
  printf '%s\n' '无法使用 Desktop Plus 自带的运行时。请选择支持的 Desktop Plus 安装，或安装 Node.js 22 及以上版本。' >&2
  exit 1
fi

