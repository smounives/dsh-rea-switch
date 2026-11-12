import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** Minimal React stand-in: the factory only needs the hook names to exist. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => undefined],
}

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => loaded.push(definition),
    },
  }
  try {
    new Function('window', 'navigator', source)(globalThis.window, { language: 'zh-CN' })
  } finally {
    delete globalThis.window
  }
  assert.equal(loaded.length, 1, 'the file registers exactly one module')
  const module = loaded[0].factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  return { definition: loaded[0], module }
}

test('registers the module under the package name', async () => {
  const { definition } = await loadClient()
  assert.equal(definition.id, PACKAGE.name)
})

test('injects only the slot service', async () => {
  const { module } = await loadClient()
  assert.deepEqual(module.inject, ['slots'])
})

test('registers a settings section and a composer-dock switch', async () => {
  const { module } = await loadClient()
  const registered = []
  const ctx = {
    slots: {
      inject: (name, register) => register(),
      register: (slot, component) => {
        registered.push({ slot, component })
        return () => undefined
      },
    },
  }
  module.apply(ctx)
  assert.equal(registered.length, 2)
  const names = registered.map((entry) => entry.slot.name)
  assert.deepEqual(names, ['settings.section', 'conversation.composer.dock'])
  assert.equal(registered[0].slot.id, 'rea')
  assert.equal(registered[1].slot.id, 'rea-switch')
  assert.equal(typeof registered[0].slot.label, 'function')
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(typeof registered[1].component, 'function')
})

test('the declared client platform is web and names both UI packs', async () => {
  const client = PACKAGE.dsh.client
  assert.equal(client.platform, 'web')
  assert.ok(client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
})

test('display metadata and assets are declared', async () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await readFile(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'))
    assert.equal(typeof meta.meta.title, 'string')
    assert.equal(typeof meta.meta.description, 'string')
  }
  const icon = await readFile(new URL('../icon.svg', import.meta.url), 'utf8')
  assert.ok(icon.trimStart().startsWith('<svg'))
  for (const key of ['./locale/*.json', './icon']) {
    assert.ok(Object.hasOwn(PACKAGE.exports, key), `exports ${key}`)
  }
  assert.ok(PACKAGE.files.includes('lib'))
})
