// memcore 内核：给 MCP / HTTP / CLI 共用。只依赖 Node 内置 + lib/bm25.mjs。
// 数据格式与 DSH 插件一致：episodes.jsonl / facts.jsonl / decisions.jsonl / memory/*.md
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildIndex, scoreAll } from './bm25.mjs'

const DEFAULT_DIR = process.env.MEMCORE_DIR || path.join(os.homedir(), '.memcore')
const HALF_LIFE_DAYS = 14

export function readJsonl(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过，不中断 */ }
  }
  return out
}

function appendJsonl(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  return rec
}

export function tokens(query) {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return []
  const set = new Set()
  for (const word of q.split(/\s+/)) {
    if (!word) continue
    set.add(word)
    if (/[\u4e00-\u9fff]/.test(word)) for (let i = 0; i < word.length - 1; i += 1) set.add(word.slice(i, i + 2))
  }
  return [...set].filter((t) => t.length >= 2)
}

function lcsLen(a, b) {
  const A = [...String(a)]; const B = [...String(b)]
  let best = 0
  let prev = new Array(B.length + 1).fill(0)
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0)
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j] }
    }
    prev = cur
  }
  return best
}

const REASONING_Q = /怎么想|为什么|判断|依据|思路|怀疑|怎么确定|怎么想到|考虑|决定|推理|理由/

