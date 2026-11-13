#!/usr/bin/env node
// review.mjs — 候选定论的自动初审。
//
// 背景：consolidate.mjs 每天往 candidates/ 追加条目，但"审"这一步一直靠人（16 条积压 3 天）。
// 这里把可以机械判定的一律判掉并留下依据，只把真正需要判断的留成 pending。
//
// 状态落在 candidates/.state.json（id = 文件名#块号），同时在 md 块里追加一行 `- 审：…`，
// 让文件自己说明结论；consolidate 下一份的统计会顺着这行读。
//
// 用法：
//   node review.mjs                 # 只预演，打印判定表，不写任何文件
//   node review.mjs --apply         # 写入 md 标记 + state.json
//   node review.mjs --pending       # 只列还没判的
//   node review.mjs --accept 2026-11-06#3 --note="…"   # 人工采纳
//   node review.mjs --reject 2026-11-06#3 --note="…"   # 人工否决
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(HOME, 'memcore')
const OUTDIR = path.join(DIR, 'candidates')
const STATE = path.join(OUTDIR, '.state.json')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f) => {
  const i = argv.indexOf(f)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const hit = argv.find((a) => a.startsWith(f + '='))
  return hit ? hit.slice(f.length + 1) : null
}

const PATH_RE = /[A-Za-z]:[\\/]|\\\\|\.(?:jsonl?|md|mjs|js|py|exe|dll|zstd|log|yml|yaml|zip|ps1)\b/
const DECISION_RE = /改|建|删|迁|装|配置|版本|路径|报错|修|换|关|开|禁|允许|不要|必须|以后|规则|承诺/
const TASK_RE = /^(请|帮我|麻烦你?|给我)[^。！？]{0,80}(审查|检查|看|读|下载|安装|分析|改|写|跑|验证)/

function blocksOf(md) {
  const lines = md.split('\n')
  const out = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^## (\d+) · (.+?) · (.+?) · (\S+)$/)
    if (m) {
      if (cur) out.push(cur)
      cur = { no: Number(m[1]), date: m[2], role: m[3], session: m[4], lines: [line] }
    } else if (cur) cur.lines.push(line)
  }
  if (cur) out.push(cur)
  for (const b of out) {
    const body = b.lines.join('\n')
    const q = body.match(/- 原话：「([\s\S]*?)」\s*$/m)
    const pct = body.match(/(\d+(?:\.\d+)?)% 已在档/)
    const sug = body.match(/- 建议落点：(.+)$/m)
    b.quote = q ? q[1].replace(/\s+/g, ' ').trim() : ''
    b.pct = pct ? Number(pct[1]) : 0
    b.suggest = sug ? sug[1].trim() : ''
    b.marked = /- 审：/.test(body) || /✅\s*已采纳/.test(body) || /✗/.test(body.replace(/不要的写[^\n]*/, ''))
  }
  return out
}

function triage(b) {
  const q = b.quote
  if (b.marked) return { status: 'done', note: '已有审阅标记' }
  if (b.pct >= 50) return { status: 'rejected', reason: '重复', note: `已在档 ${b.pct}%，档案里已有这条` }
  if (TASK_RE.test(q)) return { status: 'rejected', reason: '一次性', note: '任务指令本身不是定论；结果应在完成时另行记档' }
  if (q.length <= 30 && !PATH_RE.test(q) && !/[0-9]/.test(q) && !DECISION_RE.test(q))
    return { status: 'rejected', reason: '无信息', note: `寒暄/情绪，${q.length} 字，无路径、无数字、无规则词` }
  if (!PATH_RE.test(q) && !DECISION_RE.test(q) && !/[0-9]/.test(q))
    return { status: 'rejected', reason: '无信息', note: '纯对话，没有可落档的事实或规则' }
  return { status: 'pending', note: '需要判断：可能是新事实/新规则' }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'))
  } catch {
    return { version: 1, items: {} }
  }
}

function saveState(st) {
  fs.mkdirSync(OUTDIR, { recursive: true })
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n', 'utf8')
}

const notePrefix = { accepted: '✅ 已采纳', rejected: '✗', expired: '✗ 已过时' }

