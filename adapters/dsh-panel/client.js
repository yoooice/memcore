/**
 * dsh-memcore-panel — 浏览器半。
 *
 * 左侧栏一级入口「记忆核心」+ 主面板：检索原话、看事实层与决策台账、浏览档案。
 * 数据走宿主半注册的 api/memcore/*，同进程读 ~/.dsh/memcore，不开端口。
 *
 * 普通脚本、无构建：React 来自页面的模块表。
 * SPDX-License-Identifier: MIT
 */

window.__ModuleLoader__.load({
  id: 'dsh-memcore-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const PANEL = 'memcore'
    const API = 'api/memcore'
    const EXAMPLES = ['窗口闪烁是怎么回事', '跨模型接口怎么接', '为什么没有接语义模型', '记忆文件被改了怎么知道']

    const CSS = `
.mc { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
.mc-head { display: flex; align-items: baseline; gap: 10px; padding: 10px 14px; border-bottom: 1px solid rgba(128,128,128,.25); }
.mc-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.mc-dim { opacity: .55; font-size: 12px; }
.mc-tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid rgba(128,128,128,.2); }
.mc-tab { border: 1px solid transparent; border-bottom: 0; background: none; color: inherit; font: inherit; padding: 5px 10px; cursor: pointer; border-radius: 6px 6px 0 0; opacity: .65; }
.mc-tab.on { border-color: rgba(128,128,128,.3); background: rgba(128,128,128,.08); opacity: 1; }
.mc-pane { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 40px; }
.mc-search { display: flex; gap: 8px; margin-bottom: 10px; }
.mc-search input { flex: 1; font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(128,128,128,.35); background: rgba(128,128,128,.06); color: inherit; }
.mc-search input:focus { outline: 2px solid rgba(80,140,255,.35); outline-offset: 1px; }
.mc-btn { border: 1px solid rgba(128,128,128,.4); background: rgba(128,128,128,.1); color: inherit; font: inherit; padding: 5px 11px; border-radius: 7px; cursor: pointer; }
.mc-btn:hover { background: rgba(128,128,128,.2); }
.mc-btn.pri { border-color: rgba(80,140,255,.6); background: rgba(80,140,255,.18); }
.mc-chip { display: inline-block; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(128,128,128,.35); background: rgba(128,128,128,.08); margin: 0 5px 5px 0; cursor: pointer; }
.mc-chip:hover { border-color: rgba(80,140,255,.6); }
.mc-banner { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 7px 10px; margin-bottom: 10px; font-size: 12.5px; }
.mc-banner.weak { border-color: rgba(200,150,40,.55); background: rgba(200,150,40,.09); }
.mc-card { border: 1px solid rgba(128,128,128,.22); border-radius: 9px; padding: 9px 11px; margin-bottom: 8px; }
.mc-card.meta { opacity: .65; border-style: dashed; }
.mc-row { display: flex; gap: 8px; align-items: center; font-size: 11.5px; opacity: .65; margin-bottom: 5px; flex-wrap: wrap; }
.mc-pill { border: 1px solid rgba(128,128,128,.35); border-radius: 999px; padding: 0 7px; font-size: 10.5px; opacity: .9; }
.mc-score { margin-left: auto; font-variant-numeric: tabular-nums; }
.mc-text { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
.mc-sec { font-size: 11px; letter-spacing: .05em; text-transform: uppercase; opacity: .5; margin: 14px 0 7px; }
.mc-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.mc-table th, .mc-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(128,128,128,.15); vertical-align: top; }
.mc-table th { opacity: .6; font-weight: 600; border-bottom-color: rgba(128,128,128,.3); }
.mc-form { display: grid; gap: 7px; border: 1px solid rgba(128,128,128,.25); border-radius: 9px; padding: 10px; margin-bottom: 12px; }
.mc-form input, .mc-form textarea { font: inherit; padding: 6px 9px; border-radius: 7px; border: 1px solid rgba(128,128,128,.35); background: rgba(128,128,128,.06); color: inherit; }
.mc-form .two { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.mc-empty { opacity: .55; padding: 18px 0; text-align: center; }
.mc-ok { color: #4caf7d; font-size: 12px; }
.mc-file { display: flex; justify-content: space-between; gap: 10px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
.mc-file:hover { background: rgba(128,128,128,.12); }
.mc-pre { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.6; margin: 0; }
`

    function useStyles() {
      useEffect(() => {
        const tag = document.createElement('style')
        tag.dataset.pluginCss = PANEL
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, [])
    }

    async function get(path) {
      const r = await fetch(`${API}/${path}`)
      return r.json()
    }
    async function post(path, body) {
      const r = await fetch(`${API}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      return r.json()
    }

    function roleLabel(r) { return r === 'user' ? '用户' : r === 'thought' ? '思考' : '我' }

    function ResultCard({ it }) {
      const [open, setOpen] = useState(false)
      const t = String(it.text || '')
      const long = t.length > 320
      return h('div', { className: `mc-card${it.meta ? ' meta' : ''}` },
        h('div', { className: 'mc-row' },
          h('span', { className: 'mc-pill' }, roleLabel(it.role)),
          h('span', null, it.at),
          h('span', null, it.session),
          it.meta ? h('span', { className: 'mc-pill' }, '元记录') : null,
          h('span', { className: 'mc-score' }, String(it.score))),
        h('div', { className: 'mc-text' }, long && !open ? t.slice(0, 320) : t),
        long ? h('button', { className: 'mc-btn', style: { marginTop: 7 }, onClick: () => setOpen(!open) }, open ? '收起' : '展开全文') : null)
    }

    function SearchPane({ stats }) {
      const [q, setQ] = useState('')
      const [busy, setBusy] = useState(false)
      const [out, setOut] = useState(null)
      const [ms, setMs] = useState(0)

      async function run(text) {
        const query = (text ?? q).trim()
        if (!query) return
        setBusy(true); setQ(query)
        const t0 = performance.now()
        const r = await get(`recall?q=${encodeURIComponent(query)}&limit=8`)
        setMs(Math.round(performance.now() - t0))
        setOut(r); setBusy(false)
      }

      const c = out?.confidence
      return h('div', null,
        h('div', { className: 'mc-search' },
          h('input', {
            value: q, placeholder: '问它：我以前说过什么？',
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') run() },
          }),
          h('button', { className: 'mc-btn pri', disabled: busy, onClick: () => run() }, busy ? '检索中' : '检索')),
        h('div', null, EXAMPLES.map((ex) => h('span', { key: ex, className: 'mc-chip', onClick: () => run(ex) }, ex))),
        c ? h('div', { className: `mc-banner${c.weak ? ' weak' : ''}` },
          c.weak
            ? h('span', null, h('b', null, '弱命中，先反问。'), ' ', c.ask || '大概什么时候？关键词或路径？是我说的还是你说的？')
            : h('span', null, `覆盖率 ${c.coverage} · 分差 ${c.margin}× · ${ms} ms`)) : null,
        out?.facts?.length ? h('div', null,
          h('div', { className: 'mc-sec' }, '事实层命中'),
          out.facts.map((f) => h('span', { key: f.id || f.subject, className: 'mc-chip', title: f.note || '' },
            `${f.subject}${f.bridge ? ' · 别名桥' : ''} · ${f.score}`))) : null,
        out?.decisions?.length ? h('div', null,
          h('div', { className: 'mc-sec' }, '决策台账'),
          out.decisions.map((d) => h('div', { key: d.id || d.decision, className: 'mc-card' },
            h('b', null, d.decision), h('div', { className: 'mc-dim', style: { marginTop: 3 } }, d.reason)))) : null,
        out ? h('div', { className: 'mc-sec' }, `${out.matched} 条命中 · 显示前 ${out.items.length}`) : null,
        out?.items?.map((it) => h(ResultCard, { key: it.id || `${it.session}-${it.at}-${it.score}`, it })),
        !out && !busy ? h('div', { className: 'mc-empty' }, `库里 ${stats?.episodes ?? '?'} 条原话、${stats?.facts ?? '?'} 条事实、${stats?.decisions ?? '?'} 条决策`) : null)
    }

    function FactsPane({ onChange }) {
      const [facts, setFacts] = useState([])
      const [msg, setMsg] = useState('')
      const [form, setForm] = useState({ subject: '', aliases: '', note: '' })
      async function load() { const r = await get('facts'); setFacts(r.facts || []) }
      useEffect(() => { load() }, [])
      async function submit(e) {
        e.preventDefault()
        const r = await post('fact', form)
        setMsg(r.ok ? '已写入' : (r.error || '失败'))
        if (r.ok) { setForm({ subject: '', aliases: '', note: '' }); load(); onChange?.() }
      }
      return h('div', null,
        h('div', { className: 'mc-sec' }, '新增一条事实'),
        h('form', { className: 'mc-form', onSubmit: submit },
          h('div', { className: 'two' },
            h('input', { placeholder: '正名，例如 context-rotate', value: form.subject, onChange: (e) => setForm({ ...form, subject: e.target.value }) }),
            h('input', { placeholder: '别名，逗号分隔', value: form.aliases, onChange: (e) => setForm({ ...form, aliases: e.target.value }) })),
          h('input', { placeholder: '备注（一句话）', value: form.note, onChange: (e) => setForm({ ...form, note: e.target.value }) }),
          h('div', null, h('button', { className: 'mc-btn pri', type: 'submit' }, '写入'), ' ', h('span', { className: 'mc-ok' }, msg))),
        h('table', { className: 'mc-table' },
          h('thead', null, h('tr', null, h('th', null, '正名'), h('th', null, '别名'), h('th', null, '备注'))),
          h('tbody', null, facts.map((f) => h('tr', { key: f.id || f.subject },
            h('td', null, h('b', null, f.subject)),
            h('td', null, (f.aliases || []).join('、')),
            h('td', null, f.note || ''))))))
    }

    function DecisionsPane({ onChange }) {
      const [rows, setRows] = useState([])
      const [msg, setMsg] = useState('')
      const [form, setForm] = useState({ decision: '', reason: '', evidence: '' })
      async function load() { const r = await get('decisions'); setRows(r.decisions || []) }
      useEffect(() => { load() }, [])
      async function submit(e) {
        e.preventDefault()
        const r = await post('decide', form)
        setMsg(r.ok ? '已记录' : (r.error || '失败'))
        if (r.ok) { setForm({ decision: '', reason: '', evidence: '' }); load(); onChange?.() }
      }
      return h('div', null,
        h('div', { className: 'mc-sec' }, '记一条决策'),
        h('form', { className: 'mc-form', onSubmit: submit },
          h('input', { placeholder: '决定了什么', value: form.decision, onChange: (e) => setForm({ ...form, decision: e.target.value }) }),
          h('input', { placeholder: '为什么（理由）', value: form.reason, onChange: (e) => setForm({ ...form, reason: e.target.value }) }),
          h('input', { placeholder: '证据（可选）', value: form.evidence, onChange: (e) => setForm({ ...form, evidence: e.target.value }) }),
          h('div', null, h('button', { className: 'mc-btn pri', type: 'submit' }, '记录'), ' ', h('span', { className: 'mc-ok' }, msg))),
        rows.map((d) => h('div', { key: d.id || d.decision, className: 'mc-card' },
          h('div', { className: 'mc-row' }, h('span', null, d.date || ''), h('span', { className: 'mc-score' }, d.id || '')),
          h('b', null, d.decision),
          h('div', { className: 'mc-dim', style: { marginTop: 3 } }, d.reason),
          d.evidence ? h('div', { className: 'mc-dim', style: { marginTop: 2 } }, `证据：${d.evidence}`) : null)))
    }

    function FilesPane() {
      const [files, setFiles] = useState([])
      const [doc, setDoc] = useState(null)
      useEffect(() => { get('memory').then((r) => setFiles(r.files || [])) }, [])
      async function open(id) { const r = await get(`doc?id=${encodeURIComponent(id)}`); setDoc(r) }
      return h('div', null,
        doc?.ok ? h('div', null,
          h('div', { className: 'mc-row', style: { marginBottom: 8 } },
            h('button', { className: 'mc-btn', onClick: () => setDoc(null) }, '返回列表'),
            h('b', null, doc.title)),
          h('pre', { className: 'mc-pre' }, doc.text))
          : h('div', null,
            h('div', { className: 'mc-sec' }, `档案 ${files.length} 个`),
            files.map((f) => h('div', { key: f.id, className: 'mc-file', onClick: () => open(f.id) },
              h('span', null, f.title),
              h('span', { className: 'mc-dim' }, `${f.lines} 行 · ${f.bytes} B`)))))
    }

    function MemoryPage() {
      useStyles()
      const [tab, setTab] = useState('search')
      const [stats, setStats] = useState(null)
      async function loadStats() { setStats(await get('stats')) }
      useEffect(() => { loadStats() }, [])
      const tabs = [['search', '检索'], ['facts', '事实层'], ['decisions', '决策台账'], ['files', '档案']]
      return h('div', { className: 'mc' },
        h('div', { className: 'mc-head' },
          h('h2', null, '记忆核心'),
          h('span', { className: 'mc-dim' },
            stats ? `原话 ${stats.episodes} · 事实 ${stats.facts} · 决策 ${stats.decisions} · 档案 ${stats.memoryFiles}` : '读取中…'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'mc-btn', onClick: loadStats }, '刷新')),
        h('div', { className: 'mc-tabs' },
          tabs.map(([k, label]) => h('button', {
            key: k, className: `mc-tab${tab === k ? ' on' : ''}`, onClick: () => setTab(k),
          }, label))),
        h('div', { className: 'mc-pane' },
          tab === 'search' ? h(SearchPane, { stats }) : null,
          tab === 'facts' ? h(FactsPane, { onChange: loadStats }) : null,
          tab === 'decisions' ? h(DecisionsPane, { onChange: loadStats }) : null,
          tab === 'files' ? h(FilesPane) : null))
    }

    function Icon() {
      return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('path', { d: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z' }),
        h('path', { d: 'M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7' }),
        h('path', { d: 'M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, MemoryPage))
        } catch (e) { console.error('[memcore-panel] main slot failed', e) }
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL, order: 40, label: () => '记忆核心',
          }, Icon))
        } catch (e) { console.error('[memcore-panel] sidebar slot failed', e) }
      },
    }
  },
})