export function createCore(opts = {}) {
  const dir = path.resolve(opts.memoryDir || process.env.MEMCORE_DIR || DEFAULT_DIR)
  const episodesFile = path.join(dir, 'episodes.jsonl')
  const factsFile = path.join(dir, 'facts.jsonl')
  const decisionsFile = path.join(dir, 'decisions.jsonl')
  const memoryDir = path.resolve(opts.docsDir || process.env.MEMCORE_DOCS || path.join(dir, 'memory'))

  const caches = { ep: null, fact: null, dec: null, mem: null }

  function episodePool(filter = {}) {
    let rows = readJsonl(episodesFile)
    if (filter.session) rows = rows.filter((r) => r.s === filter.session)
    if (filter.from) rows = rows.filter((r) => r.t >= Date.parse(filter.from))
    if (filter.to) rows = rows.filter((r) => r.t <= Date.parse(filter.to))
    return rows
  }

  function memoryDocs() {
    const docs = []
    const walk = (d) => {
      let names = []
      try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of names) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.md')) continue
        let text = ''
        try { text = fs.readFileSync(p, 'utf8') } catch { continue }
        docs.push({ id: path.relative(dir, p).replace(/\\/g, '/'), title: e.name.replace(/\.md$/, ''), text })
      }
    }
    walk(memoryDir)
    for (const extra of ['AGENTS.md', 'README.md']) {
      const p = path.join(dir, extra)
      try { if (fs.existsSync(p)) docs.push({ id: extra, title: extra, text: fs.readFileSync(p, 'utf8') }) } catch { /* ignore */ }
    }
    return docs
  }

  function docPool() {
    const docs = memoryDocs()
    const key = docs.map((d) => `${d.id}:${d.text.length}`).join('|')
    if (caches.doc?.key !== key) {
      caches.doc = {
        key,
        rows: docs.map((d) => {
          let t = Date.now()
          try { t = fs.statSync(path.join(dir, d.id)).mtimeMs } catch { /* 用当前时间 */ }
          return { t, r: 'doc', x: d.text, s: d.id }
        }),
      }
    }
    return caches.doc.rows
  }

  function indexes(filter) {
    const eps = episodePool(filter)
    const docs = filter?.pool === 'memory' ? [] : docPool()
    const key = `${eps.length}|${eps[eps.length - 1]?.t || 0}|${docs.length}`
    if (!caches.ep || caches.ep.key !== key) {
      const rows = eps.concat(docs)
      caches.ep = { key, idx: buildIndex(rows.map((r) => ({ text: r.x || '' })), { unigrams: true, titleBoost: 0 }), rows }
    }
    return caches.ep
  }

  function factHitsFor(query) {
    const facts = readJsonl(factsFile)
    if (!facts.length) return null
    const key = `${facts.length}|${facts[facts.length - 1]?.ts || 0}`
    if (!caches.fact || caches.fact.key !== key) {
      caches.fact = { key, idx: buildIndex(facts.map((f) => ({ text: [f.subject, ...(f.aliases || []), f.note].filter(Boolean).join('｜') })), { unigrams: true, titleBoost: 0 }), rows: facts }
    }
    const scores = Array.from(scoreAll(caches.fact.idx, String(query || ''), {}))
    const idxs = scores.map((v, i) => [v, i]).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0])
    const hits = idxs.slice(0, 3).map(([v, i]) => {
      const f = caches.fact.rows[i]
      return { ...f, bridge: (f.aliases || []).some((a) => lcsLen(query, a) >= 3), score: Math.round(v * 100) / 100 }
    })
    return hits.length ? hits : null
  }

  function decisionRoute(query) {
    const rows = readJsonl(decisionsFile)
    if (!rows.length) return null
    const key = `${rows.length}|${rows[rows.length - 1]?.ts || 0}`
    if (!caches.dec || caches.dec.key !== key) {
      caches.dec = { key, idx: buildIndex(rows.map((r) => ({ text: [r.decision, r.reason, r.evidence, r.alternatives].filter(Boolean).join('｜') })), { unigrams: true, titleBoost: 0 }), rows }
    }
    const scores = Array.from(scoreAll(caches.dec.idx, String(query || ''), {}))
    const idxs = scores.map((v, i) => [v, i]).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0]).slice(0, 3)
    const hits = idxs.map(([v, i]) => ({ ...caches.dec.rows[i], score: Math.round(v * 100) / 100 }))
    return hits.length ? hits : null
  }

  function selfRefOf(text, q, role) {
    if (role === 'user') return false
    const t = String(text || '').toLowerCase()
    const s = String(q || '').toLowerCase().trim()
    if (!s || s.length < 6 || t.length < s.length) return false
    if (t.includes(s)) return true
    const win = Math.min(12, Math.max(6, Math.floor(s.length * 0.6)))
    for (let i = 0; i + win <= s.length; i += 1) if (t.includes(s.slice(i, i + win))) return true
    return false
  }

  function recall(args = {}) {
    const query = String(args.query || '')
    const toks = tokens(query)
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 6))
    const halfLife = Number(args.halfLifeDays ?? HALF_LIFE_DAYS)
    const now = Date.now()
    const pool = args.pool === 'memory' ? null : indexes(args)
    const factHits = factHitsFor(query)
    const bridged = !!(factHits && factHits.some((f) => f.bridge))
    const extra = bridged ? factHits.filter((f) => f.bridge).slice(0, 2).map((f) => f.subject).filter((s) => !query.toLowerCase().includes(s.toLowerCase())) : []
    const effQuery = extra.length ? `${query} ${extra.join(' ')}` : query
    const hits = []
    if (pool) {
      const scores = scoreAll(pool.idx, effQuery, { roleWeights: { thought: 0.5 } })
      for (let i = 0; i < pool.rows.length; i += 1) {
        const raw = scores[i]
        if (!raw) continue
        const rec = pool.rows[i]
        const ageDays = Math.max(0, (now - Number(rec.t || now)) / 86400000)
        const decay = halfLife > 0 ? Math.pow(0.5, ageDays / halfLife) : 1
        hits.push({ rec, base: raw, score: raw * decay, ageDays, meta: selfRefOf(rec.x, query, rec.r) })
      }
    }
    const bestClean = hits.reduce((m, h) => (h.meta ? m : Math.max(m, h.score)), 0)
    for (const h of hits) {
      if (!h.meta) continue
      h.score *= 0.5
      if (bestClean > 0) h.score = Math.min(h.score, bestClean * 0.99)
    }
    hits.sort((a, b) => b.score - a.score || (b.rec.t || 0) - (a.rec.t || 0))
    const items = hits.slice(0, limit).map((h) => ({
      at: new Date(h.rec.t || now).toISOString().replace('T', ' ').slice(0, 19),
      session: h.rec.r === 'doc' ? path.basename(String(h.rec.s || '')) : String(h.rec.s || '').slice(8, 16),
      role: h.rec.r === 'user' ? '用户' : h.rec.r === 'thought' ? '思考' : h.rec.r === 'doc' ? '档案' : '我',
      text: String(h.rec.x || '').slice(0, Number(args.maxChars) || 600),
      score: Math.round(h.score * 100) / 100,
      ...(h.rec.r === 'doc' ? { doc: String(h.rec.s || '') } : {}),
      ...(h.meta ? { meta: true } : {}),
    }))
    let confidence = null
    if (hits.length) {
      const text = String(hits[0].rec.x || '').toLowerCase()
      const coverage = toks.length ? Math.round((toks.filter((t) => text.includes(t)).length / toks.length) * 100) / 100 : 0
      const margin = hits[1] && hits[1].score > 0 ? Math.round((hits[0].score / hits[1].score) * 100) / 100 : 99
      const selfRef = selfRefOf(text, query, hits[0].rec.r)
      const weak = selfRef || (coverage < 0.3 && !bridged) || margin < 1.2
      confidence = { coverage, margin, weak, ...(selfRef ? { selfRef: true } : {}), ...(bridged ? { bridged: true } : {}) }
    }
    return {
      ok: true,
      query,
      dir,
      matched: hits.length,
      ...(factHits ? { facts: factHits } : {}),
      ...(REASONING_Q.test(query) ? { decisions: decisionRoute(query) } : {}),
      ...(confidence ? { confidence } : {}),
      items,
    }
  }

  function trace(args = {}) {
    const q = String(args.query || '').toLowerCase()
    if (!q) return { ok: false, error: 'query 不能为空' }
    const hits = []
    const scan = (text, meta) => {
      const low = String(text || '').toLowerCase()
      let i = low.indexOf(q)
      while (i >= 0 && hits.length < (Number(args.limit) || 20)) {
        hits.push({ ...meta, excerpt: String(text).slice(Math.max(0, i - 60), i + 120) })
        i = low.indexOf(q, i + q.length)
      }
    }
    for (const r of readJsonl(episodesFile)) scan(r.x, { at: new Date(r.t).toISOString().slice(0, 19), session: String(r.s || '').slice(8, 16), role: r.r })
    for (const d of memoryDocs()) scan(d.text, { file: d.id })
    return { ok: true, query: q, total: hits.length, hits: hits.slice(0, Number(args.limit) || 20) }
  }

  function remember(args = {}) {
    const file = String(args.file || 'notes.md').replace(/[\\/]/g, '')
    const note = String(args.note || '').trim()
    if (!note) return { ok: false, error: 'note 不能为空' }
    const p = path.join(memoryDir, file)
    fs.mkdirSync(memoryDir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const head = fs.existsSync(p) ? '' : `# ${file.replace(/\.md$/, '')}\n`
    fs.appendFileSync(p, `${head}\n- ${date} ${note}\n`, 'utf8')
    caches.mem = null
    return { ok: true, file: p, bytes: fs.statSync(p).size }
  }

  function factWrite(args = {}) {
    const subject = String(args.subject || '').trim()
    if (subject.length < 2) return { ok: false, error: 'subject 太短' }
    const aliases = (Array.isArray(args.aliases) ? args.aliases : String(args.aliases || '').split(/[,，、]/)).map((x) => String(x || '').trim()).filter(Boolean)
    const note = String(args.note || '').trim()
    if (!note && !aliases.length) return { ok: false, error: 'note / aliases 至少给一个' }
    const rec = appendJsonl(factsFile, {
      id: `f${Date.now().toString(36)}`, ts: Date.now(), subject,
      ...(aliases.length ? { aliases } : {}), ...(note ? { note } : {}),
      ...(args.validFrom ? { validFrom: args.validFrom } : {}), ...(args.validTo ? { validTo: args.validTo } : {}),
    })
    caches.fact = null
    return { ok: true, ...rec }
  }

  function decide(args = {}) {
    const decision = String(args.decision || '').trim()
    const reason = String(args.reason || '').trim()
    if (decision.length < 4 || reason.length < 4) return { ok: false, error: 'decision / reason 都要写清楚（≥4 字）' }
    const rec = appendJsonl(decisionsFile, { id: `d${Date.now().toString(36)}`, ts: Date.now(), date: new Date().toISOString().slice(0, 10), decision, reason, ...(args.evidence ? { evidence: args.evidence } : {}), ...(args.alternatives ? { alternatives: args.alternatives } : {}) })
    caches.dec = null
    return { ok: true, ...rec }
  }

  function stats() {
    const eps = readJsonl(episodesFile)
    let memoryBytes = 0
    const docs = memoryDocs()
    for (const d of docs) memoryBytes += Buffer.byteLength(d.text)
    return {
      dir,
      episodes: eps.length,
      facts: readJsonl(factsFile).length,
      decisions: readJsonl(decisionsFile).length,
      memoryFiles: docs.length,
      memoryBytes,
      lastEpisodeAt: eps.length ? new Date(eps[eps.length - 1].t).toISOString() : null,
    }
  }

  function listMemory() {
    return memoryDocs().map((d) => ({ id: d.id, title: d.title, bytes: Buffer.byteLength(d.text), lines: d.text.split('\n').length }))
  }

  function readMemory(id) {
    const d = memoryDocs().find((x) => x.id === id)
    return d ? { ok: true, ...d } : { ok: false, error: 'not found' }
  }

  function listFacts() { return readJsonl(factsFile) }
  function listDecisions() { return readJsonl(decisionsFile).slice().reverse() }

  return { dir, recall, trace, remember, factWrite, decide, stats, listMemory, readMemory, listFacts, listDecisions }
}
