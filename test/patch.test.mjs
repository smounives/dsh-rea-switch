import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MARK_END,
  MARK_START,
  ROW_ID,
  hasManagedBlock,
  managedDisabled,
  renderPatch,
} from '../lib/patch.js'

const HOME_PATCH = `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: /usr/bin/node
        args:
          - /opt/rea.mjs
          - mcp
`

test('appends a managed block after the insert row', () => {
  const next = renderPatch(HOME_PATCH, true)
  assert.ok(next.startsWith(HOME_PATCH.trimEnd()), 'original text is preserved as a prefix')
  assert.ok(hasManagedBlock(next))
  assert.equal(managedDisabled(next), true)
  const lines = next.trimEnd().split('\n')
  assert.deepEqual(lines.slice(-3), ['- id: rea-mcp', '  disabled: true', MARK_END])
  assert.equal(lines[lines.length - 4], MARK_START)
})

test('disabling twice is byte-identical', () => {
  const once = renderPatch(HOME_PATCH, true)
  const twice = renderPatch(once, true)
  assert.equal(twice, once)
})

test('enabling restores the original file exactly', () => {
  const off = renderPatch(HOME_PATCH, true)
  const on = renderPatch(off, false)
  assert.equal(on, HOME_PATCH)
  assert.equal(hasManagedBlock(on), false)
  assert.equal(managedDisabled(on), null)
})

test('enabling a file without a block leaves it untouched', () => {
  assert.equal(renderPatch(HOME_PATCH, false), HOME_PATCH)
  assert.equal(renderPatch('[]\n', false), '[]\n')
})

test('an empty document gains the block instead of keeping []', () => {
  const next = renderPatch('[]\n', true)
  assert.ok(!next.includes('[]'))
  assert.equal(managedDisabled(next), true)
})

test('removing the only block of an otherwise empty file yields []', () => {
  const only = renderPatch('', true)
  assert.equal(renderPatch(only, false), '[]\n')
})

test('unrelated rows and comments survive both directions', () => {
  const text = `# keep me
- insert:
    - id: other
      name: other
# trailing note
`
  const off = renderPatch(text, true)
  assert.ok(off.includes('# keep me'))
  assert.ok(off.includes('# trailing note'))
  assert.ok(off.includes('- id: other'))
  assert.equal(renderPatch(off, false), `${text.trimEnd()}\n`)
})

test('the managed row carries the REA id and nothing else', () => {
  const off = renderPatch(HOME_PATCH, true)
  const start = off.split('\n').indexOf(MARK_START)
  assert.deepEqual(off.split('\n').slice(start + 1, start + 3), [`- id: ${ROW_ID}`, '  disabled: true'])
})

test('keeps the CRLF line endings of a Windows file', () => {
  const crlf = HOME_PATCH.replace(/\n/g, '\r\n')
  const off = renderPatch(crlf, true)
  assert.ok(!/(^|[^\r])\n/.test(off), 'every newline is preceded by a carriage return')
  // one separator line plus the four block lines
  assert.equal(off.split('\r\n').length - 1, crlf.split('\r\n').length - 1 + 5)
  assert.equal(renderPatch(off, false), crlf)
})

test('preserves trailing spaces and blank-line runs elsewhere', () => {
  const text = '- insert:\n    - id: other   \n\n\n# note\n'
  const off = renderPatch(text, true)
  assert.ok(off.includes('    - id: other   \n'), 'trailing spaces are not stripped')
  assert.ok(off.includes('\n\n\n# note\n'), 'blank-line runs are not collapsed')
  assert.equal(renderPatch(off, false), text)
})
