/**
 * dsh-opencode-go-usage — client half.
 *
 * Adds one full-width entry above the composer card ("conversation.input.dock",
 * a list Slot, so nothing shipped is replaced) that shows how much of the
 * OpenCode Go plan's three quota windows is already spent: the rolling window,
 * the week and the month, each with the moment it resets.
 *
 * Why this exists: the plan limits are the first thing that decides whether a
 * turn will go through, but nothing in the GUI reports them — the only place to
 * look is the provider's own dashboard, in another tab, after a request has
 * already failed. This entry asks the host half (`GET /opencode-go/usage`) for
 * the same numbers and keeps them one glance away.
 *
 * Contract notes:
 *  - The host half owns the API key; the browser never sees it, and this bundle
 *    only reads the normalized `{ok, windows}` reading the route returns.
 *  - The entry re-polls once a minute while the page is visible and refreshes
 *    immediately when the tab becomes visible again after a longer pause.
 *  - A missing key or a failed read renders as a line of its own rather than as
 *    an empty row, so "no reading" never looks like "no quota used".
 *  - All styles are inline with `--dsw-*` theme tokens and safe fallbacks, so
 *    the entry follows the active theme without extra CSS.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.input.dock'
    const ENTRY_ID = 'opencode-go-usage'
    const ROUTE = 'opencode-go/usage'
    const PREF_KEY = 'dsh.opencode-go-usage.expanded'
    /** Poll cadence while the page is visible; the host caches for 20s anyway. */
    const POLL_MS = 60_000
    /** Countdown refresh; resets are minute-scale facts, so this is plenty. */
    const TICK_MS = 30_000
    /** Above this share the readout turns warning; at or above 100 it is spent. */
    const WARN_AT = 70
    const SPENT_AT = 100
    /** Windows the host route reports, in display order. */
    const WINDOWS = ['rolling', 'weekly', 'monthly']

    const TEXT = {
      title: 'OpenCode Go 限额',
      rolling: '滚动窗口',
      weekly: '本周',
      monthly: '本月',
      resetIn: '后重置',
      resetAt: '重置时间',
      updated: '更新于',
      refresh: '刷新',
      refreshing: '读取中…',
      expand: '展开明细',
      collapse: '收起明细',
      cached: '缓存',
      missingKey: '未配置 OPENCODE_GO_API_KEY',
      failed: '读取失败',
      loading: '读取限额…',
      retry: '重试',
      status: '状态',
      used: '已用',
      now: '即将重置',
      day: '天',
      hour: '小时',
      minute: '分',
      less: '不到 1 分钟',
    }

    const COLOR = {
      text1: 'var(--dsw-alias-label-primary, #1f2329)',
      text2: 'var(--dsw-alias-label-secondary, #5c6068)',
      text3: 'var(--dsw-alias-label-tertiary, #8b8f96)',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      warn: 'var(--dsw-alias-state-warning-primary, #d97706)',
      danger: 'var(--dsw-alias-state-error-primary, #d92d20)',
      border: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.22))',
      menu: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.06)))',
    }

    const STATUS_TEXT = {
      ok: '正常',
      warning: '接近上限',
      warn: '接近上限',
      limited: '已限流',
      rate_limited: '已限流',
      blocked: '已用尽',
      exhausted: '已用尽',
      over: '已用尽',
      unknown: '未知',
    }

    /* ------------------------------------------------------------------ *
     * Pure readers (exported for the offline harness)
     * ------------------------------------------------------------------ */

    /**
     * Clamp a reading into 0..100, or null when it is not a percentage.
     * @param value - candidate percentage.
     * @returns the percentage, or null.
     */
    function percentOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return Math.max(0, Math.min(100, value))
    }

    /**
     * Take one host reading apart into the windows worth rendering.
     *
     * The route's `windows` is trusted only as far as its shape: unknown window
     * names are dropped, a window without a percentage is dropped, and a reset
     * timestamp that does not parse becomes null instead of an Invalid Date.
     * @param reading - decoded host response, or anything else.
     * @returns `{ ok, windows, message, code, fetchedAt }`.
     */
    function parseReading(reading) {
      if (reading === null || typeof reading !== 'object') {
        return { ok: false, windows: [], message: TEXT.failed, code: 'shape', fetchedAt: null }
      }
      const fetchedAt = typeof reading.fetchedAt === 'string' ? Date.parse(reading.fetchedAt) : NaN
      const code = typeof reading.code === 'string' ? reading.code : undefined
      if (reading.ok !== true) {
        const message = typeof reading.message === 'string' && reading.message !== '' ? reading.message : TEXT.failed
        return { ok: false, windows: [], message, code, fetchedAt: Number.isNaN(fetchedAt) ? null : fetchedAt }
      }
      const source = reading.windows !== null && typeof reading.windows === 'object' ? reading.windows : {}
      const windows = []
      for (const name of WINDOWS) {
        const entry = source[name]
        if (entry === null || typeof entry !== 'object') continue
        const percent = percentOf(entry.percent)
        if (percent === null) continue
        const resetAt = typeof entry.resetsAt === 'string' ? Date.parse(entry.resetsAt) : NaN
        windows.push({
          name,
          percent,
          status: typeof entry.status === 'string' ? entry.status : 'unknown',
          resetsAt: Number.isNaN(resetAt) ? null : resetAt,
        })
      }
      return {
        ok: windows.length > 0,
        windows,
        message: windows.length > 0 ? '' : TEXT.failed,
        code,
        fetchedAt: Number.isNaN(fetchedAt) ? null : fetchedAt,
      }
    }

    /** Tone of one window: normal, warning, or spent. */
    function toneOf(percent) {
      if (percent === null) return 'muted'
      if (percent >= SPENT_AT) return 'danger'
      if (percent >= WARN_AT) return 'warn'
      return 'ok'
    }

    /** Colour for one tone. */
    function colorOf(tone) {
      if (tone === 'danger') return COLOR.danger
      if (tone === 'warn') return COLOR.warn
      if (tone === 'muted') return COLOR.text3
      return COLOR.accent
    }

    /** Whole-percent label; one decimal below 1% so 0.4% does not read as zero. */
    function formatPercent(percent) {
      if (percent === null) return '—'
      if (percent > 0 && percent < 1) return percent.toFixed(1) + '%'
      return Math.round(percent) + '%'
    }

    /**
     * Compact duration for a reset countdown.
     * @param ms - milliseconds until the reset; negative means already due.
     * @returns a Chinese duration such as `3 小时 12 分`.
     */
    function formatCountdown(ms) {
      if (typeof ms !== 'number' || Number.isNaN(ms)) return '—'
      if (ms <= 0) return TEXT.now
      const minutes = Math.floor(ms / 60_000)
      if (minutes < 1) return TEXT.less
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const rest = minutes % 60
      if (days > 0) return days + ' ' + TEXT.day + (hours > 0 ? ' ' + hours + ' ' + TEXT.hour : '')
      if (hours > 0) return hours + ' ' + TEXT.hour + (rest > 0 ? ' ' + rest + ' ' + TEXT.minute : '')
      return rest + ' ' + TEXT.minute
    }

    /** Local wall-clock time of a reset, or null. */
    function formatClock(ms) {
      if (typeof ms !== 'number' || Number.isNaN(ms)) return null
      try {
        return new Date(ms).toLocaleString(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return null
      }
    }

    /**
     * The window that resets first — the one whose approach matters most.
     * @param windows - parsed windows.
     * @returns that window, or null when none carries a reset time.
     */
    function soonestReset(windows) {
      let best = null
      for (const window of windows) {
        if (window.resetsAt === null) continue
        if (best === null || window.resetsAt < best.resetsAt) best = window
      }
      return best
    }

    /** The one-line summary shown while collapsed. */
    function summarize(windows, now) {
      if (windows.length === 0) return ''
      const parts = windows.map((window) => shortLabel(window.name) + ' ' + formatPercent(window.percent))
      const soonest = soonestReset(windows)
      if (soonest !== null) parts.push(formatCountdown(soonest.resetsAt - now) + TEXT.resetIn)
      return parts.join(' · ')
    }

    /** Short window label for the collapsed summary. */
    function shortLabel(name) {
      if (name === 'rolling') return '滚动'
      if (name === 'weekly') return '周'
      if (name === 'monthly') return '月'
      return name
    }

    /** Full label for the expanded rows. */
    function windowLabel(name) {
      if (name === 'rolling') return TEXT.rolling
      if (name === 'weekly') return TEXT.weekly
      if (name === 'monthly') return TEXT.monthly
      return name
    }

    /** Readable status, falling back to the provider's own word. */
    function statusText(status) {
      return STATUS_TEXT[status] ?? status
    }

    /** Expand preference survives reloads, like the sibling readouts. */
    function readExpandedPreference() {
      try {
        return window.localStorage.getItem(PREF_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeExpandedPreference(value) {
      try {
        window.localStorage.setItem(PREF_KEY, value ? '1' : '0')
      } catch {}
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    function buttonStyle() {
      return {
        flex: 'none',
        border: 'none',
        background: 'transparent',
        color: COLOR.text2,
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '20px',
        padding: '0 4px',
        borderRadius: '6px',
      }
    }

    /** One bar plus its caption, used for every window in the expanded body. */
    function WindowRow({ window, now }) {
      const tone = toneOf(window.percent)
      const color = colorOf(tone)
      const clock = formatClock(window.resetsAt)
      return h(
        'div',
        {
          'data-opencode-go-window': window.name,
          style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '3px 0' },
        },
        h(
          'span',
          {
            style: {
              flex: 'none',
              width: '74px',
              color: COLOR.text2,
              fontSize: '12.5px',
              lineHeight: '18px',
            },
          },
          windowLabel(window.name),
        ),
        h(
          'span',
          {
            style: {
              flex: 'none',
              width: '48px',
              textAlign: 'right',
              color,
              fontSize: '12.5px',
              lineHeight: '18px',
              fontVariantNumeric: 'tabular-nums',
            },
          },
          formatPercent(window.percent),
        ),
        h(
          'span',
          {
            style: {
              flex: '1 1 auto',
              height: '4px',
              borderRadius: '999px',
              background: 'rgba(127, 127, 127, 0.18)',
              overflow: 'hidden',
            },
          },
          h('span', {
            style: {
              display: 'block',
              width: Math.max(1, window.percent) + '%',
              height: '100%',
              borderRadius: '999px',
              background: color,
            },
          }),
        ),
        h(
          'span',
          {
            title: clock === null ? undefined : TEXT.resetAt + ' ' + clock,
            style: {
              flex: 'none',
              width: '132px',
              textAlign: 'right',
              color: COLOR.text3,
              fontSize: '12px',
              lineHeight: '18px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            },
          },
          window.resetsAt === null ? '—' : formatCountdown(window.resetsAt - now) + TEXT.resetIn,
        ),
      )
    }

    function OpenCodeGoUsage() {
      const [reading, setReading] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [expanded, setExpanded] = React.useState(readExpandedPreference)
      const [, setTick] = React.useState(0)
      const lastFetch = React.useRef(0)
      const inFlight = React.useRef(false)

      const load = React.useCallback(async (force) => {
        if (inFlight.current) return
        inFlight.current = true
        lastFetch.current = Date.now()
        setPhase('loading')
        try {
          const response = await fetch(ROUTE + (force ? '?force=1' : ''), {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const body = await response.json()
          setReading(body)
          setPhase('ready')
        } catch (error) {
          setReading({ ok: false, code: 'transport', message: String(error?.message ?? error) })
          setPhase('ready')
        } finally {
          inFlight.current = false
        }
      }, [])

      // First read on mount, then the steady poll while the page is visible.
      React.useEffect(() => {
        void load(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void load(false)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      // Coming back after a long absence skips the wait for the next tick.
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return
          if (Date.now() - lastFetch.current >= POLL_MS) void load(false)
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, [load])

      // Countdowns are rendered from a ticking clock, not from fetch results.
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), TICK_MS)
        return () => clearInterval(timer)
      }, [])

      const parsed = React.useMemo(() => parseReading(reading), [reading])
      const now = Date.now()

      const toggle = () => {
        setExpanded((previous) => {
          const next = !previous
          writeExpandedPreference(next)
          return next
        })
      }

      // Nothing configured: say so quietly once, instead of hiding the row and
      // leaving the reader wondering whether the plugin loaded at all.
      if (parsed.code === 'no-key') {
        return h(
          'div',
          {
            'data-dsh-opencode-go-usage': 'true',
            'data-opencode-go-state': 'no-key',
            style: {
              boxSizing: 'border-box',
              width: '100%',
              maxWidth: 'var(--dsh-composer-card-max-width, 720px)',
              margin: '0 auto',
              padding: '2px 12px',
              color: COLOR.text3,
              fontSize: '12px',
              lineHeight: '20px',
            },
          },
          TEXT.title + ' · ' + TEXT.missingKey,
        )
      }

      const failed = !parsed.ok && phase !== 'loading'
      const dotTone = failed ? 'muted' : parsed.ok ? toneOf(Math.max(...parsed.windows.map((window) => window.percent))) : 'muted'

      const header = h(
        'div',
        {
          style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0', width: '100%', padding: '2px 4px 2px 0' },
        },
        h('span', {
          'data-opencode-go-dot': dotTone,
          'aria-hidden': 'true',
          style: { flex: 'none', width: '7px', height: '7px', borderRadius: '999px', background: colorOf(dotTone) },
        }),
        h(
          'span',
          {
            style: { flex: 'none', color: COLOR.text1, fontSize: '13px', fontWeight: '500', lineHeight: '24px' },
          },
          TEXT.title,
        ),
        h(
          'span',
          {
            'data-opencode-go-meta': 'true',
            title: failed ? parsed.message : summarize(parsed.windows, now),
            style: {
              minWidth: '0',
              flex: '1 1 auto',
              color: failed ? COLOR.danger : COLOR.text3,
              fontSize: '12.5px',
              lineHeight: '20px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          },
          phase === 'loading' && !parsed.ok && reading === null ? TEXT.loading : failed ? parsed.message : summarize(parsed.windows, now),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => void load(true),
            title: TEXT.refresh,
            'aria-label': TEXT.refresh,
            'data-opencode-go-refresh': 'true',
            style: buttonStyle(),
          },
          '⟳',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: toggle,
            title: expanded ? TEXT.collapse : TEXT.expand,
            'aria-expanded': expanded ? 'true' : 'false',
            style: buttonStyle(),
          },
          expanded ? '▴' : '▾',
        ),
      )

      const body = expanded
        ? h(
            'div',
            {
              'data-opencode-go-details': 'true',
              style: { display: 'flex', flexDirection: 'column', padding: '2px 2px 6px' },
            },
            ...parsed.windows.map((window) => h(WindowRow, { key: window.name, window, now })),
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: '10px',
                  color: COLOR.text3,
                  fontSize: '11.5px',
                  lineHeight: '18px',
                  paddingTop: '2px',
                },
              },
              h('span', null, TEXT.status + ' ' + (parsed.windows.map((window) => statusText(window.status)).join(' / ') || '—')),
              parsed.fetchedAt === null
                ? null
                : h(
                    'span',
                    null,
                    TEXT.updated + ' ' + (formatClock(parsed.fetchedAt) ?? '—'),
                  ),
              failed ? h('span', { style: { color: COLOR.danger } }, parsed.message) : null,
            ),
          )
        : null

      return h(
        'div',
        {
          'data-dsh-opencode-go-usage': 'true',
          style: {
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: 'var(--dsh-composer-card-max-width, 720px)',
            margin: '0 auto',
            padding: '0 12px 2px',
            borderRadius: 'var(--dsw-radius-md, 10px)',
            background: COLOR.menu,
            boxShadow: 'inset 0 0 0 1px ' + COLOR.border,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
        header,
        body,
      )
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (slots === undefined || slots === null) return
      slots.inject(SLOT, () =>
        slots.register(
          {
            name: SLOT,
            id: ENTRY_ID,
            order: 45,
            label: () => TEXT.title,
          },
          OpenCodeGoUsage,
        ),
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    module.exports.OpenCodeGoUsage = OpenCodeGoUsage
    module.exports.parseReading = parseReading
    module.exports.summarize = summarize
    module.exports.formatCountdown = formatCountdown
    module.exports.formatPercent = formatPercent
    module.exports.toneOf = toneOf
    module.exports.soonestReset = soonestReset
    return module.exports
  },
})
