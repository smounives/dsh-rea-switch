/**
 * Host half of dsh-rea-switch.
 *
 * The REA MCP server is one `@deepseek-ai/dsh-mcp-client` row (`rea-mcp`) that the
 * user's home patch inserts. A row inserted by a later layer cannot be overridden
 * by the profile patch, which is applied *before* the home patch, so switching it
 * means editing the home patch itself: the managed block this module appends sits
 * after the `insert:` row and therefore wins.
 *
 * Routes (same-origin, loopback):
 *   GET  /plugins/dsh-rea-switch/status
 *   POST /plugins/dsh-rea-switch/state   { enabled: boolean }
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MARK_END,
  MARK_START,
  ROW_ID,
  ROW_IDS,
  TARGET_MODULE,
  hasManagedBlock,
  managedDisabled,
  renderPatch,
} from './patch.js'

export const name = 'dsh-rea-switch'
export const inject = ['webServer']

const MAX_BODY_BYTES = 4 * 1024
/** Rename failures that mean "try again" on Windows rather than "give up". */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST'])
const APPLY_TIMEOUT_MS = 8_000
const POLL_MS = 120
const REA_TOOL_PREFIX = 'mcp__rea__'

/** Serialize writes and the polling that follows them. */
let queue = Promise.resolve()

