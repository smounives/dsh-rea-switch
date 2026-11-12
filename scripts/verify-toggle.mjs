/**
 * Manual end-to-end check for the host half.
 *
 * Writes the managed block into the home patch, then removes it, watching the REA
 * MCP child process (`rea.mjs`) appear and disappear. That process only exists
 * while the `rea-mcp` row is started, so this is the proof that `dsh-hmr`
 * recomposed the composition instead of the file merely changing on disk.
 *
 * The file is restored to the text it had when the script started; pass
 * `--keep-off` to leave the managed block in place instead.
 *
 * Process probing uses `pgrep`, which does not exist on Windows: there the script
 * only checks that the file transitions and says so.
 *
 *   node scripts/verify-toggle.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { renderPatch } from '../lib/patch.js'

const file = join(homedir(), '.dsh', 'cordis.patch.yml')
const settle = 8000
const canProbe = process.platform !== 'win32'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// The bracket keeps pgrep from matching this script's own command line.
const running = () => {
  if (!canProbe) return null
  try {
    return execFileSync('pgrep', ['-fl', 'rea[.]mjs'], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
}
const label = (value) =>
  value === null ? 'not probed (pgrep is macOS/Linux only)' : value ? 'running' : 'stopped'
const write = async (text) => {
  await writeFile(`${file}.tmp`, text, { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}
const waitFor = async (want) => {
  if (!canProbe) {
    await sleep(settle)
    return null
  }
  for (let i = 0; i < settle / 250; i += 1) {
    await sleep(250)
    if (running() === want) return true
  }
  return false
}

const start = await readFile(file, 'utf8')
const enabled = renderPatch(start, false)
const disabled = renderPatch(start, true)

// Start from a known baseline so both transitions are actually observed.
await write(enabled)
await waitFor(true)
console.log('baseline      →', label(running()))
await write(disabled)
await waitFor(false)
console.log('after disable →', label(running()))
await write(enabled)
await waitFor(true)
console.log('after enable  →', label(running()))

if (process.argv.includes('--keep-off')) {
  await write(disabled)
  await waitFor(false)
  console.log('left disabled:', (await readFile(file, 'utf8')) === disabled)
} else {
  await write(start)
  console.log('restored byte-identical:', (await readFile(file, 'utf8')) === start)
}
