import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { runUnix } from './desktop-plus-zh-cn-unix.mjs'

const cli = fileURLToPath(new URL('./desktop-plus-zh-cn.mjs', import.meta.url))
const bootName = 'desktop-plus-zh-cn.cjs'
const original =
  '\uFEFF{\r\n  "name": "desktop-plus",\r\n  "main": "./main.js"\r\n}\r\n'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-plus-zh-cn-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = join(root, 'packages')
  await mkdir(packages)

  async function addVersion(version, descriptor = original) {
    const versionPath = join(root, `app-${version}`)
    const appPath = join(versionPath, 'resources', 'app')
    const executable = join(versionPath, 'DesktopPlus.exe')
    await mkdir(appPath, { recursive: true })
    await Promise.all([
      writeFile(executable, ''),
      writeFile(join(appPath, 'main.js'), ''),
      writeFile(join(appPath, 'index.html'), ''),
      writeFile(join(appPath, 'package.json'), descriptor),
    ])
    return { appPath, executable, descriptor: join(appPath, 'package.json') }
  }

  async function registerVersions(...versions) {
    const ledger = versions
      .map(version => `${'a'.repeat(40)} DesktopPlus-${version}-full.nupkg 1`)
      .join('\n')
    await writeFile(join(packages, 'RELEASES'), ledger)
  }

  const command = action =>
    spawnSync(process.execPath, [cli, action, root], { encoding: 'utf8' })
  return { addVersion, registerVersions, command }
}

test('localizes compact commit graph weekdays and date styles', async () => {
  const catalog = JSON.parse(await readFile(new URL('./zh-CN.json', import.meta.url), 'utf8'))
  const graphDateRules = catalog.rendererPatterns
    .filter(([selector]) => selector.split(', ').includes('.commitGraph-date'))
    .map(([, pattern, translation, flags]) => [new RegExp(pattern, flags), translation])
  const localizeDate = text => graphDateRules.reduce(
    (result, [pattern, translation]) => result.replace(pattern, translation),
    text
  )
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  for (const [i, day] of weekdays.entries()) {
    assert.equal(localizeDate(day + ' 14:44'), '星期' + '一二三四五六日'[i] + ' 14:44')
  }
  assert.equal(localizeDate('Friday 2:44 PM'), '星期五 下午 2:44')
  assert.equal(localizeDate('Tuesday 09.13 am'), '星期二 上午 09.13')
  assert.equal(localizeDate('Wednesday, January 21, 2026 at 2:44 PM'), '星期三 2026年1月21日 下午 2:44')
  assert.equal(localizeDate('Jan 19, 2026, 2:30 PM'), '2026年1月19日 下午 2:30')
  assert.equal(localizeDate('1/19/26, 2:44 PM'), '1/19/26, 下午 2:44')
  assert.equal(localizeDate('October 19th, 2017 (MMMM do, yyyy)'), '2017年10月19日 (MMMM do, yyyy)')
  assert.equal(localizeDate('Friday release notes'), 'Friday release notes')
  assert.equal(localizeDate('14:44'), '14:44')
})

test('applies only to the newest registered release and restores its original descriptor', async t => {
  const { addVersion, registerVersions, command } = await fixture(t)
  const old = await addVersion('3.6.12-r2')
  const current = await addVersion('3.6.12-r10')
  const staged = await addVersion('3.7.0')
  await registerVersions('3.6.12-r10', '3.6.12-r2')

  assert.match(command('check').stdout, /app-3\.6\.12-r10 可应用/)
  assert.equal(await readFile(current.descriptor, 'utf8'), original)
  assert.equal(command('apply').status, 0)
  const patched = await readFile(current.descriptor, 'utf8')
  assert.match(patched, /"main": "\.\/desktop-plus-zh-cn\.cjs"/)
  assert.equal(await readFile(old.descriptor, 'utf8'), original)
  assert.equal(await readFile(staged.descriptor, 'utf8'), original)
  assert.equal(command('apply').status, 0)
  assert.equal(await readFile(current.descriptor, 'utf8'), patched)
  assert.equal(command('uninstall').status, 0)
  assert.equal(await readFile(current.descriptor, 'utf8'), original)
})

test('keeps an unfamiliar application entry untouched', async t => {
  const { addVersion, registerVersions, command } = await fixture(t)
  const different = original.replace('./main.js', './other.js')
  const { descriptor } = await addVersion('4.0.0', different)
  await registerVersions('4.0.0')
  assert.equal(command('apply').status, 1)
  assert.equal(await readFile(descriptor, 'utf8'), different)
})

