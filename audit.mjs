import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const presentationNames =
  /^(?:aria-label|alt|placeholder|tooltip|label|title|description|message|.*(?:Label|Title|Text|Message|Placeholder|Description|Tooltip))$/
const placeholder = '{…}'
const normalize = value => value.trim().replace(/\s+/g, ' ')
const key = value => normalize(value).replace(/\.{3}/g, '…').toLowerCase()
const brands = new Set([
  'Git',
  'GitHub',
  'GitHub.com',
  'Desktop Plus',
  'Copilot',
  'Bitbucket',
  'GitLab',
  'Codeberg',
  'Forgejo',
  'Gitea',
  'GitHub Enterprise',
  'Codeberg / Forgejo',
  'URL',
  'HTTP',
  'SSH',
  'SVG',
  'XML',
  'JSON',
])

function describeLocation(node, source) {
  const segments = []
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) {
      segments.push('@' + parent.name.getText(source))
    } else if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent)) {
      const element = ts.isJsxElement(parent) ? parent.openingElement : parent
      const name = element.tagName.getText(source)
      const markers = element.attributes.properties
        .filter(attribute => ts.isJsxAttribute(attribute) &&
          ['id', 'className'].includes(attribute.name.getText(source)) &&
          attribute.initializer && ts.isStringLiteral(attribute.initializer))
        .map(attribute => attribute.name.getText(source) + '=' + attribute.initializer.text)
      segments.push(markers.length ? name + '[' + markers.join(', ') + ']' : name)
    } else if (ts.isPropertyAssignment(parent)) {
      segments.push('.' + parent.name.getText(source))
    } else if ((ts.isFunctionLike(parent) || ts.isClassDeclaration(parent) ||
        ts.isVariableDeclaration(parent)) && parent.name) {
      segments.push(parent.name.getText(source))
    }
  }
  return segments.reverse().join(' > ') || '(module)'
}

/** Finds authored JSX copy, presentation attributes and conventional text variables. */
export function scanSource(filename, contents, { locations = false } = {}) {
  const source = ts.createSourceFile(
    filename,
    contents,
    ts.ScriptTarget.Latest,
    true
  )
  const candidates = []

  const record = (node, raw) => {
    const text = normalize(raw)
    if (
      !/[A-Za-z]{2}/.test(text) ||
      /^(?:https?:|file:|data:|(?:\.[/\\])+)/i.test(text) ||
      brands.has(text)
    ) {
      return
    }
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    const candidate = { text, line: line + 1 }
    if (locations) {
      candidate.column = character + 1
      candidate.scope = describeLocation(node, source)
    }
    candidates.push(candidate)
  }

  const expression = node => {
    if (!node) {
      return
    }
    if (ts.isStringLiteralLike(node)) {
      record(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      record(
        node,
        node.head.text +
          node.templateSpans
            .map(span => placeholder + span.literal.text)
            .join('')
      )
    } else if (ts.isConditionalExpression(node)) {
      expression(node.whenTrue)
      expression(node.whenFalse)
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
      expression(node.expression)
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.PlusToken) {
        const left = ts.isStringLiteralLike(node.left)
          ? node.left.text
          : placeholder
        const right = ts.isStringLiteralLike(node.right)
          ? node.right.text
          : placeholder
        record(node, left + right)
      } else if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        expression(node.left)
        expression(node.right)
      }
    }
  }

  const visit = node => {
    if (ts.isJsxText(node)) {
      record(node, node.getFullText(source))
    } else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
      expression(node.expression)
    } else if (
      ts.isJsxAttribute(node) &&
      presentationNames.test(node.name.getText(source))
    ) {
      const initializer = node.initializer
      expression(
        initializer && ts.isJsxExpression(initializer)
          ? initializer.expression
          : initializer
      )
    } else if (
      (ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
      presentationNames.test(
        node.name.getText(source).replace(/^['"]|['"]$/g, '')
      )
    ) {
      expression(node.initializer)
    } else if (ts.isReturnStatement(node)) {
      let owner = node.parent
      while (owner && !ts.isFunctionLike(owner)) {
        owner = owner.parent
      }
      const name = owner?.name?.getText(source)
      if (
        name &&
        (presentationNames.test(name) || name === 'getDescriptionForError')
      ) {
        expression(node.expression)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return candidates
}

export function catalogMatcher(catalog) {
  const exact = new Set(
    [
      ...Object.keys(catalog.menu),
      ...Object.keys(catalog.contextMenu ?? {}),
      ...catalog.renderer.flatMap(([, messages]) => Object.keys(messages)),
    ].map(key)
  )
  const patterns = [
    ...catalog.rendererPatterns,
    ...catalog.menuPatterns,
    ...(catalog.contextMenuPatterns ?? []).map(
      ([source, translation, flags]) => ['', source, translation, flags]
    ),
  ].map(([, source, , flags]) => new RegExp(source, flags))
  return text => {
    if (
      exact.has(key(text)) ||
      exact.has(key(text.replace(/&([a-z])/i, '$1')))
    ) {
      return 'exact'
    }
    const samples = text.includes(placeholder)
      ? ['example', '12', 'LF'].map(value =>
          text.replaceAll(placeholder, value)
        )
      : [text]
    return patterns.some(pattern =>
      samples.some(sample => {
        pattern.lastIndex = 0
        return pattern.test(sample)
      })
    )
      ? 'pattern'
      : 'missing'
  }
}

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* files(path)
    } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(path))) {
      yield path
    }
  }
}

