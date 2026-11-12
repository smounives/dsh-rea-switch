/**
 * Comment-preserving edits of a patch file for one managed row.
 *
 * A row that carries only `id` + `disabled` is merged onto the row of the same id
 * contributed by an earlier layer. That is the same shape `plugin_manager` writes
 * for rows it can address, and the same shape the launcher uses for the telemetry
 * opt-out.
 *
 * The REA row is inserted by the *home* patch (`~/.dsh/cordis.patch.yml`), which
 * is applied after the profile patch, so only a row appended after that
 * `insert:` can override it. This module therefore edits the home patch and
 * appends its block at the end of the file.
 *
 * The block this module owns is delimited by two marker comments so it can be
 * removed again without touching any other row:
 *
 *     # >>> dsh-rea-switch: managed block — toggle from Settings → REA
 *     - id: rea-mcp
 *       disabled: true
 *     # <<< dsh-rea-switch
 *
 * Everything else in the file — other rows, comments, `!!js` tags, flow style —
 * is left byte-for-byte alone.
 */

/** Id of the row this bundle switches. */
export const ROW_ID = 'rea-mcp'
/**
 * Every row id this bundle accepts.
 *
 * Two registrations of the same REA server exist in the wild, and they differ only
 * in the loader row id:
 *   * `rea-mcp`  — upstream `rea setup --client dsh`, written into the home patch.
 *   * `mcp-rea`  — the `dsh-plugin-rea` bundle row, shipped inside the npm package
 *                  and composed before the profile/home patches.
 * Both use module `@deepseek-ai/dsh-mcp-client` and `serverName: rea`, and DSH keeps
 * only one entry per server name, so at most one of them is ever live. Matching on
 * the module name alone would risk touching an unrelated `serverName`, so the id is
 * still what selects the row — just not one hard-coded id.
 */
export const ROW_IDS = ['rea-mcp', 'mcp-rea']
/** Module name the targeted row must use, so a same-id impostor is never touched. */
export const TARGET_MODULE = '@deepseek-ai/dsh-mcp-client'
export const MARK_START = '# >>> dsh-rea-switch: managed block — toggle from Settings → REA'
export const MARK_END = '# <<< dsh-rea-switch'

function isStart(line) {
  return line.trim() === MARK_START
}

function isEnd(line) {
  return line.trim() === MARK_END
}

function blockLines(disabled, rowId = ROW_ID) {
  return [MARK_START, `- id: ${rowId}`, `  disabled: ${disabled}`, MARK_END]
}

/** Whether the text already carries this module's managed block. */
export function hasManagedBlock(text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex(isStart)
  const end = lines.findIndex(isEnd)
  return start !== -1 && end > start
}

/** The `disabled` value the managed block requests, or null when absent. */
export function managedDisabled(text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex(isStart)
  const end = lines.findIndex(isEnd)
  if (start === -1 || end <= start) return null
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*disabled:\s*(\S+)\s*$/.exec(line)
    if (match !== null) return match[1] === 'true'
  }
  return null
}

function isEmptyDocument(lines) {
  return lines.every((line) => {
    const trimmed = line.trim()
    return trimmed === '' || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...'
  })
}

function hasTopLevelItem(lines) {
  return lines.some((line) => /^-(\s|$)/.test(line) || line.trim().startsWith('['))
}

/**
 * Join lines back into a document with the file's own line ending.
 *
 * Only the document's tail is normalized (exactly one trailing newline). Nothing
 * else is rewritten: trailing spaces, blank-line runs and comments elsewhere in
 * the file stay exactly as the user left them.
 */
function assemble(lines, eol) {
  const trimmed = lines.join('\n').replace(/\n+$/, '')
  if (trimmed.trim() === '') return `[]${eol}`
  const kept = trimmed.split('\n')
  if (!hasTopLevelItem(kept) && isEmptyDocument(kept)) return `[]${eol}`
  return `${kept.join(eol)}${eol}`
}

/** The line ending the file already uses, so a Windows checkout stays CRLF. */
function lineEndingOf(source) {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Render the next profile patch text.
 *
 * `disabled === true` upserts the managed block; `disabled === false` removes it,
 * which restores whatever the lower layers say (the home patch).
 *
 * @param {string} text Current file text (missing file is `'[]\n'`).
 * @param {boolean} disabled Whether the target row should be off.
 * @param {string} [rowId] Row id the managed block overrides; the caller passes the
 *   id it actually found in the loader (`rea-mcp` or `mcp-rea`).
 * @returns {string} Complete next text.
 */
export function renderPatch(text, disabled, rowId = ROW_ID) {
  const source = typeof text === 'string' && text.length > 0 ? text : '[]\n'
  const eol = lineEndingOf(source)
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex(isStart)
  const end = lines.findIndex(isEnd)
  const hasBlock = start !== -1 && end > start

  if (hasBlock) {
    const next = [
      ...lines.slice(0, start),
      ...(disabled ? blockLines(true, rowId) : []),
      ...lines.slice(end + 1),
    ]
    return assemble(next, eol)
  }

  if (!disabled) return source

  const body = lines.slice()
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  const empty = isEmptyDocument(body) || (body.length === 1 && body[0].trim() === '[]')
  const head = empty ? [] : body
  return assemble([...head, ...(head.length === 0 ? [] : ['']), ...blockLines(true, rowId)], eol)
}
