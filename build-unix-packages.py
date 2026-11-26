"""Build and verify DMG and AppImage packages from pinned runtime downloads."""

import argparse
import hashlib
import io
import plistlib
import re
import shutil
import stat
import struct
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

from fs_explorer import Source, create


ROOT = Path(__file__).resolve().parent
APPIMAGE_VERSION = "20251108"
TITLE = "Desktop Plus 简体中文插件"
BUNDLE = "DesktopPlus-zh-CN.app"
SCRIPT_FILES = (
    "desktop-plus-zh-cn-unix.mjs",
    "installation.cjs",
    "runtime.cjs",
    "zh-CN.json",
    "README.md",
    "licenses/desktop-plus.txt",
)
ASSET_HASHES = {
    "runtime-aarch64": "00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444",
    "runtime-x86_64": "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
    "appimage-runtime-license.txt": "aa154fc9070614bbe7921f89db11efd1dba7a1f3a41685958110e2230f9c0ca1",
}
Payload = dict[str, tuple[bytes, int]]


def asset(directory: Path, name: str) -> Path:
    path = directory / name
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != ASSET_HASHES[name]:
        raise ValueError(f"SHA-256 mismatch: {path}")
    return path


def add_bytes(payload: Payload, name: str, data: bytes, mode: int = 0o644) -> None:
    payload[name] = (data, mode)


def add_scripts(payload: Payload, directory: str) -> None:
    for file in SCRIPT_FILES:
        add_bytes(payload, f"{directory}/{file}", (ROOT / file).read_bytes())


def add_entrypoint(payload: Payload, source: str, destination: str) -> None:
    text = (ROOT / "packaging" / source).read_text(encoding="utf-8-sig")
    add_bytes(payload, destination, text.encode("utf-8"), 0o755)


def write_tree(path: Path, payload: Payload) -> None:
    """Preserve Unix permission bits even on Windows by staging in tar."""
    parents = {
        parent.as_posix()
        for name in payload
        for parent in PurePosixPath(name).parents
        if parent != PurePosixPath(".")
    }
    with tarfile.open(path, "w", format=tarfile.PAX_FORMAT) as archive:
        for path_string in sorted(parents):
            entry = tarfile.TarInfo(path_string)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)
        for name, (data, mode) in sorted(payload.items()):
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = mode
            archive.addfile(entry, io.BytesIO(data))


def verify_files(image: Source, payload: Payload) -> None:
    files = {
        entry.path: entry
        for entry in image.entries("/", recursive=-1)
        if stat.S_ISREG(entry.mode)
    }
    expected_paths = {"/" + name for name in payload}
    if files.keys() != expected_paths:
        raise ValueError(f"Unexpected image entries: {files.keys() ^ expected_paths}")
    for name, (data, mode) in payload.items():
        path = "/" + name
        with image.open_file(path) as stream:
            digest = hashlib.file_digest(stream, "sha256").digest()
        if digest != hashlib.sha256(data).digest():
            raise ValueError(f"Image content mismatch: {name}")
        if stat.S_IMODE(files[path].mode) != mode:
            raise ValueError(f"Image mode mismatch: {name} ({files[path].mode:o})")


def build_dmg(output: Path, work: Path, version: str, icon: bytes) -> Path:
    contents = f"{BUNDLE}/Contents"
    resources = f"{contents}/Resources"
    payload: Payload = {}
    add_scripts(payload, resources)
    add_entrypoint(payload, "macos-launcher.sh", f"{contents}/MacOS/DesktopPlusZhCN")
    apple_script = (ROOT / "packaging/macos-dialog.applescript").read_text(encoding="utf-8-sig")
    add_bytes(payload, f"{resources}/macos-dialog.applescript", apple_script.encode("utf-8"))
    icon_entry = b"ic08" + struct.pack(">I", len(icon) + 8) + icon
    add_bytes(payload, f"{resources}/icon.icns", b"icns" + struct.pack(">I", len(icon_entry) + 8) + icon_entry)
    plist = {
        "CFBundleDevelopmentRegion": "zh_CN",
        "CFBundleDisplayName": TITLE,
        "CFBundleExecutable": "DesktopPlusZhCN",
        "CFBundleIconFile": "icon.icns",
        "CFBundleIdentifier": "org.desktopplus.zh-cn",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": TITLE,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
    }
    add_bytes(payload, f"{contents}/Info.plist", plistlib.dumps(plist))
    add_bytes(payload, "README.md", (ROOT / "README.md").read_bytes())
    add_entrypoint(payload, "unix-runtime.sh", f"{resources}/unix-runtime.sh")

    image = work / "macos-tree.tar"
    write_tree(image, payload)
    dmg = output / "DesktopPlus-zh-CN-macOS.dmg"
    with Source(image) as tree:
        create.dmg(dmg, [create.FromSource(tree, "/")], fs="apfs", format="UDZO",
                   volname=f"Desktop Plus zh-CN {version}")
    with Source(dmg) as result:
        verify_files(result, payload)
    return dmg


