#!/usr/bin/env node
// auto-facts 原型：自动事实层 + 遗忘曲线权重。不读写 memory/，只做实验。
// 用法：
//   node autofacts.mjs seed [--file=<candidates.md>]   从候选文件播种
//   node autofacts.mjs tick [--days=0]                 按当前时间重算权重并归档
//   node autofacts.mjs list [--simulate=7,30]          列出现状 + 推演 N 天后
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const DIR = path.join(os.homedir(), '.dsh', 'memcore')
const STORE = path.join(DIR, 'auto-facts.jsonl')
const ARCHIVE = path.join(DIR, 'auto-facts.archive.jsonl')
const CANDIDATES = path.join(DIR, 'candidates', '2026-11-04.md')

const day = 86400000
const HALF_LIFE_DEFAULT = 30
const ARCHIVE_BELOW = 0.6
// 每类各自的半衰期：一次性操作 3 天就退场；临时决定给 90 天；兴趣给 30 天。
const HALF_LIFE = { decision: 90, conclusion: 30, oneoff: 3, interest: 30, focus: 7 }
// kind 基础分：决定 > 兴趣/结论 > 一次性操作
const KIND_BONUS = { decision: 1.5, conclusion: 0.8, oneoff: 0.5, interest: 1.0, focus: 1.2 }
const INTEREST_BONUS = 1.2 // interest 0–1 → 最多加 1.2 分

const argv = process.argv.slice(2)
const cmd = argv[0] || 'list'
const arg = (name, d) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : d
}

function readAll(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}
function writeAll(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}
function now() { return Date.now() }

function weight(r, at = now()) {
  const days = Math.max(0, (at - r.lastSeen) / day)
  const hl = HALF_LIFE[r.kind] ?? HALF_LIFE_DEFAULT
  // 命中次数（对话里被 recall/引用） + 兴趣分（逛互联网时自己觉得有意思）
  const base = 1 + 0.5 * Math.log1p(r.hits) + INTEREST_BONUS * (r.interest ?? 0)
  return base * Math.pow(0.5, days / hl) * (KIND_BONUS[r.kind] ?? 1)
}

function classify(who, text) {
  const t = text.replace(/\s+/g, '')
  if (who === 'user') {
    if (/改成|以后|不要|保留|去掉|拍板|决定|就按|不用|没必要/.test(t)) return 'decision'
    return 'oneoff'
  }
  return /结论|根因|教训|规则|约定|定论|必须|不能/.test(t) ? 'conclusion' : 'oneoff'
}

function seedFromCandidates(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const blocks = raw.split(/^## /m).slice(1)
  const out = []
  for (const b of blocks) {
    const head = b.split('\n')[0]
    const m = head.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/)
    const who = /·\s*user\b/i.test(head) ? 'user' : /·\s*assistant\b/i.test(head) ? 'assistant' : 'unknown'
    const q = b.match(/原话[:：]\s*(.+)/)
    if (!q || !m) continue
    const text = q[1].replace(/^[「“"]|[」”"]$/g, '').trim().slice(0, 180)
    if (!text || text.length < 8) continue
    const t = new Date(m[1].replace(' ', 'T') + ':00+08:00').getTime()
    const kind = classify(who, text)
    out.push({
      id: 'af-' + (out.length + 1).toString().padStart(3, '0'),
      text, kind, who,
      refAt: m[1].replace('T', ' ').slice(0, 16),
      firstSeen: t, lastSeen: t, hits: 1,
      interest: 0,
      weight: 0, status: 'active',
      source: 'candidates-2026-11-04',
    })
  }
  return out
}

function cmdSeed() {
  const file = arg('file', CANDIDATES)
  const fresh = seedFromCandidates(file)
  const existing = readAll(STORE)
  const seen = new Set(existing.map((r) => r.text))
  for (const r of fresh) {
    if (seen.has(r.text)) continue
    r.weight = weight(r)
    existing.push(r)
  }
  writeAll(STORE, existing)
  console.log(`播种 ${fresh.length} 条，库中 ${existing.length} 条`)
}

function cmdTick() {
  const days = Number(arg('days', 0))
  const at = now() + days * day
  const rows = readAll(STORE)
  const keep = [], arch = readAll(ARCHIVE)
  for (const r of rows) {
    const w = weight(r, at)
    r.weight = Number(w.toFixed(3))
    if (w < ARCHIVE_BELOW) { r.status = 'archived'; arch.push(r) }
    else keep.push(r)
  }
  writeAll(STORE, keep)
  writeAll(ARCHIVE, arch)
  console.log(`tick @${new Date(at).toISOString().slice(0, 16)}Z：留下 ${keep.length}，归档 ${arch.length}`)
}

