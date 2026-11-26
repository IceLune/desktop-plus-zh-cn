import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import installation from './installation.cjs'
import runtime from './runtime.cjs'

const { prepareApp, restoreApp } = installation.createInstallation()
const actions = ['check', 'apply', 'restore', 'launch']
const generationName = /^[a-f0-9]{64}$/
const bundleName = 'Desktop Plus.app'
const appImageTree = 'squashfs-root'

const digest = value => createHash('sha256').update(value).digest('hex')

function locate(platform, home, input) {
  if (platform === 'darwin') {
    const local = join(home, 'Applications', bundleName)
    const source = resolve(input ?? (statSync(local, { throwIfNoEntry: false })
      ? local
      : join('/Applications', bundleName)))
    if (extname(source).toLowerCase() !== '.app') {
      throw new Error('请先解压上游 macOS ZIP，再指定其中的 Desktop Plus.app。')
    }
    return { kind: 'macos', source }
  }

  if (platform === 'linux') {
    const locations = ['/usr/lib/desktop-plus', '/usr/lib64/desktop-plus']
    const source = resolve(input ?? locations.find(path => statSync(path, {
      throwIfNoEntry: false,
    })?.isDirectory()) ?? locations[0])
    const extension = extname(source).toLowerCase()
    if (extension === '.appimage') {
      return { kind: 'appimage', source }
    }
    if (extension === '.deb' || extension === '.rpm') {
      throw new Error('请先用系统包管理器安装 DEB 或 RPM，再运行汉化工具。')
    }
    return { kind: 'linux', source }
  }

  throw new Error('此入口适用于 macOS 和 Linux。Windows 请使用汉化 EXE。')
}

function appLayout(kind, root) {
  const resources = kind === 'macos' ? join(root, 'Contents', 'Resources') : join(root, 'resources')
  const appPath = join(resources, 'app')
  const executable = kind === 'macos'
    ? join(root, 'Contents', 'MacOS', 'Desktop Plus')
    : join(root, 'desktop-plus')

  // The supported packages contain an unpacked app. Resolve it before writing
  // so that a symlink cannot redirect a write out of the selected application.
  const appRelative = relative(realpathSync(root), realpathSync(appPath))
  if (appRelative === '' || appRelative === '..' || appRelative.startsWith('..' + sep) ||
      isAbsolute(appRelative)) {
    throw new Error('应用资源目录不在指定安装路径内。')
  }
  const descriptor = lstatSync(join(appPath, 'package.json'))
  if (!descriptor.isFile()) {
    throw new Error('应用的 package.json 必须是普通文件。')
  }
  return { appPath, executable }
}

function versionStamp({ kind, source }, bootstrap) {
  const files = kind === 'macos'
    ? [
        source,
        join(source, 'Contents', 'Info.plist'),
        join(source, 'Contents', 'MacOS', 'Desktop Plus'),
        join(source, 'Contents', 'Resources', 'app', 'package.json'),
        join(source, 'Contents', 'Resources', 'app', 'main.js'),
      ]
    : [source]
  const stats = files.map(path => {
    const { dev, ino, size, ctimeNs, mtimeNs } = statSync(path, { bigint: true })
    return [dev, ino, size, ctimeNs, mtimeNs].join(':')
  })
  return digest(JSON.stringify([stats, digest(bootstrap)]))
}

