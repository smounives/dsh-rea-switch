/**
 * Client half of dsh-rea-switch.
 *
 * Registers one Settings section ("REA") plus a compact composer-dock pill, and
 * talks to the host routes mounted by lib/index.js. Written without JSX or a
 * bundler: the DSH module loader provides `react` and runs this factory in the
 * renderer.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rea-switch',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const ENDPOINT = '/plugins/dsh-rea-switch'

    const COLORS = {
      primary: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #59636e)',
      tertiary: 'var(--dsw-alias-label-tertiary, #818b98)',
      border: 'var(--dsw-alias-border-l2, rgba(31, 35, 40, 0.12))',
      success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      error: 'var(--dsw-alias-state-error-primary, #cf222e)',
      warning: 'var(--dsw-alias-state-warning-primary, #9a6700)',
      layer: 'var(--dsw-alias-bg-layer-2, rgba(31, 35, 40, 0.03))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 40, 0.06))',
    }

    function pick(locale) {
      return locale === 'en'
        ? {
            section: 'REA',
            title: 'REA MCP server',
            subtitle: '229 tool definitions leave the system prompt while this is off.',
            on: 'On',
            off: 'Off',
            turningOn: 'Starting…',
            turningOff: 'Stopping…',
            refresh: 'Refresh',
            missing: 'The REA row (rea-mcp) is not part of this profile.',
            applied: 'Applied. New tools take effect on the next request.',
            restart: 'Saved, but not live yet — restart DeepSeek Harness.',
            error: 'Failed',
            row: 'Row',
            patch: 'Home patch',
            source: 'Effective source',
            sourceManaged: 'this switch',
            sourceLower: 'home patch / launch overlay',
            tools: 'MCP tools',
            prompt: 'Prompt cost when on',
            copy: '≈ 37k tokens of the system prompt (measured)',
            hint: 'Writes a `disabled` override after the `insert:` row in the home patch, so it survives restarts and needs no restart to apply.',
          }
        : {
            section: 'REA',
            title: 'REA MCP 服务器',
            subtitle: '关掉后，229 个工具定义不再进入 system prompt。',
            on: '已启用',
            off: '已停用',
            turningOn: '正在启动…',
            turningOff: '正在停止…',
            refresh: '刷新',
            missing: '当前 profile 里没有 REA 行（rea-mcp）。',
            applied: '已生效，下一轮请求起工具集随之变化。',
            restart: '已写入配置，但尚未生效——请重启 DeepSeek Harness。',
            error: '操作失败',
            row: '行 id',
            patch: 'Home patch',
            source: '生效来源',
            sourceManaged: '本开关',
            sourceLower: 'home patch / 启动参数',
            tools: 'MCP 工具数',
            prompt: '启用时的提示词开销',
            copy: '约 37k tokens 的 system prompt（实测）',
            hint: '在 home patch 的 `insert:` 行之后追加一条 `disabled` 覆盖，重启后依然有效，且改动无需重启即可应用。',
          }
    }

    const LOCALE = /^zh/i.test(
      (typeof navigator === 'object' && navigator.language) || '',
    )
      ? 'zh'
      : 'en'
    const T = pick(LOCALE)

    const S = {
      root: { padding: '4px 0 24px', color: COLORS.primary, fontSize: 13, lineHeight: 1.55 },
      header: { display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between', marginBottom: 14 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      subtitle: { color: COLORS.secondary, fontSize: 12, marginTop: 3 },
      row: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: `1px solid ${COLORS.border}` },
      rowLabel: { color: COLORS.secondary, fontSize: 12 },
      rowValue: { color: COLORS.primary, fontSize: 12, fontWeight: 500, textAlign: 'right', wordBreak: 'break-all' },
      card: { border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      button: {
        appearance: 'none',
        border: `1px solid ${COLORS.border}`,
        background: 'transparent',
        color: COLORS.primary,
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
      },
      toggle: {
        appearance: 'none',
        border: 'none',
        borderRadius: 999,
        padding: '0',
        width: 44,
        height: 24,
        position: 'relative',
        cursor: 'pointer',
        flex: '0 0 auto',
        transition: 'background 120ms ease',
      },
      knob: {
        position: 'absolute',
        top: 3,
        width: 18,
        height: 18,
        borderRadius: 999,
        background: '#fff',
        transition: 'left 120ms ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
      },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500 },
      dot: { width: 8, height: 8, borderRadius: 999, display: 'inline-block' },
      banner: { borderRadius: 8, padding: '9px 11px', fontSize: 12, marginBottom: 12 },
      bannerOk: { background: 'rgba(26, 127, 55, 0.08)', color: COLORS.success },
      bannerWarn: { background: 'rgba(154, 103, 0, 0.09)', color: COLORS.warning },
      bannerError: { background: 'rgba(207, 34, 46, 0.08)', color: COLORS.error },
      hint: { color: COLORS.tertiary, fontSize: 11.5, marginTop: 10 },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11.5,
        fontWeight: 500,
        color: COLORS.secondary,
        border: `1px solid ${COLORS.border}`,
        background: 'transparent',
        borderRadius: 999,
        padding: '3px 10px',
        cursor: 'pointer',
      },
    }

    async function request(path, init) {
      const response = await fetch(`${ENDPOINT}${path}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...init,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok === false) {
        const reason = body?.error ?? `HTTP ${response.status}`
        throw new Error(reason)
      }
      return body
    }

    function useSwitch() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(async () => {
        try {
          const next = await request('/status')
          if (!alive.current) return
          setStatus(next)
          setError(null)
        } catch (cause) {
          if (!alive.current) return
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => {
          if (!busy) void load()
        }, 5000)
        return () => clearInterval(timer)
      }, [load, busy])

      const toggle = useCallback(async () => {
        const enabled = !(status?.enabled === true)
        setBusy(true)
        setNotice(null)
        try {
          const result = await request('/state', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-rea-switch': 'manage' },
            body: JSON.stringify({ enabled }),
          })
          if (!alive.current) return
          if (result.status !== undefined) setStatus(result.status)
          setNotice(
            result.applied === false
              ? { tone: 'warn', text: T.restart }
              : { tone: 'ok', text: T.applied },
          )
          void load()
        } catch (cause) {
          if (!alive.current) return
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [status, load])

      return { status, error, busy, notice, load, toggle }
    }

    function Banner({ tone, children }) {
      const style = tone === 'ok' ? S.bannerOk : tone === 'warn' ? S.bannerWarn : S.bannerError
      return h('div', { style: { ...S.banner, ...style } }, children)
    }

    function Row({ label, value }) {
      return h('div', { style: S.row },
        h('span', { style: S.rowLabel }, label),
        h('span', { style: S.rowValue }, value))
    }

    function Switch({ enabled, busy, onClick, label, title }) {
      const background = enabled ? COLORS.success : 'rgba(127, 127, 127, 0.35)'
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled === true,
        'aria-label': label,
        title,
        disabled: busy,
        onClick,
        style: { ...S.toggle, background, opacity: busy ? 0.6 : 1 },
      }, h('span', { style: { ...S.knob, left: enabled ? 23 : 3 } }))
    }

    function Card() {
      const { status, error, busy, notice, load, toggle } = useSwitch()
      const configured = status?.configured === true
      const enabled = status?.enabled === true
      const rea = status?.tools?.rea ?? 0
      const stateLabel = busy ? (enabled ? T.turningOff : T.turningOn) : enabled ? T.on : T.off

      return h('div', { style: S.root },
        h('div', { style: S.header },
          h('div', null,
            h('h3', { style: S.title }, T.title),
            h('div', { style: S.subtitle }, T.subtitle)),
          configured
            ? h(Switch, {
                enabled,
                busy,
                onClick: toggle,
                label: T.title,
                title: enabled ? T.off : T.on,
              })
            : null),
        error === null ? null : h(Banner, { tone: 'bad' }, `${T.error}：${error}`),
        notice === null ? null : h(Banner, { tone: notice.tone }, notice.text),
        !configured && status !== null ? h(Banner, { tone: 'warn' }, T.missing) : null,
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: S.badge },
              h('span', { style: { ...S.dot, background: enabled ? COLORS.success : COLORS.tertiary } }),
              stateLabel),
            h('button', { type: 'button', style: S.button, onClick: load, disabled: busy }, T.refresh)),
          h(Row, { label: T.row, value: status?.target?.rowId ?? 'rea-mcp' }),
          h(Row, { label: T.source, value: status?.patch?.managed === true ? T.sourceManaged : T.sourceLower }),
          h(Row, { label: T.patch, value: status?.patch?.path ?? '—' })),
        h('div', { style: S.card },
          h(Row, { label: T.tools, value: status?.tools === null || status?.tools === undefined ? '—' : String(rea) }),
          h(Row, { label: T.prompt, value: T.copy })),
        h('div', { style: S.hint }, T.hint))
    }

    function Pill() {
      const { status, busy, toggle } = useSwitch()
      const enabled = status?.enabled === true
      const configured = status?.configured === true
      return h('button', {
        type: 'button',
        style: { ...S.pill, opacity: busy ? 0.6 : 1 },
        disabled: busy || !configured,
        onClick: toggle,
        title: configured ? `${T.title} · ${enabled ? T.on : T.off}` : T.missing,
      },
        h('span', { style: { ...S.dot, background: enabled ? COLORS.success : COLORS.tertiary } }),
        'REA')
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'rea',
        order: 61,
        label: () => T.section,
      }, Card))

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'rea-switch',
        order: 40,
      }, Pill))
    }

    return { apply, inject }
  },
})