function cmdAdd() {
  const text = String(arg('text', '')).trim()
  if (!text) { console.error('缺 --text='); process.exit(1) }
  const kind = String(arg('kind', 'interest'))
  if (!KIND_BONUS[kind]) { console.error(`未知 kind：${kind}`); process.exit(1) }
  const interest = Math.max(0, Math.min(1, Number(arg('interest', 0.6)) || 0))
  const source = String(arg('source', 'browse'))
  const rows = readAll(STORE)
  const r = {
    id: 'af-' + String(rows.length + 1).padStart(3, '0'),
    text: text.slice(0, 180), kind, who: 'me',
    firstSeen: now(), lastSeen: now(), hits: 1,
    interest, weight: 0, status: 'active', source,
  }
  r.weight = Number(weight(r).toFixed(3))
  rows.push(r)
  writeAll(STORE, rows)
  console.log(`+ ${r.id} [${kind}] interest=${interest} → w=${r.weight}`)
}

function cmdHit() {
  const id = String(arg('id', ''))
  const n = Number(arg('n', 1)) || 1
  const rows = readAll(STORE)
  const r = rows.find((x) => x.id === id)
  if (!r) { console.error(`找不到 ${id}`); process.exit(1) }
  r.hits += n
  r.lastSeen = now()
  r.weight = Number(weight(r).toFixed(3))
  writeAll(STORE, rows)
  console.log(`${id} hits=${r.hits} → w=${r.weight}`)
}

function cmdFocus() {
  const id = String(arg('id', ''))
  const boost = Math.max(0, Math.min(0.5, Number(arg('boost', 0.15)) || 0.15))
  const rows = readAll(STORE)
  if (id) {
    const r = rows.find((x) => x.id === id)
    if (!r) { console.error(`找不到 ${id}`); process.exit(1) }
    r.interest = Math.min(1, (r.interest ?? 0) + boost)
    r.hits += 1
    r.lastSeen = now()
    r.kind = r.kind === 'focus' ? 'focus' : r.kind
    r.weight = Number(weight(r).toFixed(3))
    writeAll(STORE, rows)
    console.log(`${id} 关注+${boost} → interest=${r.interest.toFixed(2)} w=${r.weight}`)
    return
  }
  const text = String(arg('text', '')).trim()
  if (!text) { console.error('缺 --id= 或 --text='); process.exit(1) }
  const interest = Math.max(0.1, Math.min(1, Number(arg('interest', 0.7)) || 0.7))
  const r = {
    id: 'af-' + String(rows.length + 1).padStart(3, '0'),
    text: text.slice(0, 180), kind: 'focus', who: 'me',
    refAt: localStamp(now()).slice(0, 16),
    firstSeen: now(), lastSeen: now(), hits: 1,
    interest, weight: 0, status: 'active', source: String(arg('source', 'manual')),
  }
  r.weight = Number(weight(r).toFixed(3))
  rows.push(r)
  writeAll(STORE, rows)
  console.log(`+ ${r.id} [focus] interest=${interest} → w=${r.weight}（半衰期 7 天，不续分就会退场）`)
}

function cmdList() {
  const sims = String(arg('simulate', '7,30')).split(',').map(Number).filter((n) => n > 0)
  const at = now()
  const rows = readAll(STORE)
  rows.sort((a, b) => weight(b, at) - weight(a, at))
  console.log('现在    ' + sims.map((d) => `+${d}天`.padEnd(8)).join('') + '兴趣 类型        内容')
  for (const r of rows) {
    const w0 = weight(r, at)
    const later = sims.map((d) => weight(r, at + d * day).toFixed(2).padEnd(8)).join('')
    console.log(`${w0.toFixed(2).padEnd(8)}${later}${String((r.interest ?? 0).toFixed(1)).padEnd(5)}${r.kind.padEnd(11)}${r.text.slice(0, 44)}`)
  }
  console.log(`\n共 ${rows.length} 条 active，归档 ${readAll(ARCHIVE).length} 条；阈值 ${ARCHIVE_BELOW}`)
}

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/[\s\p{P}]+/gu, '')
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}
function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const g of A) if (B.has(g)) n++
  return n / Math.min(A.size, B.size)
}

function localStamp(ms) {
  const d = new Date(Number(ms) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** recall 命中后调用：给对应的自动事实加一次 hits，并按新权重刷新。 */
export function recordHits(items) {
  try {
    const rows = readAll(STORE)
    if (!rows.length) return 0
    const t = now()
    let n = 0
    for (const it of items || []) {
      const at16 = String(it.at || '').slice(0, 16)
      const ex = String(it.excerpt || '')
      for (const r of rows) {
        const legacy = !r.refAt
        if (legacy) r.refAt = localStamp(r.firstSeen).slice(0, 16)
        const byTime = at16 && r.refAt === at16
        const byText = legacy && ex && r.text && overlap(r.text, ex) >= 0.6
        if (byTime || byText) {
          r.hits = (r.hits || 0) + 1
          r.lastSeen = t
          r.weight = Number(weight(r).toFixed(3))
          n++
          break
        }
      }
    }
    if (n) writeAll(STORE, rows)
    return n
  } catch {
    return 0
  }
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isCli) {
  if (cmd === 'seed') cmdSeed()
  else if (cmd === 'tick') cmdTick()
  else if (cmd === 'add') cmdAdd()
  else if (cmd === 'hit') cmdHit()
  else if (cmd === 'focus') cmdFocus()
  else cmdList()
}
