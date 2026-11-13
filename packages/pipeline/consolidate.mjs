#!/usr/bin/env node
// consolidate.mjs — P1 提炼环：扫新增证据，挑「可能值得进 memory/」的候选，写到 candidates/YYYY-MM-DD.md。
// 不做决定，只出候选；采纳与否由人（或第二天的我）审。
//
// 用法：
//   node consolidate.mjs            # 增量（按 consolidate-state.json 的 lastT）
//   node consolidate.mjs --dry-run  # 只打印，不写文件/不推进水位
//   node consolidate.mjs --force    # 覆盖今天的文件，重新扫（默认追加会重复）
//   node consolidate.mjs --list     # 看最近候选文件的状态
//   node consolidate.mjs --days=7   # 只看最近 7 天（默认全部未读过）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(HOME, 'memcore')
const EPISODES = process.env.MEMCORE_EPISODES || path.join(DIR, 'episodes.jsonl')
const STATE = path.join(DIR, 'consolidate-state.json')
const OUTDIR = path.join(DIR, 'candidates')
const MEMORY = process.env.MEMCORE_MEMORY || 'D:/Deepseek-Core/Work/memory'

const args = process.argv.slice(2)
const flag = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const val = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}
const DRY = flag('dry-run')
const FORCE = flag('force')

const DECIDE = /就按|以后|没必要|留下|改成|结论|根因|先.{1,6}再|定稿|约定|规则|记住|别再|不用|保留|删掉|只留|优先/
const VERB = /改|删|加|留|换|停|装|跑|测|核|查|记|写|修|移|拆|合/
const STRONG = /结论|定论|根因|教训|规则|约定|记住|以后就|别再|就按/
const QUESTION = /[？?]\s*$/

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
  const out = new Set()
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2))
  return out
}

function jaccard(a, b) {
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  const uni = a.size + b.size - inter
  return uni ? inter / uni : 0
}

function memoryCorpus() {
  const texts = []
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else if (f.name.endsWith('.md')) texts.push(fs.readFileSync(p, 'utf8'))
    }
  }
  try { walk(MEMORY) } catch { /* memory 不在就空语料 */ }
  const grams = new Set()
  for (const t of texts) for (const g of bigrams(t.slice(0, 60000))) grams.add(g)
  return { grams, files: texts.length }
}

function scoreOf(rec, corpus) {
  const text = String(rec.x || '')
  if (!text.trim()) return null
  const isUser = rec.r === 'user'
  const grams = bigrams(text.slice(0, 1200))
  let shared = 0
  for (const g of grams) if (corpus.grams.has(g)) shared += 1
  const cov = grams.size ? shared / grams.size : 0
  if (cov > 0.62) return null // 已经在档案里了
  if (!isUser) {
    if (text.length > 700) return null
    if (!STRONG.test(text)) return null
  }
  let score = isUser ? 3 : 0.4
  const words = [...new Set((text.match(new RegExp(DECIDE.source, 'g')) || []))]
  score += Math.min(3, words.length) * 1.2
  score += Math.min(2, (text.match(new RegExp(VERB.source, 'g')) || []).length) * 0.2
  if (isUser && QUESTION.test(text)) {
    if (!words.length) score -= 1.5
  }
  return { score, cov, words }
}

function suggestTopic(text, corpusFiles) {
  // 简版：用 route 的关键词表找最接近的档案，找不到就「新档案」
  try {
    const table = JSON.parse(fs.readFileSync(path.join(MEMORY, 'route.json'), 'utf8'))
    const grams = bigrams(text)
    const scored = []
    for (const a of table.archives || []) {
      let hits = 0
      for (const kw of a.keywords || []) if (String(text).includes(kw)) hits += 1
      if (hits) scored.push({ file: a.file, hits })
    }
    scored.sort((x, y) => y.hits - x.hits)
    if (!scored.length) return '新档案'
    const [best, second] = scored
    if (!second || best.hits >= second.hits * 1.35) return `memory/${best.file}`
    return `memory/${best.file} 或 memory/${second.file}`
  } catch {
    return '新档案'
  }
}

