function localizeRenderer(groups, patterns) {
  const normalize = value =>
    value.trim().replace(/\s+/g, ' ').replace(/\.{3}/g, '…').toLowerCase()
  const translations = new Map()
  for (const [selector, messages] of groups) {
    for (const [source, translation] of Object.entries(messages)) {
      const key = normalize(source)
      const matches = translations.get(key) ?? []
      matches.push({ selector, translation })
      translations.set(key, matches)
    }
  }

  const dynamic = new Map()
  for (const [selector, source, translation, flags] of patterns) {
    const rules = dynamic.get(selector) ?? []
    rules.push([new RegExp(source, flags), translation])
    dynamic.set(selector, rules)
  }
  const dynamicSelector = [...dynamic.keys()].join(', ')

  const translate = (element, value) => {
    const key = normalize(value)
    if (key === '') {
      return value
    }

    const matches = translations.get(key)
    const match = matches?.find(rule => element.matches(rule.selector))
    if (match) {
      return value.replace(/\S[\s\S]*\S|\S/, () => match.translation)
    }

    if (!dynamicSelector || !element.matches(dynamicSelector)) {
      return value
    }

    // A single error message can contain several separately translated lines.
    let result = value
    for (const [selector, rules] of dynamic) {
      if (element.matches(selector)) {
        for (const [source, translation] of rules) {
          result = result.replace(source, translation)
        }
      }
    }
    return result
  }

  const attributes = ['placeholder', 'aria-label', 'title', 'alt']
  const attributeSelector = attributes.map(name => `[${name}]`).join(', ')
  const translateAttribute = (element, name) => {
    const value = element.getAttribute(name)
    if (value !== null) {
      const translation = translate(element, value)
      if (translation !== value) {
        element.setAttribute(name, translation)
      }
    }
  }
  const tooltipOwners = new WeakMap()
  const translateText = node => {
    if (node.parentElement !== null) {
      const target = tooltipOwners.get(node.parentElement) ?? node.parentElement
      const translation = translate(target, node.data)
      if (translation !== node.data) {
        node.data = translation
      }
    }
  }
  const translateElement = element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      translateText(walker.currentNode)
    }
    for (const name of attributes) {
      translateAttribute(element, name)
    }
    for (const child of element.querySelectorAll(attributeSelector)) {
      for (const name of attributes) {
        translateAttribute(child, name)
      }
    }
  }

  const tooltipTargets = groups
    .filter(([, , options]) => options?.includeTooltip === true)
    .map(([selector]) => selector)
    .join(', ')
  if (tooltipTargets) {
    document.addEventListener('tooltip-shown', event => {
      const target = event.target
      if (!(target instanceof Element) || !target.matches(tooltipTargets)) {
        return
      }

      // Desktop Plus emits this event during measurement, before the
      // portal gets its ID. Skip ambiguous or rich-content tooltips.
      const host = target.closest('.tooltip-host') ?? document.body
      const measured = host.querySelectorAll(
        ':scope > .tooltip[role=tooltip]:not([id]) > .tooltip-content'
      )
      if (measured.length === 1 && measured[0].childNodes.length === 1 &&
          measured[0].firstChild.nodeType === Node.TEXT_NODE) {
        const content = measured[0]
        tooltipOwners.set(content, target)
        translateText(content.firstChild)
      }
    }, true)
  }

  document.documentElement.lang = 'zh-CN'
  translateElement(document.body)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (!record.target.isConnected) {
        continue
      }
      if (record.type === 'characterData') {
        translateText(record.target)
      } else if (record.type === 'attributes') {
        translateAttribute(record.target, record.attributeName)
      } else {
        for (const node of record.addedNodes) {
          if (node.isConnected && node.nodeType === Node.ELEMENT_NODE) {
            translateElement(node)
          } else if (node.isConnected && node.nodeType === Node.TEXT_NODE) {
            translateText(node)
          }
        }
      }
    }
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: attributes,
  })
}

