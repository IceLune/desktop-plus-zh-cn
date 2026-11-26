function createInstallation() {
  const {
    accessSync,
    chmodSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
  } = require('node:fs')
  const { randomUUID } = require('node:crypto')
  const { dirname, join } = require('node:path')

  const originalEntry = './main.js'
  const localizedEntry = './desktop-plus-zh-cn.cjs'
  const versionPattern = '\\d+\\.\\d+\\.\\d+(?:-[a-z][a-z0-9-]*)?'
  const appDirectory = new RegExp(`^app-${versionPattern}$`, 'i')
  const releaseEntry = new RegExp(
    `^[a-f0-9]{40}\\s+DesktopPlus(?:-(?:x64|arm64))?-(${versionPattern})-full\\.nupkg\\s+\\d+$`,
    'i'
  )

  const readOptional = path => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  const writeAtomically = (path, contents) => {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const mode = (statSync(path, { throwIfNoEntry: false })?.mode ?? 0o644) & 0o777
      writeFileSync(temporary, contents, { flag: 'wx', mode })
      if (process.platform !== 'win32') {
        chmodSync(temporary, mode)
      }
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  const compareVersions = (left, right) => {
    const [leftBase, ...leftSuffix] = left.toLowerCase().split('-')
    const [rightBase, ...rightSuffix] = right.toLowerCase().split('-')
    const bases = leftBase.localeCompare(rightBase, 'en', { numeric: true })
    if (bases !== 0) {
      return bases
    }
    return (
      Number(rightSuffix.length > 0) - Number(leftSuffix.length > 0) ||
      leftSuffix.join('-').localeCompare(rightSuffix.join('-'), 'en', {
        numeric: true,
      })
    )
  }

  const findCurrentVersion = root => {
    const releases = readOptional(join(root, 'packages', 'RELEASES'))
    const versions =
      releases
        ?.split(/\r?\n/)
        .map(line => releaseEntry.exec(line.trim())?.[1])
        .filter(Boolean) ?? []
    if (versions.length === 0) {
      for (const directory of readdirSync(root, { withFileTypes: true })) {
        if (directory.isDirectory() && appDirectory.test(directory.name)) {
          versions.push(directory.name.slice(4))
        }
      }
    }

    const version = versions.sort(compareVersions).at(-1)
    if (version === undefined) {
      throw new Error('找不到已安装的 Desktop Plus 版本。')
    }
    return `app-${version}`
  }

  const readDescriptor = appPath => {
    const path = join(appPath, 'package.json')
    const source = readOptional(path)
    if (source === null) {
      return null
    }
    return { path, source, data: JSON.parse(source.replace(/^\uFEFF/, '')) }
  }

  const replaceEntry = (descriptor, nextEntry) => {
    const current = JSON.stringify(descriptor.data.main)
    const entries = [...descriptor.source.matchAll(/"main"\s*:\s*("[^"\\]*")/g)]
    if (entries.length !== 1 || entries[0][1] !== current) {
      throw new Error(`无法安全修改入口文件 ${descriptor.path}`)
    }
    return descriptor.source.replace(
      entries[0][0],
      match => match.slice(0, -current.length) + JSON.stringify(nextEntry)
    )
  }

  const prepareApp = (appPath, executable, bootstrap) => {
    const descriptor = readDescriptor(appPath)
    if (
      descriptor?.data.name !== 'desktop-plus' ||
      ![originalEntry, localizedEntry].includes(descriptor.data.main)
    ) {
      throw new Error(`不受支持的 Desktop Plus 应用入口或安装布局：${appPath}`)
    }
    for (const path of [
      executable,
      join(appPath, 'main.js'),
      join(appPath, 'index.html'),
    ]) {
      accessSync(path)
    }
    const bootstrapPath = join(appPath, localizedEntry)
    const existingBootstrap = readOptional(bootstrapPath)
    if (
      existingBootstrap !== null &&
      !existingBootstrap.startsWith('// Desktop Plus zh-CN\n')
    ) {
      throw new Error(`汉化入口文件已被其他程序使用 ${bootstrapPath}`)
    }

    const nextDescriptor = replaceEntry(descriptor, localizedEntry)
    if (bootstrap !== undefined) {
      if (existingBootstrap !== bootstrap) {
        writeAtomically(bootstrapPath, bootstrap)
      }
      if (nextDescriptor !== descriptor.source) {
        writeAtomically(descriptor.path, nextDescriptor)
      }
    }
    return {
      executable,
      localized:
        descriptor.data.main === localizedEntry && existingBootstrap !== null,
    }
  }

  const prepare = (root, version, bootstrap) => {
    const versionPath = join(root, version)
    return prepareApp(
      join(versionPath, 'resources', 'app'),
      join(versionPath, 'DesktopPlus.exe'),
      bootstrap
    )
  }

  const carryForward = (appPath, executable, bootstrapPath, releaseName) => {
    const descriptor = readDescriptor(appPath)
    if (descriptor?.data.main !== localizedEntry) {
      return // The user may have disabled localization while this instance was running.
    }
    const root = dirname(dirname(executable))
    const releasedDirectory = `app-${releaseName}`
    const version = appDirectory.test(releasedDirectory)
      ? releasedDirectory
      : findCurrentVersion(root)
    if (
      join(root, version).toLowerCase() !== dirname(executable).toLowerCase()
    ) {
      prepare(root, version, readFileSync(bootstrapPath, 'utf8'))
    }
  }

  const restoreApp = (appPath, removeBootstrap = false) => {
    const descriptor = readDescriptor(appPath)
    if (descriptor?.data.name !== 'desktop-plus') {
      return false
    }

    const restored = descriptor.data.main === localizedEntry
    if (restored) {
      accessSync(join(appPath, 'main.js'))
      writeAtomically(descriptor.path, replaceEntry(descriptor, originalEntry))
    }
    if (removeBootstrap && (restored || descriptor.data.main === originalEntry)) {
      const bootstrapPath = join(appPath, localizedEntry)
      if (readOptional(bootstrapPath)?.startsWith('// Desktop Plus zh-CN\n')) {
        rmSync(bootstrapPath, { force: true })
      }
    }
    return restored
  }

  const uninstall = root => {
    const restored = []
    for (const directory of readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !appDirectory.test(directory.name)) {
        continue
      }
      const appPath = join(root, directory.name, 'resources', 'app')
      if (restoreApp(appPath)) {
        restored.push(directory.name)
      }
    }
    return restored
  }

  return { findCurrentVersion, prepare, prepareApp, restoreApp, carryForward, uninstall }
}

module.exports = { createInstallation }