test('keeps menu behavior and carries the plugin forward before updater listeners run', async t => {
  const { addVersion, registerVersions, command } = await fixture(t)
  const current = await addVersion('3.6.12-r0')
  const next = await addVersion('3.7.0')
  const later = await addVersion('3.8.0')
  await registerVersions('3.6.12-r0')
  assert.equal(command('apply').status, 0)

  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => current.appPath,
  })
  const autoUpdater = new EventEmitter()
  class Menu {
    constructor(items) {
      this.items = items
    }

    static buildFromTemplate(template) {
      return template
    }

    popup(options) {
      return options
    }
  }
  const filename = join(current.appPath, bootName)
  const require = createRequire(import.meta.url)
  const bootstrap = await readFile(filename, 'utf8')
  const main = {}
  const dialog = {
    showMessageBox: (...args) => args,
    showOpenDialog: (...args) => args,
  }
  const errors = []
  const module = {}
  runInNewContext(bootstrap, {
    __filename: filename,
    module,
    process: { argv: [], execPath: current.executable },
    console: { error: error => errors.push(error) },
    require(name) {
      if (name === 'electron') {
        return { app, autoUpdater, dialog, Menu }
      }
      return name === './main.js' ? main : require(name)
    },
  })
  assert.equal(module.exports, main)
  const reveal = {
    title: 'Reveal Repository in Finder?',
    message: 'This repository might be an application.',
    buttons: ['Reveal in Finder', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  }
  const window = {}
  const [parent, translated] = dialog.showMessageBox(window, reveal)
  assert.equal(parent, window)
  assert.equal(translated.title, '在 Finder 中显示仓库？')
  assert.deepEqual(Array.from(translated.buttons), ['在 Finder 中显示', '取消'])
  assert.equal(translated.defaultId, reveal.defaultId)
  assert.equal(translated.cancelId, reveal.cancelId)
  assert.equal(reveal.buttons[1], 'Cancel')
  const unrelated = { title: 'Permission denied' }
  assert.equal(dialog.showMessageBox(unrelated)[0], unrelated)
  const executableFilter = { name: 'Executables', extensions: ['exe', 'com'] }
  const otherFilter = { name: 'All Files', extensions: ['*'] }
  const picker = { defaultPath: 'C:/fixture/editor.exe', filters: [executableFilter, otherFilter] }
  const [pickerParent, translatedPicker] = dialog.showOpenDialog(window, picker)
  assert.equal(pickerParent, window)
  assert.equal(translatedPicker.defaultPath, picker.defaultPath)
  assert.equal(translatedPicker.filters[0].name, '可执行文件')
  assert.equal(translatedPicker.filters[0].extensions, executableFilter.extensions)
  assert.equal(translatedPicker.filters[1], otherFilter)
  assert.equal(executableFilter.name, 'Executables')
  const copilotPicker = { title: 'Choose GitHub Copilot', filters: [otherFilter] }
  assert.equal(dialog.showOpenDialog(copilotPicker)[0].title, '选择 GitHub Copilot')
  assert.equal(dialog.showOpenDialog(unrelated)[0], unrelated)
  const click = () => {}
  const action = {
    id: 'new-repository',
    label: 'New &repository…',
    accelerator: 'Ctrl+N',
    click,
  }
  const unknown = { id: 'new-command', label: 'New feature' }
  const menu = Menu.buildFromTemplate([
    { label: '&File', submenu: [action, unknown] },
    { id: 'repository', label: '&Repository' },
  ])
  assert.equal(menu[0].label, '文件 (&F)')
  assert.equal(menu[0].submenu[0].id, action.id)
  assert.equal(menu[0].submenu[0].label, '新建仓库… (&R)')
  assert.equal(menu[0].submenu[0].accelerator, action.accelerator)
  assert.equal(menu[0].submenu[0].click, click)
  assert.equal(menu[0].submenu[1].label, unknown.label)
  assert.equal(action.label, 'New &repository…')

  const labels = [
    ['Include files in folder', '将文件夹中的文件纳入提交'],
    ['Exclude files in folder', '将文件夹中的文件从提交中排除'],
    ['Discard all changes in folder...', '丢弃文件夹中的所有更改…'],
    ['Reset to commit...', '重置到此提交…'],
    ['Reorder commit', '调整提交顺序'],
    ['Revert changes in commit', '还原此提交的更改'],
    ['Not uploaded to GitHub', '未上传到 GitHub'],
    ['Discard 3 selected changes…', '丢弃选中的 3 项更改…'],
    ['Discard removed lines', '撤销所选行的删除'],
    ['Reorder 2 commits…', '调整 2 个提交的顺序…'],
    ['Create alias', '创建别名'],
    ['Move to group', '移至分组'],
    ['Show worktrees', '显示工作树'],
    ['New worktree...', '新建工作树…'],
    ['Copy repo name', '复制仓库名称'],
    ['Copy repo path', '复制仓库路径'],
    ['Open repository in new window', '在新窗口中打开仓库'],
    ['View in your browser', '在浏览器中查看'],
    ['Snooze...', '暂停更新…'],
    ['Copy branch name', '复制分支名称'],
    ['Checkout in new worktree...', '在新工作树中检出…'],
    ['Pull branch', '拉取分支'],
    ['Delete', '删除'],
    ['Add Co-Authors', '添加共同作者'],
    ['Remove co-authors', '移除共同作者'],
    ['Enable Commit Spellcheck', '开启提交说明拼写检查'],
    ['Disable commit spellcheck', '关闭提交说明拼写检查'],
  ]
  const items = labels.map(([label]) => ({ label, enabled: false, click }))
  const contextMenu = new Menu(items)
  const options = { x: 10, y: 20 }
  assert.equal(contextMenu.popup(options), options)
  assert.deepEqual(
    items,
    labels.map(([, label]) => ({ label, enabled: false, click }))
  )

  const groupSubmenu = new Menu([
    { label: 'Pinned', type: 'checkbox', checked: true, click },
    { type: 'separator' },
    { label: 'Pinned', type: 'checkbox', checked: false, click },
    { label: 'Copy repo name', type: 'checkbox', checked: false, click },
    { type: 'separator' },
    { label: 'New group…', click },
    { label: 'Remove from group', click },
  ])
  const groupsItem = { label: 'Move to Group', submenu: groupSubmenu }
  const groupMenu = new Menu([groupsItem])
  groupMenu.popup(options)
  groupMenu.popup(options)
  assert.equal(groupsItem.label, '移至分组')
  assert.deepEqual(groupSubmenu.items.map(item => item.label), [
    '置顶', undefined, 'Pinned', 'Copy repo name', undefined, '新建分组…', '从分组中移除',
  ])
  assert.equal(groupSubmenu.items[0].checked, true)
  assert.equal(groupSubmenu.items[0].click, click)

  autoUpdater.emit('update-downloaded', {}, '', '3.7.0')
  assert.match(
    await readFile(next.descriptor, 'utf8'),
    /desktop-plus-zh-cn\.cjs/
  )
  assert.equal(await readFile(join(next.appPath, bootName), 'utf8'), bootstrap)

  assert.equal(command('uninstall').status, 0)
  autoUpdater.emit('update-downloaded', {}, '', '3.8.0')
  assert.equal(await readFile(later.descriptor, 'utf8'), original)
  assert.deepEqual(errors, [])
})

