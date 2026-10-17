// Browser half: dock balance pill + overview popover + full dashboard overlay.
//
// Data comes from the host half:
//   GET /dsh-plugin/usage/api/balance
//   GET /dsh-plugin/usage/api/summary
// and the dashboard SPA is served at /dsh-plugin/usage/.
window.__ModuleLoader__.load({
  id: 'dsh-usage-analytics',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const e = React.createElement

    const STYLE_ID = 'dsh-usage-analytics-style'
    const TEXT = 'var(--dsw-alias-label-secondary, #6b6b72)'
    const PRIMARY = 'var(--dsw-alias-label-primary, #1c1c1e)'
    const MUTED = 'var(--dsw-alias-label-tertiary, #8a8a90)'
    const BRAND = 'var(--dsw-alias-brand-primary, #5686fe)'
    const GREEN = '#2f8a4a'
    const RED = '#c0392b'

    const CSS = `
.dshua-pill {
  display: inline-flex; align-items: center;
  padding: 1px 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.24));
  background: transparent; color: ${TEXT};
  font-family: inherit; font-size: 12px; line-height: 18px;
  font-variant-numeric: tabular-nums; white-space: nowrap;
  cursor: pointer; order: 999;
}
.dshua-pill:hover { color: ${PRIMARY}; border-color: var(--dsw-alias-brand-primary, #5686fe); }
.dshua-pill:focus-visible { outline: 2px solid ${BRAND}; outline-offset: 1px; }
.dshua-pill[data-muted="1"] { opacity: 0.72; }
.dshua-panel {
  position: fixed; z-index: 2147483001; width: 360px;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #1c1c1e);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
  border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,0.24);
  font-family: inherit; font-size: 12.5px; line-height: 1.5; overflow: hidden;
}
.dshua-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06)); }
.dshua-title { font-weight: 600; flex: 1; }
.dshua-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.dshua-tab {
  appearance: none; border: 1px solid transparent; background: transparent; color: ${MUTED};
  font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
}
.dshua-tab[data-active="1"] { color: ${PRIMARY}; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
.dshua-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px 12px; }
.dshua-kpi { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06)); border-radius: 10px; padding: 8px 10px; }
.dshua-kpi-label { color: ${MUTED}; font-size: 11px; }
.dshua-kpi-value { color: ${PRIMARY}; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dshua-spark { padding: 0 12px 8px; color: ${MUTED}; }
.dshua-list { padding: 0 6px 6px; }
.dshua-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; }
.dshua-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.10)); }
.dshua-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${TEXT}; }
.dshua-row-value { color: ${PRIMARY}; font-variant-numeric: tabular-nums; }
.dshua-foot { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06)); }
.dshua-foot .dshua-balance { flex: 1; color: ${MUTED}; font-size: 12px; }
.dshua-button {
  appearance: none; border: 0; cursor: pointer; font: inherit;
  background: ${BRAND}; color: #fff; padding: 4px 10px; border-radius: 8px; font-size: 12px;
}
.dshua-button.ghost { background: transparent; color: ${TEXT}; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.24)); }
.dshua-button:hover { filter: brightness(1.06); }
.dshua-error { margin: 8px 12px; padding: 6px 8px; border-radius: 8px; background: rgba(192,57,43,0.10); color: ${RED}; font-size: 11.5px; }
.dshua-loading { padding: 16px 12px; color: ${MUTED}; }
.dshua-overlay { position: fixed; inset: 0; z-index: 2147483002; background: rgba(0,0,0,0.55); display: flex; flex-direction: column; }
.dshua-overlay-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: #0f1115; color: #c8ccd8; font-size: 12.5px; }
.dshua-overlay-title { flex: 1; }
.dshua-overlay iframe { flex: 1; width: 100%; border: 0; background: #0a0a0a; }
.dshua-close {
  appearance: none; border: 0; background: transparent; color: #c8ccd8; cursor: pointer;
  font-size: 18px; line-height: 1; padding: 2px 8px; border-radius: 6px;
}
.dshua-close:hover { background: rgba(255,255,255,0.10); color: #fff; }
`

    function installStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function metadata() {
      const boot = typeof globalThis === 'undefined' ? undefined : globalThis.__DSH_BOOT__
      const version = boot && boot.release && typeof boot.release.version === 'string'
        ? boot.release.version
        : '0.0.0'
      return {
        version,
        locale: typeof navigator === 'undefined' ? 'en' : (navigator.language || 'en'),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
    }

    async function getJson(path) {
      const response = await fetch(path, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function money(amount) {
      const value = Number(amount)
      if (!Number.isFinite(value)) return '—'
      if (value === 0) return '¥0.00'
      if (value > 0 && value < 0.01) return '<¥0.01'
      return `¥${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    }

    function compactTokens(value) {
      const n = Number(value ?? 0)
      if (!Number.isFinite(n)) return '0'
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
      return String(n)
    }

    function percent(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return `${(n * 100).toFixed(1)}%`
    }

    function dayStart() {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return start.getTime()
    }

    const RANGES = [
      { id: 'today', label: '今日', from: () => dayStart() },
      { id: '7d', label: '7天', from: () => Date.now() - 7 * 86400000 },
      { id: '30d', label: '30天', from: () => Date.now() - 30 * 86400000 },
    ]

    function Sparkline(props) {
      const points = props.points
      if (!Array.isArray(points) || points.length === 0) return null
      const width = 336
      const height = 38
      const max = Math.max(...points.map((p) => p.cost), 0.000001)
      const step = points.length === 1 ? width : width / (points.length - 1)
      const coords = points.map((p, index) => {
        const x = index * step
        const y = height - (p.cost / max) * (height - 4) - 2
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      return e('svg', { className: 'dshua-spark', width: '100%', height: height, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
        e('polyline', { points: coords.join(' '), fill: 'none', stroke: BRAND, strokeWidth: 1.6, strokeLinejoin: 'round' }))
    }

    function Overview(props) {
      const data = props.data
      const totals = data.totals ?? {}
      return e('div', null,
        e('div', { className: 'dshua-kpis' },
          e('div', { className: 'dshua-kpi' },
            e('div', { className: 'dshua-kpi-label' }, '成本'),
            e('div', { className: 'dshua-kpi-value' }, money(totals.cost))),
          e('div', { className: 'dshua-kpi' },
            e('div', { className: 'dshua-kpi-label' }, '请求'),
            e('div', { className: 'dshua-kpi-value' }, Number(totals.requests ?? 0).toLocaleString())),
          e('div', { className: 'dshua-kpi' },
            e('div', { className: 'dshua-kpi-label' }, 'Token'),
            e('div', { className: 'dshua-kpi-value' }, compactTokens((totals.input ?? 0) + (totals.cacheRead ?? 0) + (totals.output ?? 0)))),
          e('div', { className: 'dshua-kpi' },
            e('div', { className: 'dshua-kpi-label' }, '缓存命中'),
            e('div', { className: 'dshua-kpi-value' }, percent(totals.cacheHitRate)))),
        e(Sparkline, { points: data.daily ?? [] }),
        e('div', { className: 'dshua-list' },
          ...((data.byModel ?? []).slice(0, 3).map((model) => e('div', { className: 'dshua-row', key: model.model },
            e('span', { className: 'dshua-row-name' }, model.model ?? '未知模型'),
            e('span', { className: 'dshua-row-value' }, money(model.cost)))))),
      )
    }

    function OverviewPanel(props) {
      const [range, setRange] = React.useState('7d')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      const load = React.useCallback((rangeId) => {
        const preset = RANGES.find((item) => item.id === rangeId) ?? RANGES[1]
        setLoading(true)
        setError(null)
        const to = Date.now()
        getJson(`/dsh-plugin/usage/api/summary?from=${preset.from()}&to=${to}`)
          .then((json) => setData(json))
          .catch((err) => { setData(null); setError(String(err)) })
          .finally(() => setLoading(false))
      }, [])

      React.useEffect(() => { load(range) }, [range, load])

      return e('div', null,
        e('div', { className: 'dshua-tabs' },
          ...RANGES.map((item) => e('button', {
            key: item.id,
            type: 'button',
            className: 'dshua-tab',
            'data-active': range === item.id ? '1' : '0',
            onClick: () => setRange(item.id),
          }, item.label))),
        loading ? e('div', { className: 'dshua-loading' }, '加载中…')
          : error !== null ? e('div', { className: 'dshua-error' }, `统计加载失败：${error}`)
            : data === null ? e('div', { className: 'dshua-loading' }, '暂无数据')
              : e(Overview, { data }),
      )
    }

    function DashboardOverlay(props) {
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') props.onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props])
      return ReactDOM.createPortal(
        e('div', { className: 'dshua-overlay', role: 'dialog', 'aria-label': '用量分析' },
          e('div', { className: 'dshua-overlay-bar' },
            e('span', { className: 'dshua-overlay-title' }, '用量分析 · Dashboard'),
            e('button', { type: 'button', className: 'dshua-close', onClick: props.onClose, title: '关闭（Esc）' }, '×')),
          e('iframe', { src: '/dsh-plugin/usage/', title: '用量分析 Dashboard' })),
        document.body,
      )
    }

    function UsagePill(props) {
      const [balance, setBalance] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [rect, setRect] = React.useState(null)
      const [dashboard, setDashboard] = React.useState(false)
      const pillRef = React.useRef(null)
      const loadBalanceRef = React.useRef(props.loadBalance)
      loadBalanceRef.current = props.loadBalance

      const refresh = React.useCallback(() => {
        const fn = loadBalanceRef.current
        if (typeof fn !== 'function') return
        fn().then((value) => { if (value !== null) setBalance(value) }).catch(() => {})
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = window.setInterval(refresh, 5 * 60 * 1000)
        const onFocus = () => refresh()
        window.addEventListener('focus', onFocus)
        return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
      }, [refresh])

      React.useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (pillRef.current !== null && pillRef.current.contains(event.target)) return
          if (event.target instanceof Element && event.target.closest('.dshua-panel') !== null) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', close)
        window.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', close)
          window.removeEventListener('keydown', onKey)
        }
      }, [open])

      const wallets = balance !== null && Array.isArray(balance.wallets) ? balance.wallets : []
      const bonusWallets = balance !== null && Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
      const primary = wallets[0] ?? bonusWallets[0]
      const label = primary !== undefined
        ? money(primary.balance)
        : '用量'

      const toggle = () => {
        if (pillRef.current !== null) setRect(pillRef.current.getBoundingClientRect())
        setOpen((value) => !value)
      }

      return e('span', { className: 'dshua-pill', ref: pillRef, role: 'button', tabIndex: 0,
        title: primary !== undefined ? '账户余额 · 点击查看用量与成本' : '用量与成本 · 点击查看',
        'data-muted': primary === undefined ? '1' : '0',
        onClick: toggle,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() } } },
        label,
        open && rect !== null ? ReactDOM.createPortal(
          e('div', {
            className: 'dshua-panel',
            style: {
              bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`,
              right: `${Math.max(8, window.innerWidth - rect.right)}px`,
            },
          },
            e('div', { className: 'dshua-head' },
              e('span', { className: 'dshua-title' }, '用量与成本'),
              e('button', { type: 'button', className: 'dshua-close', onClick: () => setOpen(false), title: '关闭' }, '×')),
            e(OverviewPanel, null),
            e('div', { className: 'dshua-foot' },
              e('span', { className: 'dshua-balance' },
                primary !== undefined
                  ? `余额 ${money(primary.balance)}${bonusWallets.length > 0 ? ` · 赠送 ${money(bonusWallets[0].balance)}` : ''}`
                  : '余额不可用'),
              e('button', { type: 'button', className: 'dshua-button ghost', onClick: refresh }, '刷新'),
              e('button', { type: 'button', className: 'dshua-button', onClick: () => { setOpen(false); setDashboard(true) } }, '打开 Dashboard'))),
          document.body,
        ) : null,
        dashboard ? e(DashboardOverlay, { onClose: () => setDashboard(false) }) : null,
      )
    }

    function apply(ctx) {
      installStyle()
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'usage-analytics',
        order: 999,
        inject: () => ({
          loadBalance: async () => {
            try {
              const meta = metadata()
              const json = await getJson(
                `/dsh-plugin/usage/api/balance?v=${encodeURIComponent(meta.version)}`
                + `&locale=${encodeURIComponent(meta.locale)}&tz=${meta.timezoneOffsetSeconds}`,
              )
              return json !== null && json.ok === true ? json : null
            } catch {
              return null
            }
          },
        }),
      }, UsagePill))
    }

    exports.name = 'dsh-usage-analytics'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