const isAuditedSource = file =>
  /^(?:app\/src\/(?:ui|main-process|crash)\/.+\.tsx?|app\/src\/lib\/git\/core\.ts)$/.test(
    file
  )

async function* mapSources(appDirectory) {
  const seen = new Set()
  for (const name of ['renderer.js.map', 'main.js.map', 'crash.js.map']) {
    let map
    try {
      map = JSON.parse(await readFile(join(appDirectory, name), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue
      }
      throw error
    }
    for (const [index, url] of (map.sources ?? []).entries()) {
      const file = url.match(/(?:^|\/)(app\/src\/[^?]+)(?:\?|$)/)?.[1]
      const contents = map.sourcesContent?.[index]
      if (
        file &&
        isAuditedSource(file) &&
        typeof contents === 'string' &&
        !seen.has(file)
      ) {
        seen.add(file)
        yield [file, contents]
      }
    }
  }
  if (seen.size === 0) {
    throw new Error('没有找到可扫描的 Desktop Plus 源码或应用源映射。')
  }
}

async function audit(directory, filter) {
  const root = resolve(directory)
  const source = join(root, 'app', 'src')
  const uiDirectory = await stat(join(source, 'ui')).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return null
    }
    throw error
  })
  const isCheckout = uiDirectory?.isDirectory() === true
  const catalog = JSON.parse(
    await readFile(new URL('./zh-CN.json', import.meta.url), 'utf8')
  )
  const match = catalogMatcher(catalog)
  const reviewed = JSON.parse(
    await readFile(new URL('./audit-reviewed.json', import.meta.url), 'utf8')
  )
  const reviewKey = (file, scope, text) => JSON.stringify([file, scope, text])
  const reviewReasons = new Map(reviewed.map(({ file, scope, text, reason }) => [reviewKey(file, scope, text), reason]))
  const candidates = new Map()
  const occurrences = []
  const record = (file, contents) => {
    if (filter && !file.toLowerCase().includes(filter.toLowerCase())) {
      return
    }
    const scope = file.replace(/^app\/src\//, '').split('/')
    const area = scope[0] === 'ui' ? scope[1].replace(/\.tsx?$/, '') : scope[0]
    for (const { text, line, column, scope: location } of scanSource(basename(file), contents, { locations: true })) {
      const catalogMatch = match(text)
      occurrences.push({
        area, file, line, column, scope: location, text, catalogMatch,
        review: catalogMatch === 'missing' ? 'triage' : 'verify-context',
        ...(catalogMatch === 'missing' && reviewReasons.has(reviewKey(file, location, text))
          ? { reviewReason: reviewReasons.get(reviewKey(file, location, text)) }
          : {}),
      })
      const id = area + '\n' + key(text)
      const candidate = candidates.get(id) ?? { area, text, references: [] }
      const reference = file + ':' + line
      if (
        candidate.references.length < 5 &&
        !candidate.references.includes(reference)
      ) {
        candidate.references.push(reference)
      }
      candidates.set(id, candidate)
    }
  }
  if (isCheckout) {
    for (const directory of ['ui', 'main-process', 'crash']) {
      for await (const file of files(join(source, directory))) {
        record(
          relative(root, file).split(sep).join('/'),
          await readFile(file, 'utf8')
        )
      }
    }
    const gitCore = 'app/src/lib/git/core.ts'
    record(gitCore, await readFile(join(root, gitCore), 'utf8'))
  } else {
    for await (const [file, contents] of mapSources(root)) {
      record(file, contents)
    }
  }

  const totals = { exact: 0, pattern: 0, missing: 0 }
  const missing = []
  for (const entry of candidates.values()) {
    const status = match(entry.text)
    totals[status]++
    if (status === 'missing') {
      missing.push(entry)
    }
  }
  missing.sort(
    (left, right) =>
      left.area.localeCompare(right.area) || left.text.localeCompare(right.text)
  )
  occurrences.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
  return {
    schema: 2,
    source: isCheckout ? 'checkout' : 'source-map',
    filter: filter ?? null,
    totals,
    occurrenceTotals: occurrences.reduce((counts, entry) => {
      counts[entry.catalogMatch]++
      return counts
    }, { exact: 0, pattern: 0, missing: 0 }),
    missing,
    pendingEnglishOccurrences: occurrences.filter(entry =>
      entry.catalogMatch === 'missing' && !entry.reviewReason && !/\p{Script=Han}/u.test(entry.text)
    ),
    occurrences,
  }
}