async function unixFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-plus-zh-cn-unix-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'user home')
  await mkdir(home)

  async function createApp(directory, platform) {
    const base = platform === 'darwin' ? join(directory, 'Contents') : directory
    const app = join(base, platform === 'darwin' ? 'Resources' : 'resources', 'app')
    const executable = platform === 'darwin'
      ? join(base, 'MacOS', 'Desktop Plus')
      : join(base, 'desktop-plus')
    await mkdir(app, { recursive: true })
    if (platform === 'darwin') {
      await mkdir(join(base, 'MacOS'))
      await writeFile(join(base, 'Info.plist'), 'Desktop Plus')
    }
    const descriptor = join(app, 'package.json')
    await Promise.all([
      writeFile(descriptor, original),
      writeFile(join(app, 'index.html'), ''),
      writeFile(join(app, 'main.js'), ''),
      writeFile(executable, ''),
    ])
    return { app, descriptor, executable }
  }

  return { root, home, createApp }
}

test('Linux installed packages can apply, restore and reapply after a package upgrade', async t => {
  const { root, home, createApp } = await unixFixture(t)
  const appRoot = join(root, 'desktop-plus')
  const { app, descriptor, executable } = await createApp(appRoot, 'linux')
  const launches = []
  const command = (action, args = []) => runUnix(action, appRoot, args, {
    platform: 'linux',
    home,
    uid: 1000,
    async startApp(path, forwarded, env) {
      launches.push([path, forwarded, env.ELECTRON_RUN_AS_NODE])
    },
  })

  assert.match(await command('check'), /可应用/)
  await command('apply')
  assert.match(await readFile(descriptor, 'utf8'), /desktop-plus-zh-cn\.cjs/)
  const bootstrap = await readFile(join(app, bootName), 'utf8')
  const main = {}
  const module = {}
  const require = createRequire(import.meta.url)
  const electron = {
    app: Object.assign(new EventEmitter(), { getAppPath: () => app }),
    Menu: { buildFromTemplate() {} },
  }
  runInNewContext(bootstrap, {
    module,
    process: { argv: [] },
    console: { error: (_message, error) => { throw error } },
    require(name) {
      if (name === 'electron') return electron
      return name === './main.js' ? main : require(name)
    },
  })
  assert.equal(module.exports, main)
  assert.equal(electron.app.listenerCount('web-contents-created'), 1)
  await command('launch', ['--test-argument'])
  assert.deepEqual(launches, [[executable, ['--test-argument'], undefined]])

  await writeFile(descriptor, original)
  assert.match(await command('check'), /可应用/)
  await command('apply')
  await command('restore')
  assert.equal(await readFile(descriptor, 'utf8'), original)
  await assert.rejects(readFile(join(app, bootName)), { code: 'ENOENT' })
  await assert.rejects(command('launch'), /先运行 apply/)
})

