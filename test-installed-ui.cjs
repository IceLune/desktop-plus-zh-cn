const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createInstallation } = require('./installation.cjs')

if (process.platform !== 'win32') {
  throw new Error('此测试需要安装 Windows 版 Desktop Plus。')
}
const installed =
  process.argv[2] ?? path.join(process.env.LOCALAPPDATA, 'DesktopPlus')
const versionName = createInstallation().findCurrentVersion(installed)
const source = path.join(installed, versionName)
const parent = path.resolve(os.tmpdir())
const root = fs.mkdtempSync(path.join(parent, 'desktop-plus-zh-cn-remotes-'))
assert.equal(path.dirname(root), parent)
const version = path.join(root, versionName)
const app = path.join(version, 'resources', 'app')
const profile = path.join(root, 'profile')
const repo = path.join(root, 'example')
const report = path.join(root, 'report.json')
const config = path.join(root, 'gitconfig')
const undoSummary = "Merge branch 'main' of https://example.test/team/repository.git"

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout
}

try {
  fs.cpSync(source, version, { recursive: true })
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, '.config-migrated'), '')
  fs.writeFileSync(
    config,
    '[user]\n name = Test Fixture\n email = fixture@example.test\n'
  )
  fs.mkdirSync(repo)
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const git = (...args) => run('git.exe', ['-C', repo, ...args], { env })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test Fixture')
  git('config', 'user.email', 'fixture@example.test')
  fs.writeFileSync(path.join(repo, 'test.txt'), 'first\n')
  git('add', '.')
  const undoDate = new Date(Date.now() - 16 * 60 * 1000).toISOString()
  run('git.exe', ['-C', repo, 'commit', '-m', undoSummary], {
    env: { ...env, GIT_AUTHOR_DATE: undoDate, GIT_COMMITTER_DATE: undoDate },
  })
  const remote = path.join(root, 'example-remote.git')
  git('branch', 'compare-fixture')
  run('git.exe', ['init', '--bare', remote], { env })

  const page = path.join(app, 'index.html')
  fs.writeFileSync(
    path.join(app, 'smoke-init.js'),
    [
      "localStorage.setItem('has-shown-welcome-flow', 'true')",
      "localStorage.setItem('auto-install-updates', 'false')",
      "localStorage.setItem('confirmRepoRemoval', 'true')",
    ].join('\n')
  )
  fs.writeFileSync(
    page,
    fs
      .readFileSync(page, 'utf8')
      .replace(/<head(?:\s[^>]*)?>/i, '$&<script src="smoke-init.js"></script>')
  )
  run(process.execPath, [
    path.join(__dirname, 'desktop-plus-zh-cn.mjs'),
    'apply',
    root,
  ])
  fs.renameSync(
    path.join(app, 'main.js'),
    path.join(app, 'smoke-original-main.js')
  )
  fs.writeFileSync(
    path.join(app, 'main.js'),
    `
    const { app, Menu } = require('electron')
    const fs = require('node:fs')
    const { execFileSync } = require('node:child_process')
    app.setPath('appData', ${JSON.stringify(profile)})
    app.setPath('userData', ${JSON.stringify(profile)})
    const out = {}
    let selectContextItem = null
    const popup = Menu.prototype.popup
    Menu.prototype.popup = function (options) {
      const result = popup.call(this, options)
      if (selectContextItem === null) {
        out.context = this.items.map(item => ({ label: item.label, type: item.type }))
      } else {
        const label = selectContextItem
        selectContextItem = null
        const item = this.items.find(entry => entry.label === label)
        item?.click({ preventDefault() {} }, options?.window, options?.window?.webContents)
      }
      this.closePopup(options?.window)
      return result
    }
    const finish = error => {
      if (error) out.error = String(error)
      fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(out))
      app.exit(error ? 1 : 0)
    }
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    let started = false
    app.on('browser-window-created', (_event, window) => {
      window.webContents.once('dom-ready', async () => {
        if (started || !window.webContents.getURL().includes('index.html')) return
        started = true
        const run = (fn, ...args) => window.webContents.executeJavaScript('(' + fn + ')(...' + JSON.stringify(args) + ')')
        const wait = async (fn, ...args) => {
          for (let index = 0; index < 60; index++) {
            const result = await run(fn, ...args)
            if (result) return result
            await pause(120)
          }
          return null
        }
        const select = async selector => {
          const result = await wait(s => Boolean(document.querySelector(s)), selector)
          if (!result) throw new Error('Missing ' + selector)
        }
        const text = async selector => {
          await select(selector)
          await pause(120)
          return run(s => document.querySelector(s).innerText, selector)
        }
        const menu = async id => {
          const item = Menu.getApplicationMenu().getMenuItemById(id)
          item.click({ preventDefault() {}, sender: window.webContents }, window, window.webContents)
          await pause(220)
        }
        const click = async selector => {
          await select(selector)
          await run(s => document.querySelector(s).click(), selector)
          await pause(200)
        }
        const clickText = async (selector, title) => {
          const result = await wait((s, t) => {
            const element = Array.from(document.querySelectorAll(s)).find(e => e.textContent.trim() === t)
            element?.click()
            return Boolean(element)
          }, selector, title)
          if (!result) throw new Error('Missing control ' + title)
          await pause(180)
        }
        const dismissDialog = async selector => {
          await select(selector)
          await pause(350)
          await run(s => document.querySelector(s).dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          ), selector)
          if (!await wait(s => !document.querySelector(s), selector)) {
            throw new Error('Could not dismiss ' + selector)
          }
        }
        const fields = selector => run(s => Array.from(document.querySelectorAll(s)).map(e => ({ placeholder: e.placeholder, label: e.getAttribute('aria-label') })), selector)
        const chooseCustomIntegration = async selector => {
          await select(selector + ' option[value=other]')
          await run(s => {
            const dropdown = document.querySelector(s)
            if (dropdown.value !== 'other') {
              dropdown.value = 'other'
              dropdown.dispatchEvent(new Event('change', { bubbles: true }))
            }
          }, selector)
        }
        const integrationInput = (id, field) => 'input[aria-describedby="' + id + '-custom-integration-' + field + '-error"]'
        const readIntegrationForm = async (scope, id) => {
          const pathInput = integrationInput(id, 'path')
          const form = scope + ' .custom-integration-form-container:has(' + pathInput + ')'
          await select(form + ' ' + integrationInput(id, 'args'))
          return run(s => {
            const container = document.querySelector(s)
            return {
              labels: Array.from(container.querySelectorAll('label'), e => e.textContent.trim()),
              placeholders: Array.from(container.querySelectorAll('input'), e => e.placeholder),
              choose: container.querySelector('button').textContent.trim(),
              args: container.querySelectorAll('input')[1].value,
            }
          }, form)
        }
        const setInput = async (selector, value) => {
          await select(selector)
          await run((s, entered) => {
            const input = document.querySelector(s)
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setValue.call(input, entered)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }, selector, value)
        }
        const requestContextMenu = async selector => {
          await select(selector)
          await run(s => {
            document.querySelector(s).dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true, cancelable: true, button: 2,
            }))
          }, selector)
        }
        const readContextLabels = async selector => {
          const previous = out.context
          out.context = null
          await requestContextMenu(selector)
          for (let index = 0; index < 30 && out.context === null; index++) {
            await pause(120)
          }
          if (out.context === null) throw new Error("No context menu for " + selector)
          const labels = out.context.map(item => item.label)
          out.context = previous
          return labels
        }
        const readHoverText = async (selector, accepted) => {
          await select(selector)
          const snapshot = await run(() => Array.from(document.querySelectorAll('[role=tooltip]'), node => node.id))
          await run(s => {
            const target = document.querySelector(s)
            const { left, top, width, height } = target.getBoundingClientRect()
            target.dispatchEvent(new MouseEvent('mouseenter', { clientX: left + width / 2, clientY: top + height / 2 }))
          }, selector)
          const result = await wait((before, phrases) => {
            for (const tip of document.querySelectorAll('[role=tooltip]')) {
              const value = tip.querySelector('.tooltip-content')?.textContent.trim()
              if (tip.id && !before.includes(tip.id) && tip.style.visibility !== 'hidden' && phrases.includes(value)) {
                return value
              }
            }
            return null
          }, snapshot, accepted)
          await run(s => document.querySelector(s)?.dispatchEvent(new MouseEvent('mouseleave')), selector)
          if (!result) throw new Error('Missing hover tooltip for ' + selector)
          return result
        }
        const readCommitTooltip = async () => {
          const selector = '.commit-button[aria-disabled=true], .commit-button-dropdown .invoke-button[aria-disabled=true]'
          await select(selector)
          await run(s => {
            const button = document.querySelector(s)
            const { left, top, width, height } = button.getBoundingClientRect()
            button.dispatchEvent(new MouseEvent('mouseenter', {
              clientX: left + width / 2, clientY: top + height / 2,
            }))
          }, selector)
          const tip = await wait(s => {
            const ids = document.querySelector(s)?.getAttribute('aria-describedby')?.split(' ') ?? []
            for (const id of ids) {
              const content = document.getElementById(id)?.querySelector('.tooltip-content')
              if (content) return content.textContent.trim()
            }
            return null
          }, selector)
          await run(s => document.querySelector(s)?.dispatchEvent(new MouseEvent('mouseleave')), selector)
          if (!tip) throw new Error('Missing commit tooltip')
          return tip
        }
        try {
          const addRepository = '#add-existing-repository'
          if (!await wait(s => Boolean(document.querySelector(s + ', #changes-tab')), addRepository)) {
            await menu('add-local-repository')
            await setInput(addRepository + ' input[type=text]', ${JSON.stringify(repo)})
          }
          if (await run(s => Boolean(document.querySelector(s)), addRepository)) {
            await click(addRepository + ' button[type=submit]')
          }
          await select('#changes-tab')
          await select('.changes-interstitial .suggested-action.primary .suggested-action-button')
          out.clean = await text('.changes-interstitial')
          out.commitSummaryTooltip = await readCommitTooltip()
          out.undoCommit = {
            time: await text('#undo-commit .ago'),
            button: await text('#undo-commit .actions button'),
            summary: await text('#undo-commit .summary'),
            label: await run(() => document.querySelector("#undo-commit").getAttribute("aria-label")),
          }
          window.webContents.send('menu-event', 'test-newer-commits-on-remote')
          const pushWarning = 'dialog.warning:not([id])'
          out.pushWarning = {
            title: await text(pushWarning + ' .dialog-header h1'),
            message: await text(pushWarning + ' .dialog-content p'),
            fetch: await text(pushWarning + ' .dialog-footer button[type=submit]'),
            cancel: await text(pushWarning + ' .dialog-footer button[type=reset]'),
          }
          await click(pushWarning + ' .dialog-footer button[type=reset]')
          out.shortcuts = await run(() => Array.from(document.querySelectorAll('.changes-interstitial .discoverability kbd'), item => item.textContent))
          await menu('open-with-external-editor')
          out.openWith = await text('#open-with-external-editor')
          const openWith = '#open-with-external-editor'
          await chooseCustomIntegration(openWith + ' select')
          out.openWithCustom = await readIntegrationForm(openWith, 'custom-editor-open-with')
          await setInput(openWith + ' ' + integrationInput('custom-editor-open-with', 'path'), 'missing-editor.exe')
          await setInput(openWith + ' ' + integrationInput('custom-editor-open-with', 'args'), '--example')
          const pathError = '#custom-editor-open-with-custom-integration-path-error'
          const argsError = '#custom-editor-open-with-custom-integration-args-error'
          out.openWithPathError = await text(pathError + ' .input-description-content')
          out.openWithArgsError = await text(argsError + ' .input-description-content')
          out.openWithAnnouncements = await run(() => Array.from(
            document.querySelectorAll('#open-with-external-editor .custom-integration-form-error [aria-live]'),
            e => e.textContent.trim()
          ))
          await dismissDialog(openWith)
          await menu('create-worktree')
          out.worktree = await text('#add-worktree')
          out.worktreeFields = await fields('#add-worktree input')
          await click('#add-worktree .dialog-footer button[type=reset]')
          await menu('create-branch')
          out.newBranch = await text('#create-branch')
          await click('#create-branch .dialog-header .close')
          if (!await wait(() => !document.querySelector('#create-branch'))) {
            throw new Error('Create branch dialog did not close')
          }
          await menu('merge-branch')
          out.mergeBranch = await text('#choose-branch')
          out.mergeFields = await fields('#choose-branch input')
          await click('#choose-branch .dialog-header .close')
          await click('.changes-interstitial .suggested-action.primary .suggested-action-button')
          out.publish = await text('#publish-repository')
          await clickText('#publish-repository .call-to-action button', '登录')
          out.browserSignIn = await text('#sign-in')
          await dismissDialog('#sign-in')
          if (await run(() => Boolean(document.querySelector('#publish-repository')))) {
            await dismissDialog('#publish-repository')
          }

          await menu('add-local-repository')
          out.addRepository = await text('#add-existing-repository')
          await clickText('#add-existing-repository button', '取消')
          await menu('clone-repository')
          out.cloneGitHub = await text('dialog.clone-repository')
          await clickText('dialog.clone-repository [role=tab]', 'URL')
          out.cloneURL = await text('dialog.clone-repository')
          await clickText('dialog.clone-repository button', '取消')
          await menu('new-repository')
          out.createRepository = await text('#create-repository')
          out.createFields = await fields('#create-repository input')
          out.createDefaults = await run(() => Array.from(document.querySelectorAll('#create-repository select'), select => ({ value: select.value, text: select.selectedOptions[0]?.textContent })))
          await clickText('#create-repository button', '取消')
          await menu('show-repository-list')
          out.repositoryMenu = await readContextLabels('.repository-list .repository-list-item')
          selectContextItem = '新建分组…'
          await click('.new-repository-button')
          out.group = await text('#create-repository-group')
          out.groupFields = await fields('#create-repository-group input')
          await clickText('#create-repository-group button', '取消')
          if (await run(() => Boolean(document.querySelector('.new-repository-button')))) await menu('show-repository-list')

          const repo = ${JSON.stringify(repo)}
          const remote = ${JSON.stringify(remote)}
          const git = (...args) => execFileSync('git.exe', ['-C', repo, ...args], { windowsHide: true })
          git('remote', 'add', 'origin', remote)
          git('push', '--set-upstream', 'origin', 'main')
          fs.writeFileSync(${JSON.stringify(
            path.join(repo, 'test.txt')
          )}, 'second\\n')
          window.emit('focus')
          await select('.diff-container .header > svg.status-modified')
          const diffOptionsButton = '.diff-options-component > button'
          const diffStatus = '.diff-container .header > svg.status-modified'
          const filtersButton = '.filter-box-container .filter-button'
          out.diffOptionsTooltip = await readHoverText(diffOptionsButton, ['差异选项', 'Diff Options'])
          out.diffOptionsLabel = await run(s => document.querySelector(s).getAttribute('aria-label'), diffOptionsButton)
          out.modifiedTooltip = await readHoverText(diffStatus, ['已修改', 'Modified'])
          out.modifiedLabel = await run(s => document.querySelector(s).getAttribute('aria-label'), diffStatus)
          out.filterOptionsTooltip = await readHoverText(filtersButton, ['筛选选项', 'Filter Options'])
          await click(filtersButton)
          await clickText('.filter-options label', '修改过的文件（1）')
          out.appliedFilterTooltip = await readHoverText(filtersButton, ['筛选选项（已应用 1 项）', 'Filter Options (1 applied)'])
          out.appliedFilterLabel = await run(s => document.querySelector(s).getAttribute('aria-label'), filtersButton)
          await click(filtersButton)
          out.clearFilterLabel = await text('.filter-options-footer button')
          await click('.filter-options-footer button')
          const allChanges = '.changes-list-check-all input[type=checkbox]'
          await click(allChanges)
          const setSummary = value => run(text => {
            const input = document.querySelector('.manual-commit-fields input')
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setValue.call(input, text)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }, value)
          await setSummary('Fixture summary')
          await pause(140)
          out.selectFilesTooltip = await readCommitTooltip()
          await setSummary('')
          await click(allChanges)
          await click('.commit-options-button')
          await click('.avatar-button')
          out.avatar = await text('[aria-labelledby="commit-avatar-popover-header"]')
          if (out.avatar.includes('未知用户')) {
            // A clean profile can lack a resolved author. Exercise the named
            // variant in the real popover without writing user configuration.
            await run(() => {
              const header = document.querySelector('#commit-avatar-popover-header')
              const name = document.createElement('strong')
              name.textContent = 'Test Fixture'
              header.replaceChildren(document.createTextNode('Committing as '), name)
              header.parentElement.querySelector('p').textContent = 'Email: fixture@example.test'
            })
            out.avatar = await text('[aria-labelledby="commit-avatar-popover-header"]')
          }
          await clickText('[aria-labelledby="commit-avatar-popover-header"] button', '取消')
          await menu('manage-remotes')
          await select('#manage-remotes .remove-remote-button')
          out.remotes = await text('#manage-remotes')
          out.remoteFields = await fields('#manage-remotes input, #manage-remotes .remove-remote-button')
          await click('#manage-remotes .new-remote-button')
          out.addRemote = await text('#add-remote')
          await clickText('#add-remote button', '取消')
          await clickText('#manage-remotes button', '关闭')
          await click('#compare-tab')
          out.compareEditMenu = await readContextLabels('#compare-view .compare-form input')
          await click('#compare-view .compare-form input')
          await clickText('#compare-view .branches-list-item .name', 'compare-fixture')
          await clickText('#compare-view [role=tab]', '落后（0）')
          out.compareEmpty = await text('#compare-view .compare-commit-list .blankslate > p')
          out.compareNoCommit = await text('.panel.blankslate:has(.blankslate-image)')
          out.compareMergeButton = await text('#compare-view .merge-cta .invoke-button')
          await click('#compare-view .merge-cta .dropdown-button')
          out.compareMergeOptions = await text('#compare-view .merge-cta .dropdown-select-button')
          await click('#compare-view .merge-cta .dropdown-button')
          await clickText('#compare-view [role=tab]', '领先（0）')
          out.compareAheadEmpty = await text('#compare-view .compare-commit-list .blankslate > p')
          await menu('show-changes')
          const messageField = '.manual-commit-fields textarea'
          out.commitEditMenu = await readContextLabels(messageField)
          selectContextItem = '关闭提交说明拼写检查'
          await requestContextMenu(messageField)
          if (!await wait(selector => document.querySelector(selector)?.spellcheck === false, messageField)) {
            throw new Error('The localized spellcheck toggle did not update the commit field')
          }
          out.commitEditMenuWithoutSpellcheck = await readContextLabels(messageField)
          await menu('show-repository-settings')
          await select('#repository-settings')
          await clickText('#repository-settings [role=tab]', '集成')
          await chooseCustomIntegration('#repository-settings .active-tab select')
          out.repositoryCustomEditor = await readIntegrationForm('#repository-settings', 'custom-editor')
          await click('#repository-settings .dialog-header .close')
          if (await run(() => Boolean(document.querySelector('#repository-settings')))) {
            await dismissDialog('#repository-settings')
          }
          await menu('preferences')
          for (const title of ['账户', '集成', 'Git', '外观', '通知', '提示', '高级', '辅助功能']) {
            await clickText('#preferences [role=tab]', title)
            if (title === '集成') {
              out.integrationFields = await fields('#preferences .custom-integration-form-container input')
              out.shell = await run(() => {
                const option = Array.from(document.querySelectorAll('#preferences select option')).find(e => e.value === 'Command Prompt')
                return option && { text: option.textContent, value: option.value }
              })
            }
            out[title] = await text('#preferences .preferences-container')
            if (title === '集成') {
              await chooseCustomIntegration('#preferences fieldset.advanced-section:nth-of-type(1) select')
              await chooseCustomIntegration('#preferences fieldset.advanced-section:nth-of-type(2) select')
              out.globalCustomEditor = await readIntegrationForm('#preferences', 'custom-editor')
              out.globalCustomShell = await readIntegrationForm('#preferences', 'custom-shell')
              const branchScriptPath = '#preferences ' + integrationInput('branch-preset-script', 'path')
              await setInput(branchScriptPath, ${JSON.stringify(path.join(version, 'DesktopPlus.exe'))})
              out.branchPresetScript = await readIntegrationForm('#preferences', 'branch-preset-script')
            }
          }
          await click('#preferences .dialog-header .close')
          if (!await wait(() => !document.querySelector('#preferences'))) {
            throw new Error('Preferences dialog did not close')
          }
          await menu('show-repository-list')
          selectContextItem = '创建别名'
          await requestContextMenu('.repository-list .repository-list-item')
          out.aliasDialog = await text('#change-repository-alias')
          await clickText('#change-repository-alias .dialog-footer button', '取消')
          if (await run(() => Boolean(document.querySelector('#change-repository-alias')))) {
            await click('#change-repository-alias .dialog-header .close')
          }
          if (!await wait(() => !document.querySelector('#change-repository-alias'))) {
            throw new Error('Alias dialog did not close')
          }
          if (!await run(() => Boolean(document.querySelector('.new-repository-button')))) {
            await menu('show-repository-list')
          }
          selectContextItem = '暂停更新…'
          await requestContextMenu('.repository-list .repository-list-item')
          out.snoozeDialog = await text('#snooze-repository')
          await clickText('#snooze-repository .dialog-footer button', '取消')
          if (await run(() => Boolean(document.querySelector('#snooze-repository')))) {
            await click('#snooze-repository .dialog-header .close')
          }
          if (!await wait(() => !document.querySelector('#snooze-repository'))) {
            throw new Error('Snooze dialog did not close')
          }
          if (!await run(() => Boolean(document.querySelector('.new-repository-button')))) {
            await menu('show-repository-list')
          }
          if (await run(() => Boolean(document.querySelector('.new-repository-button')))) await menu('show-repository-list')
          await menu('remove-repository')
          out.removeRepository = await text('#confirm-remove-repository')
          out.removeRepositoryPath = await text('#confirm-remove-repository .description .ref-component')
          const removeCheckbox = '#confirm-remove-repository input[type=checkbox]'
          out.recycleBefore = await run(s => document.querySelector(s).checked, removeCheckbox)
          await click(removeCheckbox)
          out.recycleAfter = await run(s => document.querySelector(s).checked, removeCheckbox)
          await clickText('#confirm-remove-repository .dialog-footer button', '取消')
          if (await run(() => Boolean(document.querySelector('#confirm-remove-repository')))) {
            await click('#confirm-remove-repository .dialog-header .close')
          }
          if (!await wait(() => !document.querySelector('#confirm-remove-repository'))) {
            throw new Error('The confirmation dialog did not close after cancellation')
          }
          git('remote', 'set-head', 'origin', 'main')
          git('switch', '-c', 'Test')
          git('push', '--set-upstream', 'origin', 'Test')
          window.emit('focus')
          if (!await wait(() => document.querySelector('.branch-button')?.innerText.split('\\n').includes('Test'))) {
            throw new Error('The temporary tracked branch did not become current')
          }
          await menu('create-branch')
          out.branchStartOptions = await text('#create-branch fieldset.vertical-segmented-control')
          await dismissDialog('#create-branch')
          await menu('delete-branch')
          out.deleteTrackedBranch = await text('#delete-branch')
          out.deleteRemoteDefault = await run(() => document.querySelector('#delete-branch input[type=checkbox]')?.checked)
          await dismissDialog('#delete-branch')
          out.branchAfterCancel = git('branch', '--show-current').toString().trim()
          out.remoteBranchAfterCancel = git('ls-remote', '--heads', 'origin', 'refs/heads/Test').toString().trim()
          const preview = '#choose-branch #merge-status-preview'
          const readSyncedPreview = async () => {
            if (!await wait(s => document.querySelectorAll(s + ' > strong').length === 2, preview)) {
              throw new Error('Missing branch sync preview')
            }
            return text(preview)
          }
          await menu('merge-branch')
          out.mergeSynced = await readSyncedPreview()
          await dismissDialog('#choose-branch')
          await menu('rebase-branch')
          out.rebaseChecking = await wait(s => {
            const status = document.querySelector(s)?.textContent.trim()
            return status && /^(正在检查|Checking for ability)/.test(status) ? status : null
          }, preview)
          out.rebaseSynced = await readSyncedPreview()
          await dismissDialog('#choose-branch')
          git('tag', '112')
          git('push', 'origin', 'HEAD:refs/heads/remote-only')
          git('remote', 'add', 'mirror', remote)
          git('fetch', 'mirror', 'main')
          window.emit('focus')
          await click('#history-tab')
          await click('.commitGraph-view-mode-switch button[aria-label="提交图视图"]')
          const tags = '.commitGraph-branch-group:has(.commitGraph-group-checkbox label)'
          if (!await wait(s => document.querySelectorAll(s).length >= 4, tags)) {
            throw new Error('Commit graph did not load the branch and tag groups')
          }
          out.graphGroups = await run(s => Array.from(document.querySelectorAll(s), group => {
            const label = group.querySelector('.commitGraph-group-checkbox label').textContent.trim()
            const toggle = group.querySelector('.commitGraph-group-disclosure')
            return {
              label,
              accessible: group.getAttribute('aria-label'),
              disclosure: toggle.getAttribute('aria-label'),
              expanded: toggle.getAttribute('aria-expanded') === 'true',
              names: Array.from(group.querySelectorAll('.commitGraph-branch-label'), node => node.textContent.trim()),
            }
          }), tags)
          const disclosure = '.commitGraph-group-disclosure[aria-label="折叠 本地分支（3）"]'
          await click(disclosure)
          await select('.commitGraph-group-disclosure[aria-label="展开 本地分支（3）"][aria-expanded=false]')
          await click('.commitGraph-group-disclosure[aria-label="展开 本地分支（3）"]')
          const tagToggle = '.commitGraph-group-disclosure[aria-label="展开 标签（1）"]'
          if (await run(s => document.querySelector(s) !== null, tagToggle)) {
            await click(tagToggle)
          }
          out.graphTag = await text('.commitGraph-branch-group[aria-label="标签（1）"] .commitGraph-branch-label')
          const shaButton = '#expandable-commit-summary .commit-ref .copy-button'
          if (!await run(s => Boolean(document.querySelector(s)), shaButton)) {
            await click('.commitGraph-list .commitGraph-summary')
          }
          await select(shaButton)
          out.copyShaLabel = await run(s => document.querySelector(s).getAttribute('aria-label'), shaButton)
          out.shortSha = await text('#expandable-commit-summary .commit-ref .ref')
          await run(s => {
            const button = document.querySelector(s)
            const { left, top, width, height } = button.getBoundingClientRect()
            button.dispatchEvent(new MouseEvent('mouseenter', { clientX: left + width / 2, clientY: top + height / 2 }))
          }, shaButton)
          out.copyShaTooltip = await wait(() => Array.from(
            document.querySelectorAll('.tooltip-content'), node => node.textContent.trim()
          ).find(value => value.includes('SHA')) ?? null)
          await run(s => document.querySelector(s).dispatchEvent(new MouseEvent('mouseleave')), shaButton)
          await click('#changes-tab')
          const recordDialog = async (event, selector) => {
            window.webContents.send('menu-event', event)
            const content = await text(selector)
            await dismissDialog(selector)
            return content
          }
          out.commitConflicts = await recordDialog(
            'test-confirm-committing-conflicted-files', '#commit-conflict-markers-warning'
          )
          out.invalidatedToken = await recordDialog(
            'test-invalidated-account-token', '#invalidated-token'
          )
          out.samlReauth = await recordDialog(
            'test-re-authorization-required', 'dialog.error[open]'
          )
          window.webContents.send('menu-event', 'test-discarded-changes-will-be-unrecoverable')
          await run(() => {
            const fixture = document.createElement('section')
            fixture.id = 'ci-translation-fixture'
            fixture.className = 'ci-check-list-popover'
            fixture.innerHTML =
              '<h1>Checks Summary</h1>' +
              '<div class="check-run-list-summary">2 successful, 1 failed, and 1 in progress checks</div>' +
              '<span class="ci-status" aria-label="Checks: Timed out"></span>' +
              '<div class="ci-check-description">Successful in 16s</div>'
            document.body.append(fixture)
          })
          out.checksTitle = await text('#ci-translation-fixture h1')
          out.checksSummary = await text('#ci-translation-fixture .check-run-list-summary')
          out.checksDuration = await text('#ci-translation-fixture .ci-check-description')
          out.checksLabel = await run(() => document.querySelector('#ci-translation-fixture .ci-status').getAttribute('aria-label'))
          await run(() => document.querySelector('#ci-translation-fixture').remove())
          out.discardRetry = await text('#discard-changes-retry')
          finish()
        } catch (error) {
          out.visible = await run(() => document.body.innerText.slice(0, 1150))
          finish(error)
        }
      })
    })
    require('./smoke-original-main.js')
  `
  )
  let launchError
  try {
    run(
      path.join(version, 'DesktopPlus.exe'),
      ['--cli-open=' + repo, '--user-data-dir=' + profile],
      {
        timeout: 105000,
        env: {
          ...env,
          APPDATA: profile,
          LOCALAPPDATA: profile,
          ELECTRON_ENABLE_LOGGING: '1',
          GITHUB_DESKTOP_PREVIEW_FEATURES: '1',
        },
      }
    )
  } catch (error) {
    launchError = error
  }
  if (launchError && !fs.existsSync(report)) throw launchError
  const result = JSON.parse(fs.readFileSync(report, 'utf8'))
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.match(result.undoCommit.time, /^提交于 \d+ 分钟前$/, JSON.stringify(result.undoCommit))
  assert.equal(result.undoCommit.button, '撤销')
  assert.equal(result.undoCommit.summary, undoSummary)
  assert.equal(result.undoCommit.label, '撤销提交')
  assert.match(result.removeRepository, /移除仓库.*确定要从 Desktop Plus 中移除仓库「\s*example\s*」吗.*将从 Desktop Plus 中移除以下路径的仓库.*同时将此仓库移到回收站.*移除.*取消/s)
  assert.equal(result.removeRepositoryPath, repo)
  assert.equal(result.recycleBefore, false)
  assert.equal(result.recycleAfter, true)
  assert.ok(fs.existsSync(repo))
  assert.match(result.compareEmpty, /当前分支已包含对比分支（\s*compare-fixture\s*）的全部提交/)
  assert.equal(result.compareNoCommit, '未选择提交')
  assert.match(result.compareAheadEmpty, /对比分支（\s*compare-fixture\s*）已包含当前分支的全部提交/)
  assert.equal(result.compareMergeButton, '创建合并提交')
  assert.equal(result.diffOptionsTooltip, '差异选项')
  assert.equal(result.diffOptionsLabel, result.diffOptionsTooltip)
  assert.equal(result.modifiedTooltip, '已修改')
  assert.equal(result.modifiedLabel, result.modifiedTooltip)
  assert.equal(result.filterOptionsTooltip, '筛选选项')
  assert.equal(result.appliedFilterTooltip, '筛选选项（已应用 1 项）')
  assert.equal(result.appliedFilterLabel, result.appliedFilterTooltip)
  assert.equal(result.clearFilterLabel, '清除筛选条件')
  assert.equal(result.commitSummaryTooltip, '请填写提交摘要。')
  assert.equal(result.selectFilesTooltip, '请至少选择一个文件提交。')
  assert.ok(result.repositoryMenu.includes('在浏览器中查看'))
  assert.ok(result.repositoryMenu.includes('在命令提示符中打开'))
  assert.ok(result['外观'].includes('2017年10月19日 (MMM d, yyyy)'))
  assert.ok(result['外观'].includes('2017年10月19日 (MMMM do, yyyy)'))
  assert.ok(result['外观'].includes('10/19/2017 (MM/dd/yyyy)'))
  assert.ok(result['外观'].includes('下午 2:30:45 (h:mm:ss aaa)'))
  assert.match(result.discardRetry, /丢弃的更改将无法恢复.*常见原因如下.*永久丢弃更改/s)
  assert.match(result.commitConflicts, /确认提交含冲突的文件.*以下含冲突的文件.*test[\\/]test\.md.*mock[\\/]mock\.md.*确定要提交这些包含冲突的文件吗.*取消/s)
  assert.match(result.invalidatedToken, /账户令牌已失效.*因此已退出.*所属服务为.*要重新登录吗/s)
  assert.match(result.samlReauth, /需要重新授权.*test-org.*SAML 单点登录.*是否在浏览器中授权 Desktop Plus.*取消/s)
  assert.match(result.aliasDialog, /创建仓库别名.*请为仓库「\s*example\s*」设置新别名.*创建别名/s)
  assert.match(result.snoozeDialog, /暂停仓库更新.*暂停仓库「\s*example\s*」的更新.*暂停至.*1 天.*暂停更新/s)
  assert.ok(result.compareEditMenu.includes('删除'))
  assert.ok(result.commitEditMenu.includes('删除'))
  assert.ok(result.commitEditMenu.includes('添加共同作者'))
  assert.ok(result.commitEditMenu.includes('关闭提交说明拼写检查'))
  assert.ok(result.commitEditMenuWithoutSpellcheck.includes('开启提交说明拼写检查'))
  assert.match(result.compareMergeOptions, /创建合并提交.*通过一次合并提交.*压缩并合并.*压缩为一个提交.*变基.*变基后添加/s)
  assert.match(result.openWith, /打开方式….*选择编辑器.*打开/s)
  for (const key of ['openWithCustom', 'repositoryCustomEditor', 'globalCustomEditor', 'globalCustomShell', 'branchPresetScript']) {
    assert.deepEqual(result[key]?.labels, ['路径', '参数'], key)
    assert.deepEqual(result[key].placeholders, ['可执行文件路径', '命令行参数'], key)
    assert.equal(result[key].choose, '选择…', key)
  }
  assert.equal(result.openWithCustom.args, '%TARGET_PATH%')
  assert.equal(result.openWithPathError, '此路径似乎不是有效的可执行文件。')
  assert.equal(result.openWithArgsError, '参数中必须包含目标路径占位符（%TARGET_PATH%）。')
  assert.deepEqual(result.openWithAnnouncements, [result.openWithPathError, result.openWithArgsError])
  assert.match(result.worktree, /添加工作树.*工作树名称.*本地路径.*选择….*分支名称.*创建工作树/s)
  assert.ok(result.worktreeFields.some(field => field.placeholder === '工作树名称'))
  assert.match(result.newBranch, /新分支将基于当前检出的分支（\s*main\s*）/)
  assert.match(result.mergeBranch, /合并到\s*main.*创建合并提交/s)
  assert.ok(result.mergeFields.some(field => field.placeholder === '筛选'))
  assert.match(result.branchStartOptions, /选择新分支的起点….*main.*此仓库的默认分支.*Test.*当前检出的分支/s)
  assert.match(result.deleteTrackedBranch, /删除分支.*Test.*此操作无法撤销.*远程也有此分支。要同时删除远程分支吗？.*是，同时删除远程分支/s)
  assert.equal(result.deleteRemoteDefault, false)
  assert.equal(result.branchAfterCancel, 'Test')
  assert.match(result.remoteBranchAfterCancel, /refs\/heads\/Test$/)
  assert.match(result.mergeSynced, /^Test\s*已包含以下分支的全部提交：\s*main$/)
  assert.equal(result.rebaseChecking, '正在检查能否自动变基…')
  assert.match(result.rebaseSynced, /^Test\s*已包含以下分支的全部提交：\s*main$/)
  const graphGroups = new Map(result.graphGroups.map(group => [group.label, group]))
  assert.deepEqual([...graphGroups.keys()], ['本地分支（3）', 'origin (1)', '其他远程仓库（1）', '标签（1）'])
  for (const [label, group] of graphGroups) {
    assert.equal(group.accessible, label)
    assert.equal(group.disclosure, (group.expanded ? '折叠 ' : '展开 ') + label)
  }
  assert.ok(graphGroups.get('本地分支（3）').names.includes('Test'))
  assert.equal(result.graphTag, '112')
  assert.equal(result.checksTitle, '检查摘要')
  assert.equal(result.checksSummary, '2 项已通过，1 项未通过，1 项进行中')
  assert.equal(result.checksDuration, '已通过，用时 16s')
  assert.equal(result.checksLabel, '检查：已超时')
  assert.equal(result.copyShaLabel, '复制完整的提交 SHA')
  assert.equal(result.copyShaTooltip, '复制完整的提交 SHA')
  assert.match(result.shortSha, /^[a-f0-9]{7,40}$/)
  assert.match(result.browserSignIn, /通过浏览器登录.*登录后，浏览器会带你返回 Desktop Plus。如果浏览器询问是否允许打开 Desktop Plus，请选择允许。.*在浏览器中继续.*取消/s)
  assert.match(
    result.clean,
    /没有本地更改.*将仓库发布到远程.*仅保存在本机.*工具栏发布，也可按.*发布仓库.*在资源管理器中查看仓库文件.*菜单，或按/s
  )
  assert.doesNotMatch(
    result.clean,
    /Publish your repository|Open the repository in your external editor|View the files of your repository|menu or/
  )
  assert.ok(result.shortcuts.includes('Ctrl'))
  assert.match(
    result.publish,
    /发布仓库.*登录 GitHub\.com 账户以发布仓库.*登录.*登录 GitHub Enterprise/s
  )
  assert.match(result.addRepository, /添加本地仓库.*选择….*添加仓库/s)
  assert.match(
    result.cloneGitHub,
    /登录 GitHub\.com 账户以访问你的仓库.*登录.*登录 GitHub Enterprise/s
  )
  assert.match(
    result.cloneURL,
    /仓库 URL 或 GitHub 用户名\/仓库名.*hubot\/cool-repo.*选择…/s
  )
  assert.match(
    result.createRepository,
    /新建仓库.*选择….*Git 忽略规则.*许可证/s
  )
  assert.ok(result.createFields.some(field => field.placeholder === '仓库名称'))
  assert.equal(result.createDefaults.length, 2)
  assert.ok(
    result.createDefaults.every(
      option => option.value === 'None' && option.text === '无'
    )
  )
  assert.match(result.group, /新建分组.*选择要加入的仓库.*example.*创建分组/s)
  assert.ok(result.groupFields.some(field => field.placeholder === '分组名称'))
  assert.ok(result.groupFields.some(field => field.placeholder === '筛选'))
  assert.ok(
    result.context?.some(
      item => item.label === '提交后推送' && item.type === 'checkbox'
    )
  )
  assert.match(
    result.avatar,
    /提交身份.*Test Fixture.*邮箱：fixture@example\.test.*Git.*配置.*仓库设置.*打开 Git 设置.*取消/s
  )
  assert.match(
    result.remotes,
    /管理远程仓库.*新建远程仓库.*origin.*example-remote\.git/s
  )
  assert.ok(
    result.remoteFields.some(field => field.placeholder === '筛选远程仓库')
  )
  assert.ok(
    result.remoteFields.some(field => field.label === '移除远程仓库「origin」')
  )
  assert.deepEqual(result.pushWarning, {
    title: "远程分支有新提交",
    message: "远程分支包含本地分支还没有的提交，因此无法推送。请先获取这些提交，整合远程和本地的提交后再推送。",
    fetch: '获取',
    cancel: '取消',
  })
  assert.match(result.addRemote, /添加远程仓库.*名称.*URL/s)
  assert.match(
    result['集成'],
    /命令提示符.*体验 GitHub.*了解 GitHub Copilot.*建议的分支名称.*保持原样/s
  )
  assert.equal(result.shell?.value, 'Command Prompt')
  assert.ok(
    result.integrationFields.some(
      field => field.placeholder === 'github.exe 的路径'
    )
  )
  assert.ok(
    result.integrationFields.some(
      field => field.placeholder === '可执行文件路径'
    )
  )
  assert.match(
    result['外观'],
    /隐藏此分组.*从不显示.*始终显示.*仅当不是默认分支时显示.*默认等宽字体/s
  )
  assert.match(result['通知'], /通知.*当前仓库发生重要事件时显示通知。/s)
  assert.doesNotMatch(
    result['通知'],
    /Make sure notifications are|for Desktop Plus in the/
  )
  assert.match(
    result['提示'],
    /用生成的说明覆盖现有提交说明.*提交被筛选器隐藏的更改/s
  )
  assert.match(
    result['高级'],
    /使用\s*Git Credential Manager\s*处理 GitHub\.com 以外的私有仓库/
  )
  console.log(
    'Verified Windows dialogs, native menus, eight preferences tabs, and three failure states.'
  )
} finally {
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 300,
  })
}