export function compareOccurrences(previous, current) {
  const identity = entry => JSON.stringify([entry.file, entry.scope, key(entry.text)])
  const group = (entries, by) => {
    const groups = new Map()
    for (const entry of entries) {
      const id = by(entry)
      const list = groups.get(id) ?? []
      list.push(entry)
      groups.set(id, list)
    }
    return groups
  }

  const oldGroups = group(previous, identity)
  const newGroups = group(current, identity)
  const removed = previous.filter(entry => {
    const matches = newGroups.get(identity(entry))
    return !matches?.pop()
  })
  const added = current.filter(entry => {
    const matches = oldGroups.get(identity(entry))
    return !matches?.pop()
  })

  const reconcile = by => {
    const oldBy = group(removed.filter(entry => !paired.has(entry)), by)
    const newBy = group(added.filter(entry => !paired.has(entry)), by)
    const pairs = []
    for (const [id, oldEntries] of oldBy) {
      const newEntries = newBy.get(id)
      if (oldEntries.length === 1 && newEntries?.length === 1) {
        const [before] = oldEntries
        const [after] = newEntries
        pairs.push({ before, after })
        paired.add(before)
        paired.add(after)
      }
    }
    return pairs
  }

  const paired = new Set()
  const moved = reconcile(entry => key(entry.text))
  const changed = reconcile(entry => JSON.stringify([entry.file, entry.scope]))
  return {
    added: added.filter(entry => !paired.has(entry)),
    removed: removed.filter(entry => !paired.has(entry)),
    moved,
    changed,
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2)
  const baselineIndex = args.indexOf('--baseline')
  const [checkout, filter, ...extra] = baselineIndex < 0 ? args : args.slice(0, baselineIndex)
  const baseline = baselineIndex < 0 ? null : args[baselineIndex + 1]
  if (!checkout || extra.length || (baselineIndex >= 0 && (!baseline || baselineIndex + 2 !== args.length))) {
    console.error(
      '用法：node audit.mjs <Desktop Plus 源码目录或 resources/app> [源码路径过滤词] [--baseline 基线报告.json]'
    )
    process.exitCode = 1
  } else {
    try {
      const report = await audit(checkout, filter)
      if (baseline !== null) {
        const previous = JSON.parse((await readFile(baseline, 'utf8')).replace(/^\uFEFF/, ''))
        if (previous.schema !== report.schema || !Array.isArray(previous.occurrences) || previous.filter !== report.filter) {
          throw new Error('请提供扫描范围相同、由当前审校工具生成的基线报告。')
        }
        report.changes = compareOccurrences(previous.occurrences, report.occurrences)
      }
      console.log(JSON.stringify(report, null, 2))
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