function serialize(work) {
  const run = queue.then(work, work)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function patchPath(ctx) {
  const profile = ctx.get('profileContext')
  if (typeof profile?.home !== 'string' || profile.home === '') return undefined
  return join(profile.home, 'cordis.patch.yml')
}

const UTF16_BOMS = [
  [0xff, 0xfe],
  [0xfe, 0xff],
]

/** Read the patch as UTF-8, refusing UTF-16 instead of corrupting it. */
async function readPatch(path) {
  let raw
  try {
    raw = await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return '[]\n'
    throw error
  }
  if (raw.length >= 2 && UTF16_BOMS.some(([a, b]) => raw[0] === a && raw[1] === b)) {
    // Windows editors and PowerShell 5.1 redirection write UTF-16; appending our
    // UTF-8 block to that would leave the file unreadable for the YAML loader.
    throw Object.assign(new Error('home patch 不是 UTF-8（疑似 UTF-16）：请用 UTF-8 编辑器保存后再试'), {
      code: 'patch-encoding-unsupported',
    })
  }
  return raw.toString('utf8')
}

/**
 * Write through a temporary file and rename.
 *
 * POSIX replaces atomically; Windows can refuse the replace while another process
 * holds the file (editor, indexer, antivirus), so retry the transient codes before
 * giving up and reporting the failure to the UI.
 */
async function writePatch(path, text) {
  const temp = `${path}.rea-switch.tmp`
  await writeFile(temp, text, { mode: 0o600 })
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      lastError = error
      if (!TRANSIENT_RENAME_CODES.has(error?.code)) break
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
  await rm(temp, { force: true }).catch(() => undefined)
  throw lastError
}

function findEntry(ctx) {
  const loader = ctx.get('loader')
  if (typeof loader?.entries !== 'function') return undefined
  // Both REA registrations may appear in the composed tree. DSH keeps only one
  // live entry per serverName, so prefer the row that uses the expected module and
  // is actually running; a stale or foreign row must never shadow the live one.
  const candidates = []
  for (const entry of loader.entries()) {
    const id = entry?.options?.id
    if (!ROW_IDS.includes(id)) continue
    candidates.push({
      entryId: id,
      moduleName: entry.options.name ?? null,
      disabled: entry.disabled === true,
      running: entry.fiber !== undefined,
      matchesTarget: (entry.options.name ?? null) === TARGET_MODULE,
    })
  }
  if (candidates.length === 0) return undefined
  const rank = (row) => (row.matchesTarget ? 0 : 2) + (row.running ? 0 : 1)
  candidates.sort((a, b) => rank(a) - rank(b))
  return candidates[0]
}

/**
 * Ask the Plugins page to re-read the live Loader inventory.
 *
 * That page joins `listBundles` with `listPlugins`, but only refreshes on
 * `plugin-manager/changed` (and on reconnect). We write the home patch directly
 * instead of going through the plugin manager, so without this event an open
 * Plugins page keeps showing the REA row as enabled — the exact "关了但还显示开"
 * mismatch. The payload is advisory; the manager's own event carries a `reason`.
 */
function notifyPluginManager(ctx) {
  try {
    if (typeof ctx?.emit === 'function') {
      ctx.emit('plugin-manager/changed', { reason: 'dsh-rea-switch' })
    }
  } catch {
    /* A host without the remote event bus simply keeps its own view. */
  }
}

function toolUsage(ctx) {
  try {
    const tools = ctx.get('tools')
    if (typeof tools?.schemas !== 'function') return null
    const schemas = tools.schemas()
    if (!Array.isArray(schemas)) return null
    let rea = 0
    for (const schema of schemas) {
      const toolName = schema?.name
      if (typeof toolName === 'string' && toolName.startsWith(REA_TOOL_PREFIX)) rea += 1
    }
    return { total: schemas.length, rea }
  } catch {
    return null
  }
}

/** Collect one status snapshot. Exported for tests. */
export async function collectStatus(ctx) {
  const path = patchPath(ctx)
  const text = path === undefined ? '' : await readPatch(path).catch(() => '')
  const entry = findEntry(ctx)
  const managed = hasManagedBlock(text)
  const override = managedDisabled(text)

  return {
    ok: true,
    generatedAt: Date.now(),
    target: { rowId: entry?.entryId ?? ROW_ID, moduleName: TARGET_MODULE, acceptedRowIds: ROW_IDS },
    configured: entry !== undefined,
    enabled: entry !== undefined && entry.disabled === false,
    runtime: entry ?? null,
    patch: {
      path: path ?? null,
      managed,
      override,
      exists: path !== undefined && text !== '' && text.trim() !== '[]',
      marker: { start: MARK_START, end: MARK_END },
    },
    tools: toolUsage(ctx),
  }
}

async function waitForState(ctx, enabled) {
  const deadline = Date.now() + APPLY_TIMEOUT_MS
  for (;;) {
    const entry = findEntry(ctx)
    if (entry !== undefined && entry.disabled === !enabled) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Apply one desired state, persisting it in the home patch. Exported for tests. */
export async function setEnabled(ctx, enabled) {
  const path = patchPath(ctx)
  if (path === undefined) throw Object.assign(new Error('profile-unavailable'), { code: 'profile-unavailable' })
  // Read before inspecting the entry: an unreadable patch (UTF-16, permissions) is
  // the more precise failure, and it is why the row may look absent.
  const before = await readPatch(path)

  const entry = findEntry(ctx)
  if (entry === undefined) throw Object.assign(new Error('rea-row-not-configured'), { code: 'rea-row-not-configured' })
  if (entry.moduleName !== null && entry.moduleName !== TARGET_MODULE) {
    throw Object.assign(new Error('rea-row-module-mismatch'), { code: 'rea-row-module-mismatch' })
  }

  const next = renderPatch(before, !enabled, entry.entryId)
  let changed = false
  if (next !== before) {
    await writePatch(path, next)
    changed = true
  }

  const applied = await waitForState(ctx, enabled)
  if (changed) notifyPluginManager(ctx)
  return {
    changed,
    applied,
    restartRequired: !applied,
    status: await collectStatus(ctx),
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text)
}

function trustedRequest(ctx, req) {
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  if (typeof connection?.requestRejection === 'function') {
    return connection.requestRejection(req) === undefined
  }
  const host = req.headers.host
  return typeof host === 'string' && req.headers.origin === `http://${host}`
}

const SECURITY_HEADER = 'x-dsh-rea-switch'

export function apply(ctx) {
  const statusRoute = async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (!trustedRequest(ctx, req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    try {
      sendJson(res, 200, await collectStatus(ctx))
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const stateRoute = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (!trustedRequest(ctx, req) || req.headers[SECURITY_HEADER] !== 'manage') {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (
      typeof req.headers['content-type'] !== 'string' ||
      !req.headers['content-type'].toLowerCase().startsWith('application/json')
    ) {
      sendJson(res, 415, { ok: false, error: 'unsupported-media-type' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    if (typeof body?.enabled !== 'boolean') {
      sendJson(res, 400, { ok: false, error: 'invalid-enabled' })
      return
    }
    try {
      const result = await serialize(() => setEnabled(ctx, body.enabled))
      sendJson(res, 200, { ok: true, requested: body.enabled, ...result })
    } catch (error) {
      const code = error?.code ?? 'apply-failed'
      const conflict = code === 'rea-row-not-configured' || code === 'rea-row-module-mismatch'
      const status = conflict || code === 'patch-encoding-unsupported' ? 409 : 500
      sendJson(res, status, { ok: false, error: code, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/plugins/dsh-rea-switch/status', handler: statusRoute }),
    'dsh-rea-switch: status route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/plugins/dsh-rea-switch/state', handler: stateRoute }),
    'dsh-rea-switch: state route',
  )
}