function writeMark(file, b, status, reason, note, by = 'auto') {
  const p = path.join(OUTDIR, file)
  const md = fs.readFileSync(p, 'utf8')
  const lines = md.split('\n')
  const head = `## ${b.no} · ${b.date} · ${b.role} · ${b.session}`
  const i = lines.indexOf(head)
  if (i < 0) return false
  // 插到「建议落点」之后（没有就插到下一个空行前）
  let j = i + 1
  let last = i + 1
  while (j < lines.length && !/^## /.test(lines[j])) {
    if (lines[j].startsWith('- ')) last = j
    j += 1
  }
  const label = status === 'accepted' ? notePrefix.accepted : `✗ ${reason}`
  lines.splice(last + 1, 0, `- 审：${label} — ${note}（${by === 'human' ? '人工' : '自动'}，${new Date().toISOString().slice(0, 16).replace('T', ' ')}）`)
  fs.writeFileSync(p, lines.join('\n'), 'utf8')
  return true
}

const files = fs.existsSync(OUTDIR)
  ? fs.readdirSync(OUTDIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()
  : []

const st = loadState()

if (valOf('--accept') || valOf('--reject')) {
  const id = valOf('--accept') || valOf('--reject')
  const status = valOf('--accept') ? 'accepted' : 'rejected'
  const note = valOf('--note') || '人工判定'
  const [file, rest] = [id.split('#')[0] + '.md', id.split('#')[1]]
  const [noStr, wantedDate] = [Number(rest.split('@')[0]), rest.split('@').slice(1).join('@')]
  const b = blocksOf(fs.readFileSync(path.join(OUTDIR, file), 'utf8')).find((x) => x.no === noStr && (!wantedDate || x.date === wantedDate))
  if (!b) {
    console.error('找不到候选项', id)
    process.exit(2)
  }
  writeMark(file, b, status, valOf('--reason') || '重复', note, 'human')
  st.items[id] = { status, reason: status === 'accepted' ? '人工采纳' : '人工否决', note, by: 'human', at: new Date().toISOString() }
  saveState(st)
  console.log(`${id} → ${status}: ${note}`)
  process.exit(0)
}

const rows = []
for (const f of files) {
  const md = fs.readFileSync(path.join(OUTDIR, f), 'utf8')
  for (const b of blocksOf(md)) {
    const t = triage(b)
    if (t.status === 'done') {
      st.items[`${f.slice(0, 10)}#${b.no}@${b.date}`] ||= { status: 'done', reason: '已有标记', note: '', by: 'human', at: null }
      continue
    }
    rows.push({ id: `${f.slice(0, 10)}#${b.no}@${b.date}`, b, ...t })
  }
}

if (has('--pending')) {
  const p = rows.filter((r) => r.status === 'pending')
  console.log(`待判断 ${p.length} 条（共 ${rows.length} 条新扫）`)
  for (const r of p) console.log(`- ${r.id} [${r.b.role}] ${r.b.quote.slice(0, 50)}\n  建议落点：${r.b.suggest}`)
  process.exit(0)
}

const apply = has('--apply')
for (const r of rows) {
  const tag = r.status === 'rejected' ? `✗ ${r.reason}` : r.status === 'pending' ? '… 待判' : '✅ 已采纳'
  console.log(`${tag.padEnd(6)} ${r.id} [${r.b.role}] ${r.b.quote.slice(0, 34)}｜${r.note}`)
  if (apply) {
    if (r.status === 'rejected') {
      writeMark(r.id.split('#')[0] + '.md', r.b, 'rejected', r.reason, r.note)
      st.items[r.id] = { status: 'rejected', reason: r.reason, note: r.note, by: 'auto', at: new Date().toISOString() }
    } else {
      st.items[r.id] = { status: 'pending', reason: '', note: r.note, by: 'auto', at: new Date().toISOString() }
    }
  }
}
if (apply) saveState(st)
const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {})
console.log(`\n共 ${rows.length} 条：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}${apply ? '（已写入）' : '（预演，--apply 才写）'}`)
