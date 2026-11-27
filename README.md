# Desktop Plus 简体中文插件

给 [Desktop Plus](https://github.com/desktop-plus/desktop-plus) 加上简体中文界面。

## 下载

先准备好原版 Desktop Plus，再从本项目的 GitHub **Releases** 下载对应平台的一个文件。

| 平台 | 下载文件 |
| --- | --- |
| Windows | `DesktopPlus-zh-CN.exe` |
| macOS（Intel 或 Apple 芯片） | `DesktopPlus-zh-CN-macOS.dmg` |
| Linux（Intel 或 AMD 64 位） | `DesktopPlus-zh-CN-Linux-x86_64.AppImage` |
| Linux（ARM64） | `DesktopPlus-zh-CN-Linux-aarch64.AppImage` |

## 使用

先完全退出 Desktop Plus。

- **Windows** 双击 EXE，点「应用汉化」，再启动 Desktop Plus。
- **macOS** 打开 DMG，把汉化工具拖到「应用程序」，打开工具并选「启动汉化版」。
- **Linux** 给下载的 AppImage 添加执行权限后运行。原版是 DEB 或 RPM 安装时，点「应用汉化」后从原快捷方式启动。若提示权限不足，可在终端用 `sudo` 执行 `apply` 或 `restore`。原版也是 AppImage 时，指定原版文件并选「启动汉化版」。

恢复英文时，退出 Desktop Plus，在工具里选择「恢复英文」，再打开原版。软件更新后如果界面变回英文，按上面的步骤操作一次。

macOS 和 Linux 会优先借用 Desktop Plus 自带的运行时。工具提示运行时不可用时，可安装 Node.js 22 或更新版本。

<details>
<summary>从源码构建</summary>

词表在 [`zh-CN.json`](zh-CN.json)，安装包版本取自 `package.json`。

- Windows 运行 `./build-exe.ps1`。
- 构建 DMG 和 AppImage 时，使用 Python 3.11 或更新版本并安装 `fs-explorer==0.5.0`，从 [AppImage Runtime 发布页](https://github.com/AppImage/type2-runtime/releases/tag/20251108) 下载 `runtime-x86_64` 和 `runtime-aarch64`，并将该版本的 `LICENSE` 保存为 `appimage-runtime-license.txt`。将这三个文件放在 `downloads` 下，再运行 `python build-unix-packages.py ./downloads ./dist/release`。

</details>

图标来自 Desktop Plus，随项目附上[上游许可证](licenses/desktop-plus.txt)。
