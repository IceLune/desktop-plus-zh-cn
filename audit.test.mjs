import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogMatcher, compareOccurrences, scanSource } from './audit.mjs'

test('collects JSX copy, platform variants and templates without reading input or callback values', () => {
  const contents = [
    'const id = "internal-id"',
    'const item = { label: `Open in ${editor}`, action: () => run("internal-command") }',
    'const view = <><p>App message <code>{data}</code></p>',
    '  <input value="sample value" aria-label="Repository URL" />',
    '  <Button title={win ? "View options..." : "View settings…"} />',
    '</>',
  ].join('\n')
  assert.deepEqual(scanSource('fixture.tsx', contents), [
    { text: 'Open in {…}', line: 2 },
    { text: 'App message', line: 3 },
    { text: 'Repository URL', line: 4 },
    { text: 'View options...', line: 5 },
    { text: 'View settings…', line: 5 },
  ])
})

test('distinguishes exact entries, dynamic templates and unmatched strings', () => {
  const match = catalogMatcher({
    menu: { file: '文件' },
    contextMenu: {},
    renderer: [['button', { 'View options…': '查看选项…' }]],
    rendererPatterns: [['aside', '^(\\d+) files$', '$1 个文件']],
    menuPatterns: [],
    contextMenuPatterns: [['^Open in (.+)$', '在 $1 中打开']],
  })
  assert.equal(match('&File'), 'exact')
  assert.equal(match('View options...'), 'exact')
  assert.equal(match('{…} files'), 'pattern')
  assert.equal(match('Open in {…}'), 'pattern')
  assert.equal(match('Unknown button'), 'missing')
})

test('records the same string in separate components and finds tooltip helpers', () => {
  const contents = [
    'function Compare() { return <button id="compare">Open</button> }',
    'function Merge() { return <button id="merge">Open</button> }',
    'function getButtonTooltip() { return "A summary is required" }',
  ].join('\n')
  const entries = scanSource('fixture.tsx', contents, { locations: true })
  assert.deepEqual(entries.map(entry => [entry.text, entry.scope]), [
    ['Open', 'Compare > button[id=compare]'],
    ['Open', 'Merge > button[id=merge]'],
    ['A summary is required', 'getButtonTooltip'],
  ])
  assert.ok(entries.every(entry => entry.line > 0 && entry.column > 0))
})

test('identifies new, moved, changed and removed occurrences without treating line shifts as changes', () => {
  const item = (scope, text, line = 1, file = 'app/src/ui/fixture.tsx') => ({ file, scope, text, line })
  const currentLabel = item('History > button', 'Open')
  const repeated = item('Merge > button', 'Open')
  const previousTitle = item('Settings > h1', 'Old title')
  const newTitle = item('Settings > h1', 'New title')
  const orphan = item('Legacy > p', 'Legacy hint')
  const beforeMove = item('Before > p', 'Helpful text')
  const afterMove = item('After > p', 'Helpful text', 1, 'app/src/ui/new.tsx')
  const result = compareOccurrences(
    [currentLabel, previousTitle, orphan, beforeMove],
    [{ ...currentLabel, line: 24 }, repeated, newTitle, afterMove]
  )
  assert.deepEqual(result, {
    added: [repeated],
    removed: [orphan],
    moved: [{ before: beforeMove, after: afterMove }],
    changed: [{ before: previousTitle, after: newTitle }],
  })
})