function verifyGeneration(directory, target) {
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    return false
  }
  try {
    const record = JSON.parse(readFileSync(join(directory, 'source.json'), 'utf8'))
    return record.kind === target.kind && record.source === target.source
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function stageApplication(target, staging, bootstrap, execute) {
  const mac = target.kind === 'macos'
  const root = join(staging, mac ? bundleName : appImageTree)
  if (mac) {
    const sourceLayout = appLayout('macos', target.source)
    prepareApp(sourceLayout.appPath, sourceLayout.executable)
    execute('/usr/bin/ditto', [target.source, root], { stdio: 'inherit' })
  } else {
    if (!statSync(target.source).isFile()) {
      throw new Error('请指定上游发布的 AppImage 文件。')
    }
    execute(target.source, ['--appimage-extract'], {
      cwd: staging,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    if (!lstatSync(join(root, 'AppRun')).isFile()) {
      throw new Error('找不到 AppImage 启动入口 AppRun。')
    }
  }

  const { appPath, executable } = appLayout(target.kind, root)
  prepareApp(appPath, executable, bootstrap)

  if (mac) {
    // The upstream bundle is ad-hoc signed. Only the copied outer bundle's
    // resources have changed. Its signed helpers and frameworks stay intact.
    execute('/usr/bin/codesign', [
      '--force', '--sign', '-',
      '--preserve-metadata=identifier,entitlements,flags',
      '--generate-entitlement-der', root,
    ], { stdio: 'inherit' })
    execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], { stdio: 'inherit' })
  }
}

function manageCopy(target, action, bootstrap, home, execute) {
  const base = target.kind === 'macos'
    ? join(home, 'Library', 'Application Support', 'Desktop Plus zh-CN')
    : join(home, '.local', 'share', 'desktop-plus-zh-cn')
  const slot = join(base, digest(target.source))

  if (action === 'restore') {
    let removed = 0
    if (lstatSync(slot, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of readdirSync(slot)) {
        const directory = join(slot, name)
        if (generationName.test(name) && verifyGeneration(directory, target)) {
          rmSync(directory, { recursive: true, force: true })
          removed++
        }
      }
    }
    return { message: removed > 0
      ? '已移除此原版对应的汉化副本。打开原版即可使用英文。'
      : '此安装没有需要移除的汉化副本。' }
  }

  const stamp = versionStamp(target, bootstrap)
  const directory = join(slot, stamp)
  const root = join(directory, target.kind === 'macos' ? bundleName : appImageTree)
  const launchPath = target.kind === 'macos' ? root : join(root, 'AppRun')
  if (verifyGeneration(directory, target)) {
    const { appPath, executable } = appLayout(target.kind, root)
    const launchFile = statSync(launchPath, { throwIfNoEntry: false })
    const canLaunch = target.kind === 'macos' ? launchFile?.isDirectory() : launchFile?.isFile()
    if (canLaunch && prepareApp(appPath, executable).localized) {
      return { launchPath, message: '汉化副本已就绪。' }
    }
    throw new Error('汉化副本已损坏，请先运行 restore，再重新应用。')
  }
  if (action === 'check') {
    return { message: '当前原版和词表还没有对应的汉化副本。' }
  }

  mkdirSync(slot, { recursive: true, mode: 0o700 })
  if (!lstatSync(slot).isDirectory()) {
    throw new Error('汉化副本的目标目录不可用。')
  }
  const staging = mkdtempSync(join(slot, '.stage-'))
  try {
    stageApplication(target, staging, bootstrap, execute)
    if (versionStamp(target, bootstrap) !== stamp) {
      throw new Error('原版正在更新，请在更新完成后重试。')
    }
    writeFileSync(join(staging, 'source.json'), JSON.stringify(target), { flag: 'wx' })
    try {
      renameSync(staging, directory)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) ||
          !verifyGeneration(directory, target)) {
        throw error
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return { launchPath, message: '已生成汉化副本。' }
}

async function start(executable, args, env) {
  const child = spawn(executable, args, { env, detached: true, stdio: 'ignore' })
  await new Promise((accept, reject) => {
    child.once('spawn', accept)
    child.once('error', reject)
  })
  child.unref()
}

export async function runUnix(action, input, args = [], {
  platform = process.platform,
  home = homedir(),
  uid = process.getuid?.(),
  execute = execFileSync,
  startApp = start,
} = {}) {
  if (!actions.includes(action) || (action !== 'launch' && args.length > 0)) {
    throw new Error('用法：node desktop-plus-zh-cn-unix.mjs <check|apply|restore|launch> [应用路径] [-- 启动参数]')
  }
  const target = locate(platform, home, input)
  if (uid === 0 && (action === 'launch' || target.kind !== 'linux')) {
    throw new Error('请使用普通用户运行；只有 Linux 系统安装的 apply 和 restore 可能需要 sudo。')
  }
  const catalog = JSON.parse(readFileSync(new URL('./zh-CN.json', import.meta.url), 'utf8'))
  const bootstrap = runtime.buildBootstrap(catalog)
  let launchPath
  let message
  if (target.kind === 'linux') {
    const { appPath, executable } = appLayout(target.kind, target.source)
    const status = prepareApp(appPath, executable)
    try {
      if (action === 'restore') {
        restoreApp(appPath, true)
        return '已恢复英文入口。'
      }
      if (action === 'apply') {
        prepareApp(appPath, executable, bootstrap)
        return '已应用简体中文。'
      }
    } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error('系统安装目录需要管理员权限，请用 sudo 重新执行本次 apply 或 restore。', { cause: error })
      }
      throw error
    }
    if (action === 'check') {
      return status.localized ? '已启用简体中文。' : '可应用简体中文。'
    }
    if (!status.localized) {
      throw new Error('当前安装还未应用汉化。请先运行 apply，系统软件包升级后也需要重新应用。')
    }
    launchPath = executable
    message = '正在启动 Desktop Plus。'
  } else {
    ({ launchPath, message } = manageCopy(target, action, bootstrap, home, execute))
  }

  if (action === 'launch') {
    if (target.kind === 'macos') {
      execute('/usr/bin/open', ['-a', launchPath, ...(args.length ? ['--args', ...args] : [])], {
        stdio: 'inherit',
      })
    } else {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      if (target.kind === 'appimage') {
        delete env.APPIMAGE
        delete env.APPDIR
        const runtimeAppDir = env.DESKTOP_PLUS_ZH_CN_RUNTIME_APPDIR
        delete env.DESKTOP_PLUS_ZH_CN_RUNTIME_APPDIR
        if (runtimeAppDir) {
          for (const key of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
            if (env[key] === undefined) continue
            const paths = env[key].split(delimiter).filter(
              path => path !== runtimeAppDir && !path.startsWith(runtimeAppDir + sep)
            )
            if (paths.length > 0) env[key] = paths.join(delimiter)
            else delete env[key]
          }
        }
      }
      await startApp(launchPath, args, env)
    }
  }
  return launchPath ? `${message}\n${launchPath}` : message
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flagsAt = process.argv.indexOf('--', 2)
  const positionals = process.argv.slice(2, flagsAt === -1 ? undefined : flagsAt)
  const args = flagsAt === -1 ? [] : process.argv.slice(flagsAt + 1)
  try {
    if (positionals.length === 0 && process.stdin.isTTY && flagsAt === -1) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      const menu = [
        ['launch', '启动汉化版'],
        ['apply', '应用汉化'],
        ['restore', '恢复英文'],
        ['check', '检查状态'],
      ]
      try {
        console.log(menu.map(([, label], index) => (index + 1) + '. ' + label).join('\n'))
        const choice = (await prompt.question('请选择 1–4，直接回车退出：')).trim()
        if (choice !== '') {
          const selected = menu[Number(choice) - 1]
          if (!selected) throw new Error('请选择 1–4。')
          const path = (await prompt.question('应用路径（默认位置直接回车）：')).trim()
          positionals.push(selected[0], path || undefined)
        }
      } finally {
        prompt.close()
      }
    }
    if (positionals.length > 0 || !process.stdin.isTTY || flagsAt !== -1) {
      const [action, input, ...extra] = positionals
      if (extra.length !== 0) {
        throw new Error('请将包含空格的应用路径放在引号中，或者使用 -- 传入启动参数。')
      }
      console.log(await runUnix(action, input, args))
    }
  } catch (error) {
    const stderr = error.stderr?.toString().trim()
    console.error(stderr ? `${error.message}\n${stderr}` : error.message)
    process.exitCode = 1
  }
}