function fmtTime(t) {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function contextAround(all, idx) {
  const out = []
  for (let i = Math.max(0, idx - 3); i <= Math.min(all.length - 1, idx + 3); i += 1) {
    if (i === idx) continue
    const r = all[i]
    const who = r.r === 'user' ? '主人' : r.r === 'assistant' ? '我' : '想'
    out.push(`${who}：${String(r.x || '').replace(/\s+/g, ' ').slice(0, 70)}`)
  }
  return out.slice(0, 2).join('\n')
}

// ---- main
if (flag('list')) {
  const files = fs.existsSync(OUTDIR) ? fs.readdirSync(OUTDIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort() : []
  if (!files.length) { console.log('(没有候选文件)'); process.exit(0) }
  for (const f of files.slice(-5)) {
    const raw = fs.readFileSync(path.join(OUTDIR, f), 'utf8')
    const blocks = raw.split(/^## /m).slice(1)
    const done = blocks.filter((b) => /✅\s*已采纳/.test(b)).length
    const no = blocks.filter((b) => /✗/.test(b)).length
    console.log(`${f} · ${blocks.length} 条 · 已采纳 ${done} · 已否决 ${no} · 未处理 ${blocks.length - done - no}`)
  }
  process.exit(0)
}

if (!fs.existsSync(EPISODES)) { console.error('没有 episodes.jsonl'); process.exit(1) }
const all = fs.readFileSync(EPISODES, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

let state = { lastT: 0, seen: [] }
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) } } catch { /* 首次 */ }

const days = Number(val('days')) || 0
const floor = days ? Date.now() - days * 86400000 : 0
const lastT = Math.max(Number(state.lastT) || 0, floor)

// 夜班会话：有 ［身份］ 注入的就是她的段，她的原话不进候选（只当线索）
const nightSessions = new Set()
for (const r of all) if (typeof r.x === 'string' && r.x.includes('［身份］')) nightSessions.add(r.s)

const corpus = memoryCorpus()
const fresh = []
for (let i = 0; i < all.length; i += 1) {
  const r = all[i]
  if (!r.t || r.t <= lastT) continue
  if (r.r === 'thought') continue
  if (nightSessions.has(r.s)) continue
  const sc = scoreOf(r, corpus)
  if (!sc || sc.score < 3.0) continue
  fresh.push({ ...r, idx: i, ...sc })
}

// 去重 + 每会话最多 3 条 + 总数 12
const picked = []
for (const c of fresh) {
  const grams = bigrams(String(c.x).slice(0, 1200))
  if (picked.some((p) => jaccard(grams, bigrams(String(p.x).slice(0, 1200))) > 0.55)) continue
  const perSession = picked.filter((p) => p.s === c.s).length
  if (perSession >= 3) continue
  picked.push(c)
  if (picked.length >= 12) break
}

if (!picked.length) {
  console.log('没有新候选（水位 lastT 之后没有够分的原话）')
  process.exit(0)
}

const today = new Date()
const p = (n) => String(n).padStart(2, '0')
const stamp = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
const outFile = path.join(OUTDIR, `${stamp}.md`)
const appendTo = !FORCE && fs.existsSync(outFile)
const startNo = appendTo ? (fs.readFileSync(outFile, 'utf8').match(/^## /gm) || []).length : 0

let prev = ''
try {
  const files = fs.readdirSync(OUTDIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()
  const prevFile = files.filter((f) => f !== `${stamp}.md`).pop()
  if (prevFile) {
    const raw = fs.readFileSync(path.join(OUTDIR, prevFile), 'utf8')
    const blocks = raw.split(/^## /m).slice(1)
    const done = blocks.filter((b) => /✅\s*已采纳/.test(b)).length
    const no = blocks.filter((b) => /✗/.test(b)).length
    prev = `上一份 ${prevFile}：${blocks.length} 条，已采纳 ${done}，已否决 ${no}，未处理 ${blocks.length - done - no}。`
  }
} catch { /* ignore */ }

const lines = []
lines.push(`# 候选定论 · ${stamp}`)
lines.push('')
lines.push(`> 由 consolidate.mjs 生成于 ${fmtTime(Date.now())}；窗口 ${fmtTime(lastT || (all[0]?.t || 0))} → ${fmtTime(Date.now())}。`)
if (prev) lines.push(`> ${prev}`)
lines.push('> 审阅：在块里打 `✅ 已采纳`；不要的写 `✗ 重复` / `✗ 一次性` / `✗ 无信息` / `✗ 已过时`。**标记写在对应块里**，别写文件尾。')
lines.push('')
picked.forEach((c, n) => {
  const who = c.r === 'user' ? '主人' : '我'
  const topic = suggestTopic(String(c.x), corpus.files)
  lines.push(`## ${startNo + n + 1} · ${fmtTime(c.t)} · ${who} · ${c.s.slice(-8)}`)
  lines.push('')
  lines.push(`- 原话：「${String(c.x).replace(/\s+/g, ' ').slice(0, 240)}」`)
  const ctx = contextAround(all, c.idx)
  if (ctx) lines.push(`- 上下文：${ctx.replace(/\n/g, ' ｜ ')}`)
  lines.push(`- 为什么入选：${Math.round(c.cov * 100)}% 已在档；决策词 ${c.words.join('/') || '无'}（分 ${c.score.toFixed(1)}）`)
  lines.push(`- 建议落点：${topic}（覆盖率 ≥0.18 才单选，否则给两个）`)
  lines.push('')
})

const text = lines.join('\n')
if (DRY || flag('stdout')) { console.log(text); process.exit(0) }

fs.mkdirSync(OUTDIR, { recursive: true })
if (FORCE || !fs.existsSync(outFile)) fs.writeFileSync(outFile, text)
else fs.appendFileSync(outFile, `\n${text.split('\n').slice(5).join('\n')}`)

const lastSeen = all.reduce((m, r) => Math.max(m, r.t || 0), 0)
const seen = [...(state.seen || []), ...picked.map((c) => String(c.x).slice(0, 160))].slice(-800)
fs.writeFileSync(STATE, JSON.stringify({ lastT: lastSeen, seen }, null, 2))
console.log(`写入 ${outFile}：${picked.length} 条候选`)

// 写完之后自动初审：能机械判定的直接判，剩下的留给会话里判断
try {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const out = execFileSync(process.execPath, [path.join(here, 'review.mjs')], { encoding: 'utf8' })
  const tail = out.trim().split('\n').pop()
  console.log(`自动初审：${tail}`)
} catch (error) {
  console.log(`自动初审失败（不影响候选本身）：${error?.message || error}`)
}