function installLocalization(catalog, localizeRenderer, carryForward) {
  const { app, autoUpdater, dialog, Menu } = require('electron')
  const { join } = require('node:path')
  const { pathToFileURL } = require('node:url')

  if (
    process.argv.some(argument =>
      /^--squirrel-(install|updated|uninstall|obsolete)$/.test(argument)
    )
  ) {
    return
  }

  const rendererPages = new Set(
    ['index.html', 'crash.html'].map(file =>
      pathToFileURL(join(app.getAppPath(), file)).href
    )
  )
  const renderer = `(${localizeRenderer})(${JSON.stringify(
    catalog.renderer
  )}, ${JSON.stringify(catalog.rendererPatterns)})`
  app.on('web-contents-created', (_event, contents) => {
    contents.on('dom-ready', () => {
      if (rendererPages.has(contents.getURL().split(/[?#]/, 1)[0])) {
        contents.executeJavaScript(renderer).catch(error => {
          if (!contents.isDestroyed()) {
            console.error('[Desktop Plus zh-CN] Renderer:', error)
          }
        })
      }
    })
  })

  if (carryForward !== undefined) {
    // Squirrel has already installed the new version when Electron emits this.
    autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
      try {
        carryForward(app.getAppPath(), process.execPath, __filename, releaseName)
      } catch (error) {
        console.error('[Desktop Plus zh-CN] Update:', error)
      }
    })
  }

  const showMessageBox = dialog?.showMessageBox
  if (typeof showMessageBox === 'function') {
    dialog.showMessageBox = function (...args) {
      const options = args.at(-1)
      if (options?.title === 'Reveal Repository in Finder?' &&
          options.message === 'This repository might be an application.') {
        args[args.length - 1] = {
          ...options,
          title: '在 Finder 中显示仓库？',
          message: '此仓库可能是一个应用程序。',
          detail: '直接打开可能会运行软件。你可以在 Finder 中显示并选中它。',
          buttons: ['在 Finder 中显示', '取消'],
        }
      } else if (options?.title?.toLowerCase() === 'unrecoverable error') {
        args[args.length - 1] = {
          ...options,
          title: '无法恢复的错误',
          message: options.message?.replace(
            /^Desktop Plus has encountered an unrecoverable error and will need to restart\.\n\nThis has been reported to the team, but if you encounter this repeatedly please report this issue to the Desktop Plus issue tracker\./,
            'Desktop Plus 遇到无法恢复的错误，需要重启。\n\n此问题已上报给开发团队。如果反复出现，请在 Desktop Plus 的问题跟踪器中反馈。'
          ),
        }
      }
      return showMessageBox.apply(this, args)
    }
  }

  const showOpenDialog = dialog?.showOpenDialog
  if (typeof showOpenDialog === 'function') {
    dialog.showOpenDialog = function (...args) {
      const options = args.at(-1)
      if (options?.title === 'Choose GitHub Copilot') {
        args[args.length - 1] = { ...options, title: '选择 GitHub Copilot' }
      } else if (options?.filters?.some(filter => filter.name === 'Executables')) {
        args[args.length - 1] = {
          ...options,
          filters: options.filters.map(filter =>
            filter.name === 'Executables' ? { ...filter, name: '可执行文件' } : filter
          ),
        }
      }
      return showOpenDialog.apply(this, args)
    }
  }

  const menuPatterns = new Map(
    catalog.menuPatterns.map(([id, source, translation]) => [
      id,
      [new RegExp(source), translation],
    ])
  )
  const translateMenuItem = item => {
    const result = { ...item }
    if (typeof item.label === 'string') {
      const source = item.label.replace(/&([a-z])/i, '$1')
      const key = source.toLowerCase()
      const fixed = Object.hasOwn(catalog.menu, key) ? catalog.menu[key] : null
      const pattern = menuPatterns.get(item.id)
      const translation =
        fixed ?? (pattern ? source.replace(pattern[0], pattern[1]) : source)
      if (translation !== source) {
        const accessKey = /&([a-z])/i.exec(item.label)?.[1]
        result.label = accessKey
          ? `${translation} (&${accessKey.toUpperCase()})`
          : translation
      }
    }
    if (Array.isArray(item.submenu)) {
      result.submenu = item.submenu.map(translateMenuItem)
    }
    return result
  }

  const buildFromTemplate = Menu.buildFromTemplate
  Menu.buildFromTemplate = function (template) {
    const isAppMenu =
      Array.isArray(template) &&
      template.some(item => item.id === 'repository') &&
      template.some(
        item =>
          Array.isArray(item.submenu) &&
          item.submenu.some(child => child.id === 'new-repository')
      )
    if (isAppMenu) {
      try {
        return buildFromTemplate.call(this, template.map(translateMenuItem))
      } catch (error) {
        console.error('[Desktop Plus zh-CN] Menu:', error)
      }
    }
    return buildFromTemplate.call(this, template)
  }

  const contextPatterns = (catalog.contextMenuPatterns ?? []).map(
    ([source, translation, flags]) => [new RegExp(source, flags), translation]
  )
  const localizeContextItems = (menu, isRepositoryGroupMenu = false) => {
    const [firstItem, secondItem] = menu.items
    for (const item of menu.items) {
      if (typeof item.label === 'string') {
        const label = item.label
        const key = label.replace(/\.{3}/g, '…').toLowerCase()
        // Custom group names are checkbox labels, as is the built-in pin action.
        if (isRepositoryGroupMenu && item.type === 'checkbox' &&
            !(item === firstItem && key === 'pinned' && secondItem?.type === 'separator')) {
          continue
        }
        const translation = Object.hasOwn(catalog.contextMenu, key)
          ? catalog.contextMenu[key]
          : contextPatterns.reduce(
              (value, [source, replacement]) =>
                value.replace(source, replacement),
              label
            )
        if (translation !== label) {
          item.label = translation
        }
      }
      if (item.submenu) {
        const isGroupMenu = item.label?.toLowerCase() === 'move to group' ||
          item.label === catalog.contextMenu['move to group']
        localizeContextItems(item.submenu, isGroupMenu)
      }
    }
  }
  const popup = Menu.prototype?.popup
  if (typeof popup === 'function' && catalog.contextMenu) {
    Menu.prototype.popup = function (options) {
      try {
        localizeContextItems(this)
      } catch (error) {
        console.error('[Desktop Plus zh-CN] Context menu:', error)
      }
      return popup.call(this, options)
    }
  }
}

function buildBootstrap(catalog, createInstallation) {
  const carryForward = createInstallation === undefined
    ? 'undefined'
    : `(${createInstallation})().carryForward`
  return `// Desktop Plus zh-CN
'use strict'
try {
  const installLocalization = ${installLocalization}
  installLocalization(${JSON.stringify(catalog)}, ${localizeRenderer}, ${carryForward})
} catch (error) {
  console.error('[Desktop Plus zh-CN]', error)
}
module.exports = require('./main.js')
`
}

module.exports = { buildBootstrap, installLocalization, localizeRenderer }
