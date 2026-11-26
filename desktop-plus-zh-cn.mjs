import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import installation from './installation.cjs'
import runtime from './runtime.cjs'

const { createInstallation } = installation
const { findCurrentVersion, prepare, uninstall } = createInstallation()

function report(message) {
  const prefix = process.env.DESKTOP_PLUS_ZH_CN_GUI === '1' ? 'ZH-CN: ' : ''
  console.log(`${prefix}${message}`)
}

async function buildBootstrap() {
  const catalog = JSON.parse(
    await readFile(new URL('./zh-CN.json', import.meta.url), 'utf8')
  )
  return runtime.buildBootstrap(catalog, createInstallation)
}

async function launch(executable) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

async function run() {
  const [command = 'launch', installationPath, ...extra] = process.argv.slice(2)
  if (
    extra.length > 0 ||
    !['check', 'apply', 'launch', 'uninstall'].includes(command)
  ) {
    throw new Error(
      '用法：node desktop-plus-zh-cn.mjs [check|apply|launch|uninstall] [安装目录]'
    )
  }
  if (installationPath === undefined && !process.env.LOCALAPPDATA) {
    throw new Error('无法找到 LOCALAPPDATA，请提供 Desktop Plus 安装目录。')
  }
  const root = resolve(
    installationPath ?? join(process.env.LOCALAPPDATA, 'DesktopPlus')
  )
  if (command === 'uninstall') {
    const restored = uninstall(root)
    if (restored.length === 0) {
      report('当前安装未启用汉化。')
    }
    for (const version of restored) {
      report(`已恢复 ${version} 的英文入口。`)
    }
    return
  }

  let executable
  try {
    const version = findCurrentVersion(root)
    const bootstrap = command === 'check' ? undefined : await buildBootstrap()
    const result = prepare(root, version, bootstrap)
    if (command === 'check') {
      const status = result.localized
        ? '已启用简体中文。可重新应用以更新词表。'
        : '可应用简体中文。'
      report(`${version} ${status}`)
    } else {
      report(`已为 ${version} 应用简体中文。`)
    }
    executable = result.executable
  } catch (error) {
    if (command !== 'launch') {
      throw error
    }
    console.error(`本次未能应用汉化，将使用默认启动器。${error.message}`)
    executable = join(root, 'DesktopPlus.exe')
  }

  if (command === 'launch') {
    await launch(executable)
  }
}

run().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
