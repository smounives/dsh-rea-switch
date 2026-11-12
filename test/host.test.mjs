import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectStatus, setEnabled } from '../lib/index.js'
import { managedDisabled, renderPatch } from '../lib/patch.js'

const HOME_PATCH = `- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
`

/**
 * A fake host context. The "loader" derives the REA entry from the patch file on
 * every read, which is how the real HMR reconciliation behaves once it settles.
 */
function fakeContext(home, { moduleName = '@deepseek-ai/dsh-mcp-client', tools } = {}) {
  return {
    get(key) {
      if (key === 'profileContext') return { home }
      if (key === 'loader') {
        return {
          entries() {
            let text = ''
            try {
              text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
            } catch {
              return []
            }
            if (!text.includes('- id: rea-mcp')) return []
            return [
              {
                options: { id: 'rea-mcp', name: moduleName },
                get disabled() {
                  return managedDisabled(text) === true
                },
                fiber: {},
              },
            ]
          },
        }
      }
      if (key === 'tools') return tools
      return undefined
    },
  }
}

/**
 * A fake host context for the `dsh-plugin-rea` bundle row.
 *
 * That row is inserted by the package's own `cordis.patch.yml` (a bundle patch), so
 * it exists even when no home patch file was ever written; only its `disabled`
 * state comes from the managed block in the home patch.
 */
function bundleContext(home, { moduleName = '@deepseek-ai/dsh-mcp-client', rowId = 'mcp-rea' } = {}) {
  return {
    get(key) {
      if (key === 'profileContext') return { home }
      if (key === 'loader') {
        return {
          entries() {
            let text = ''
            try {
              text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
            } catch {
              /* no home patch: the bundle row is still there */
            }
            return [
              {
                options: { id: rowId, name: moduleName },
                get disabled() {
                  return managedDisabled(text) === true
                },
                fiber: {},
              },
            ]
          },
        }
      }
      return undefined
    },
  }
}

test('collectStatus reports a configured, enabled row', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    await writeFile(join(home, 'cordis.patch.yml'), HOME_PATCH)
    const status = await collectStatus(fakeContext(home))
    assert.equal(status.configured, true)
    assert.equal(status.enabled, true)
    assert.equal(status.patch.managed, false)
    assert.equal(status.runtime.moduleName, '@deepseek-ai/dsh-mcp-client')
    assert.equal(status.tools, null)
    assert.equal(status.patch.path, join(home, 'cordis.patch.yml'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('collectStatus counts MCP tools when the registry is available', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    await writeFile(join(home, 'cordis.patch.yml'), HOME_PATCH)
    const tools = {
      schemas: () => [{ name: 'mcp__rea__binary_overview' }, { name: 'mcp__rea__read_bytes' }, { name: 'bash' }],
    }
    const status = await collectStatus(fakeContext(home, { tools }))
    assert.deepEqual(status.tools, { total: 3, rea: 2 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('setEnabled(false) persists the block and reports the live state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    const file = join(home, 'cordis.patch.yml')
    await writeFile(file, HOME_PATCH)

    const off = await setEnabled(fakeContext(home), false)
    const written = await readFile(file, 'utf8')
    assert.equal(off.changed, true)
    assert.equal(off.applied, true)
    assert.equal(off.restartRequired, false)
    assert.equal(managedDisabled(written), true)
    assert.equal(off.status.enabled, false)

    const on = await setEnabled(fakeContext(home), true)
    assert.equal(on.changed, true)
    assert.equal(on.applied, true)
    assert.equal(await readFile(file, 'utf8'), HOME_PATCH)
    assert.equal(on.status.enabled, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a repeated request reports no change', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    const file = join(home, 'cordis.patch.yml')
    const off = renderPatch(HOME_PATCH, true)
    await writeFile(file, off)
    const result = await setEnabled(fakeContext(home), false)
    assert.equal(result.changed, false)
    assert.equal(result.applied, true)
    assert.equal(await readFile(file, 'utf8'), off)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses when the REA row is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    await writeFile(join(home, 'cordis.patch.yml'), '[]\n')
    await assert.rejects(setEnabled(fakeContext(home), false), (error) => error.code === 'rea-row-not-configured')
    assert.equal(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), '[]\n')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses when the row id is reused by another module', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    await writeFile(join(home, 'cordis.patch.yml'), HOME_PATCH)
    const ctx = fakeContext(home, { moduleName: 'some-other-plugin' })
    await assert.rejects(setEnabled(ctx, false), (error) => error.code === 'rea-row-module-mismatch')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses to append to a UTF-16 patch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    const file = join(home, 'cordis.patch.yml')
    await writeFile(file, Buffer.from(`\ufeff${HOME_PATCH}`, 'utf16le'))
    const status = await collectStatus(fakeContext(home))
    assert.equal(status.patch.managed, false)
    await assert.rejects(setEnabled(fakeContext(home), false), (error) => error.code === 'patch-encoding-unsupported')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('collectStatus finds the dsh-plugin-rea bundle row without a home patch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    const status = await collectStatus(bundleContext(home))
    assert.equal(status.configured, true)
    assert.equal(status.enabled, true)
    assert.equal(status.target.rowId, 'mcp-rea')
    assert.deepEqual(status.target.acceptedRowIds, ['rea-mcp', 'mcp-rea'])
    assert.equal(status.patch.exists, false, 'no home patch is needed for a bundle row')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('setEnabled writes the override with the bundle row id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    const file = join(home, 'cordis.patch.yml')

    const off = await setEnabled(bundleContext(home), false)
    const written = await readFile(file, 'utf8')
    assert.equal(off.applied, true)
    assert.equal(off.status.target.rowId, 'mcp-rea')
    assert.ok(written.includes('- id: mcp-rea'), 'the block targets the id that exists')
    assert.ok(!written.includes('- id: rea-mcp'), 'no block is written for the absent row')
    assert.equal(managedDisabled(written), true)

    const on = await setEnabled(bundleContext(home), true)
    assert.equal(on.applied, true)
    assert.equal(await readFile(file, 'utf8'), '[]\n')
    assert.equal(on.status.enabled, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('prefers the live row when both registrations are present', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-switch-'))
  try {
    const ctx = {
      get(key) {
        if (key === 'profileContext') return { home }
        if (key === 'loader') {
          return {
            entries: () => [
              { options: { id: 'rea-mcp', name: '@deepseek-ai/dsh-mcp-client' }, disabled: false },
              { options: { id: 'mcp-rea', name: '@deepseek-ai/dsh-mcp-client' }, disabled: false, fiber: {} },
            ],
          }
        }
        return undefined
      },
    }
    const status = await collectStatus(ctx)
    assert.equal(status.target.rowId, 'mcp-rea', 'the running row wins over the idle one')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