test('macOS signs a localized copy, refreshes it on upgrade and keeps its original', async t => {
  const { root, home, createApp } = await unixFixture(t)
  const source = join(root, 'Desktop Plus.app')
  const { app, descriptor } = await createApp(source, 'darwin')
  const moves = []
  const command = (action, args = []) => runUnix(action, source, args, {
    platform: 'darwin',
    home,
    uid: 1000,
    execute(file, argv) {
      moves.push([file, argv])
      if (file === '/usr/bin/ditto') cpSync(argv[0], argv[1], { recursive: true })
    },
  })

  assert.match(await command('check'), /还没有对应/)
  const first = (await command('apply')).split('\n').at(-1)
  const copy = join(first, 'Contents', 'Resources', 'app', 'package.json')
  assert.match(await readFile(copy, 'utf8'), /desktop-plus-zh-cn\.cjs/)
  assert.equal(await readFile(descriptor, 'utf8'), original)
  assert.deepEqual(moves.map(([file, args]) => [file, args[0]]), [
    ['/usr/bin/ditto', source],
    ['/usr/bin/codesign', '--force'],
    ['/usr/bin/codesign', '--verify'],
  ])
  assert.match(await command('check'), /已就绪/)
  assert.equal(moves.length, 3)

  await writeFile(join(app, 'main.js'), '// upgraded')
  const second = (await command('launch', ['--test-argument'])).split('\n').at(-1)
  assert.notEqual(second, first)
  assert.deepEqual(moves.at(-1), ['/usr/bin/open', ['-a', second, '--args', '--test-argument']])
  await command('restore')
  await assert.rejects(stat(first), { code: 'ENOENT' })
  await assert.rejects(stat(second), { code: 'ENOENT' })
  assert.equal(await readFile(descriptor, 'utf8'), original)
})

test('an AppImage uses its extracted launcher and restore preserves the original file', async t => {
  const { root, home, createApp } = await unixFixture(t)
  const source = join(root, 'Desktop Plus x64.AppImage')
  await writeFile(source, 'upstream AppImage')
  const extracted = join(root, 'upstream tree')
  const { descriptor } = await createApp(extracted, 'linux')
  await writeFile(join(extracted, 'AppRun'), '')
  const runtimeAppDir = join(root, 'temporary runtime')
  const hostPath = join(root, 'system-bin')
  const environment = {
    APPDIR: runtimeAppDir,
    APPIMAGE: source,
    DESKTOP_PLUS_ZH_CN_RUNTIME_APPDIR: runtimeAppDir,
    PATH: [runtimeAppDir, join(runtimeAppDir, 'usr', 'sbin'), hostPath].join(delimiter),
    LD_LIBRARY_PATH: join(runtimeAppDir, 'usr', 'lib'),
  }
  const originalEnv = Object.entries(environment).map(([name]) => [name, process.env[name]])
  t.after(() => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  Object.assign(process.env, environment)
  let extractions = 0
  const launches = []
  const command = action => runUnix(action, source, [], {
    platform: 'linux',
    home,
    uid: 1000,
    execute(file, argv, options) {
      assert.equal(file, source)
      assert.deepEqual(argv, ['--appimage-extract'])
      cpSync(extracted, join(options.cwd, 'squashfs-root'), { recursive: true })
      extractions++
    },
    async startApp(executable, args, env) {
      assert.equal(env.DESKTOP_PLUS_ZH_CN_RUNTIME_APPDIR, undefined)
      assert.equal(env.PATH, hostPath)
      assert.equal(env.LD_LIBRARY_PATH, undefined)
      launches.push([executable, args, env.APPDIR, env.APPIMAGE])
    },
  })

  const first = (await command('launch')).split('\n').at(-1)
  assert.deepEqual(launches, [[first, [], undefined, undefined]])
  assert.match(await readFile(join(dirname(first), 'resources', 'app', 'package.json'), 'utf8'), /desktop-plus-zh-cn\.cjs/)
  assert.equal(await readFile(descriptor, 'utf8'), original)
  await command('apply')
  assert.equal(extractions, 1)

  await writeFile(source, 'updated upstream AppImage')
  const second = (await command('apply')).split('\n').at(-1)
  assert.notEqual(second, first)
  assert.equal(extractions, 2)
  await command('restore')
  await assert.rejects(stat(first), { code: 'ENOENT' })
  await assert.rejects(stat(second), { code: 'ENOENT' })
  assert.equal(await readFile(source, 'utf8'), 'updated upstream AppImage')
})