def build_appimage(downloads: Path, output: Path, work: Path, arch: str,
                   runtime_arch: str, elf_machine: int, icon: bytes) -> Path:
    resources = "usr/share/desktop-plus-zh-cn"
    payload: Payload = {}
    add_scripts(payload, resources)
    add_entrypoint(payload, "linux-apprun.sh", "AppRun")
    add_bytes(payload, "desktop-plus-zh-cn.desktop",
              (ROOT / "packaging/desktop-plus-zh-cn.desktop").read_text(encoding="utf-8-sig").encode("utf-8"))
    add_bytes(payload, "desktop-plus-zh-cn.png", icon)
    add_bytes(payload, ".DirIcon", icon)
    add_entrypoint(payload, "unix-runtime.sh", f"{resources}/unix-runtime.sh")
    add_bytes(payload, f"{resources}/licenses/appimage-runtime.txt",
              asset(downloads, "appimage-runtime-license.txt").read_bytes())
    add_bytes(payload, f"{resources}/licenses/appimage-runtime-source.txt",
              f"https://github.com/AppImage/type2-runtime/tree/{APPIMAGE_VERSION}\n".encode("ascii"))

    runtime = asset(downloads, f"runtime-{runtime_arch}").read_bytes()
    if runtime[:4] != b"\x7fELF" or runtime[8:11] != b"AI\x02" or struct.unpack_from("<H", runtime, 18)[0] != elf_machine:
        raise ValueError(f"Incorrect AppImage runtime: {runtime_arch}")
    section_table = struct.unpack_from("<Q", runtime, 40)[0]
    section_size, section_count = struct.unpack_from("<HH", runtime, 58)
    if section_table + section_size * section_count != len(runtime):
        raise ValueError(f"AppImage runtime length differs from its ELF image size: {runtime_arch}")

    image = work / f"linux-{arch}.tar"
    filesystem = work / f"linux-{arch}.sqfs"
    write_tree(image, payload)
    with Source(image) as tree:
        create.squashfs(filesystem, [create.FromSource(tree, "/")], compression="gzip")
    with Source(filesystem) as result:
        verify_files(result, payload)

    appimage = output / f"DesktopPlus-zh-CN-Linux-{runtime_arch}.AppImage"
    with appimage.open("xb") as handle, filesystem.open("rb") as packed:
        handle.write(runtime)
        shutil.copyfileobj(packed, handle)
    appimage.chmod(0o755)
    with appimage.open("rb") as handle:
        handle.seek(len(runtime))
        if handle.read(4) != b"hsqs" or appimage.stat().st_size != len(runtime) + filesystem.stat().st_size:
            raise ValueError(f"Incorrect AppImage payload offset: {appimage}")
    return appimage


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("downloads", type=Path, help="Directory containing verified runtime inputs listed in the README")
    parser.add_argument("output", type=Path)
    parser.add_argument("--version", default="0.1.0")
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        parser.error("Use a three-part version, for example 0.1.0.")

    args.output.mkdir(parents=True, exist_ok=True)
    icon = (ROOT / "assets/icon-logo.png").read_bytes()
    if icon[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack_from(">II", icon, 16) != (256, 256):
        raise ValueError("The package icon must be a 256×256 PNG.")

    with tempfile.TemporaryDirectory(prefix=".unix-packages-", dir=args.output) as temporary:
        work = Path(temporary)
        bundles = [
            build_dmg(work, work, args.version, icon),
            build_appimage(args.downloads, work, work, "x64", "x86_64", 62, icon),
            build_appimage(args.downloads, work, work, "arm64", "aarch64", 183, icon),
        ]
        for bundle in bundles:
            if (args.output / bundle.name).exists():
                raise FileExistsError(args.output / bundle.name)
        for bundle in bundles:
            print(bundle.rename(args.output / bundle.name))


if __name__ == "__main__":
    main()
