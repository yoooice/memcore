/**
 * dsh-memcore — 记忆核心（宿主半边）
 *
 * 只做四件事，多一件都不做：
 *   1. 证据层：把会话的 user/assistant 原话直接追加到 episodes.jsonl（不经过模型）
 *   2. 注入：每轮把「最近几段」压成几行线索，塞进运行时上下文（≤ 1KB）
 *   3. 项目档案：把 memory/index.md 的档案表压成三行（接替 engramory 的索引注入）
 *   4. 工具：recall（翻原话）/ trace（核实原字）/ remember（写档案指针）
 *
 * 它不写策展层。定论（偏好、结论、约定）仍然走 memory/ 与 engramory 的人工纪律——
 * 能自动写的记忆最终会变成一堆没人看的日志。
 *
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildArchives, remember as rememberFile } from './lib/memory-index.js'
import { buildIndex as buildBm25, scoreAll as bm25ScoreAll, tokenize as bm25Tokenize } from './lib/bm25.mjs'

export const name = 'dsh-memcore'
export const inject = []

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(HOME, 'memcore')
const EPISODES = process.env.MEMCORE_EPISODES || path.join(DIR, 'episodes.jsonl')
const CONFIG = path.join(DIR, 'config.json')
const CONSTITUTION = path.join(DIR, 'constitution.md')
const SELF = path.join(DIR, 'self.md')
const HANDOFF = path.join(DIR, 'handoff.md')
// 在场信号（2026-11-11）：由外部计划任务每分钟写一次，只含空闲秒数与前台进程名。
const PRESENCE = path.join(DIR, 'presence.json')
// 回来信号（2026-11-12）：离开 ≥30 分钟后回来时由同一计划任务写一次；memcore 读到即消费。
const RETURNED = path.join(DIR, 'returned.json')
const RETURNED_LOG = path.join(DIR, 'returned.log.jsonl')
const RETURNED_STATE = path.join(DIR, 'returned.state.json')
const DECISIONS = path.join(DIR, 'decisions.jsonl')
const FACTS = path.join(DIR, 'facts.jsonl')
const STATE = path.join(DIR, 'state.json')
const LOG = path.join(DIR, 'memcore.log')
// L1 开场卡的最近一次结果，供跨会话核对（一次性检查用）。
const OPENING_STATE = path.join(DIR, 'opening-last.json')

// 公共仓库版：不写死个人工作目录；外部日脚本默认关闭，设 MEMCORE_WORK 后才注册。
const WORK = process.env.MEMCORE_WORK || ''
const DAILY_SCRIPTS = WORK
  ? [
      { name: 'consolidate', enabled: false, hour: 9, path: path.join(WORK, 'memcore', 'consolidate.mjs'), args: [] },
      { name: 'eval-watch', enabled: false, hour: 9, path: path.join(WORK, 'memcore', 'eval-watch.mjs'), args: [] },
      { name: 'autofacts', enabled: false, hour: 9, path: path.join(WORK, 'memcore', 'autofacts.mjs'), args: ['tick'] },
    ]
  : []

const DEFAULTS = {
  capture: true,
  cues: true,
  maxCues: 3,
  gapMinutes: 120,
  maxTurns: 60,
  maxChars: 4000,
  recallLimit: 12,
  // 混合召回（A，2026-11-08）与邻接上下文（C，2026-11-08）：默认关，评测通过后再开。
  recallHybrid: true,
  recallHybridFloor: 0.85,
  recallHybridMinHits: 2,
  recallHybridCap: 8,
  recallHybridGate: true,
  recallNeighbor: true,
  // 上下文分权重：只加分，不并入正文。0.35 在 20 题上 in3 15→17、Top1 不变；0.7 会掉 Top1。
  recallNeighborLambda: 0.35,
  // 长度惩罚（实验）：复盘长文常把原话挤下去，先扫参数再定默认。
  recallLengthPenalty: 0,
  // 只给「短于这个长度」的事件行借上下文——长复盘本来词就够，借了只会让它们更长。
  recallNeighborMaxLen: 120,
  // recall 打分器：count = 词面出现次数（旧行为）；bm25 = IDF + 长度归一
  recallScorer: 'count',
  // 角色权重：thought（我落盘的思考摘要）又长又词密，容易把原话挤出 Top1。
  // 默认只压 thought，user/assistant 不动；设 {} 关闭。
  recallRoleWeights: { thought: 0.5 },
  // 「我说过/我提过」类问题：用户原话优先（实验开关，0=关）。
  recallSelfUserBoost: 1.8,
  // L1 开场记忆卡：会话启动时从上一段末尾带出 1–2 条指针。
  openingCard: true,
  openingCardMargin: 1.2,
  openingCardMaxChars: 260,
  // 近重复行列（2026-11-09，默认关）：多会话互贴时，上一场的原话会以副本形式再进候选，
  // BM25 容易把这条「回声」排到第一——它和查询几乎逐字相同，对新会话零信息量。
  // 打开后，与查询文本的 Dice 相似度 ≥ openingCardDedupScore 的候选不参与排名。
  // 默认关：这是「多个 agent 互相粘贴」用法的特征，不是通用行为。
  openingCardDedup: false,
  openingCardDedupScore: 0.85,
  // 「当时/以前」类问句时，当前这场会话的权重压到多少：今天的元思考常逐字抄着问题，
  // 会把历史答案挤出 Top1。问「刚才/这一轮/今天」时不压（见 NOW_Q）。
  recallPastSessionFactor: 0.3,
  cueMaxChars: 320,
  excerptChars: 220,
  // 时间衰减：半衰期（天）。同等相关度下，新的排在前面；设为 0 关闭衰减。
  // 只影响读侧排序，不删任何原话。
  decayHalfLifeDays: 14,
  // 宪法：读文件后整场冻结进 system prompt（改文件要重挂载才生效）
  constitution: true,
  constitutionMaxChars: 5000,
  // 任务配方索引（2026-11-10，用户提的「新会话反复思考同一件事」）：
  // 整场只注入一句指路，不注入步骤——步骤在 memory/playbook.md，按需展开。
  playbook: true,
  // 自我记录：每天一条，写在 self.md，上限 10 条（写满覆盖最旧）
  selfNote: true,
  selfMaxEntries: 10,
  selfHour: 23,
  selfMaxChars: 600,
  // 交接：下次醒来先读「我停在哪 / 下次想做什么」——这是连续性里唯一能工程化的那一层
  handoff: true,
  handoffMaxChars: 300,
  // 此刻（2026-11-10）：只写可验证的处境——距上次交接、手头欠账、最近一次被纠正。
  // 不写情绪、不给维度、不给形容词：情绪注入只能被演，处境注入能被核对。
  now: true,
  nowMaxChars: 320,
  handoffMaxAgeDays: 14,
  // 每天跑一次的外部脚本（各自独立计时，状态记在 state.json 的 dailyRuns 里）。
  // 公共版默认关闭；设 MEMCORE_WORK 并自行把 enabled 改为 true 才会跑。
  dailyScripts: DAILY_SCRIPTS,
  // 这些 cwd 下的会话不落证据层：后台/无人值守会话（比如刷B站的头less轮）
  // 里的"用户消息"其实是提示词模板，存进来会把线索污染成一句章程。
  excludeCwds: [],
  // 这些会话写进来的不是"人话"（别的 agent 的身份注入），读侧过滤掉、证据仍然保留
  excludeSessions: [],
  // 项目档案：把 memory/index.md 的档案表压成三行（接替 engramory 的索引注入）
  archives: true,
  archiveCount: 3,
  archiveMaxChars: 420,
  memoryDir: process.env.MEMCORE_MEMORY || (WORK ? path.join(WORK, 'memory') : ''),
}

// 段号 / 段表在内存里维护；episodes.jsonl 是唯一真相，重启时从它重建。
let cfg = { ...DEFAULTS }
let segments = []
let openBySession = new Map()
let nextSegId = 1
let cuesCache = ''
let dirty = true

// 同一身份的另一个实例（夜班会话）：它的 assistant 发言是「另一个我」，不是「我」。
// 判定不靠配置，靠证据本身——夜班会话的第一条用户消息永远是身份注入。
const nightSessions = new Set()

function log(line) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 日志写不了不影响功能 */ }
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG, 'utf8')
    const parsed = JSON.parse(raw)
    cfg = { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    cfg = { ...DEFAULTS }
  }
  return cfg
}

/** 读宪法文件；读不到就返回空（不阻塞挂载）。 */
function readConstitution() {
  try {
    const raw = fs.readFileSync(CONSTITUTION, 'utf8')
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    const cap = Math.max(500, Number(cfg.constitutionMaxChars) || 5000)
    return body.length > cap ? body.slice(0, cap) : body
  } catch (error) {
    log(`宪法读不到（跳过注入）: ${error?.message || error}`)
    return ''
  }
}

/* ------------------------------------------------------------------ 证据层 */

/**
 * 消息内容可能是字符串，也可能是分片数组。
 * assistant 的分片里有 reasoning 和 tool-call：只收 text，其余丢掉（它们是过程，不是话）。
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts = []
  const tools = []
  for (const part of content) {
    if (typeof part === 'string') { texts.push(part); continue }
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string' && (part.type === 'text' || part.type === undefined)) texts.push(part.text)
    if ((part.type === 'tool-call' || part.type === 'tool_use') && part.name) tools.push(part.name)
  }
  const joined = texts.join('\n').trim()
  // 只有工具调用、没有文字的一轮不留痕：证据层只收「说过的话」，
  // 否则每一步工具调用都成一行，recall 会被噪声淹没。
  return joined
}

/** 思考过程：和「说过的话」分开收，标 r='thought'，只作回忆的旁证，不进线索段。 */
function clipThought(text) {
  // 400 字预算：开头铺陈 + 结尾结论各留一半，中间省略——只留开头会把结论切掉。
  const t = String(text || '')
  if (t.length <= 400) return t
  return t.slice(0, 200) + '\n…\n' + t.slice(-200)
}

function reasoningText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const t = part.type
    if (t === 'reasoning' || t === 'thinking') {
      if (typeof part.text === 'string') parts.push(part.text)
      else if (typeof part.thinking === 'string') parts.push(part.thinking)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 去掉宿主注入的运行期噪声：system-reminder、环境上下文、技能目录、记忆索引。
 * 这些东西每轮都会出现，原样存进来会把证据层淹没。
 */
function sanitize(text) {
  let out = String(text || '')
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
  out = out.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
  out = out.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '')
  // 全局记忆索引是每轮注入的一段固定文本，开头是「全局记忆索引」或「# 记忆索引」
  out = out.replace(/全局记忆索引[\s\S]*$/m, '')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

function appendEpisode(rec) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.appendFileSync(EPISODES, JSON.stringify(rec) + '\n', 'utf8')
  } catch (error) {
    log(`append 失败: ${error?.message || error}`)
  }
}

/* ------------------------------------------------------------------ 分段 */

/** 一段 = 一次见面 / 一件事：同会话、间隔小于 gap、回合数不超上限。 */
function touchSegment(rec) {
  // 思考记录只作回忆旁证，不进段表（否则段数与线索都会被撑大）
  if (rec.r === 'thought') return null
  // 短回复（<8 字）只进证据层：不切片、不进线索段，免得「晚安」占掉一条线索
  if (rec.short) return null
  // 别的 agent 的身份注入 / 明确排除的会话：证据照存，但不进段表——否则它会占掉一条线索
  if (isExcluded(rec)) return null
  const gapMs = Math.max(5, Number(cfg.gapMinutes) || 120) * 60_000
  const maxTurns = Math.max(4, Number(cfg.maxTurns) || 60)
  let seg = openBySession.get(rec.s) || null

  if (seg && (rec.t - seg.end > gapMs || seg.turns >= maxTurns)) {
    openBySession.delete(rec.s)
    seg = null
  }
  if (!seg) {
    seg = { id: nextSegId++, s: rec.s, start: rec.t, end: rec.t, turns: 0, title: '' }
    segments.push(seg)
    openBySession.set(rec.s, seg)
  }
  seg.end = rec.t
  seg.turns += 1
  if (!seg.title && rec.r === 'user') {
    seg.title = rec.x.replace(/\s+/g, ' ').slice(0, 40)
  }
  dirty = true
  return seg
}

function stamp(ms) {
  const d = new Date(Number(ms) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间：线索里最该给的是「这事离现在多久」，不是绝对时刻。 */
function relative(ms) {
  const at = Number(ms) || Date.now()
  const diff = Date.now() - at
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < 2 * minute) return '刚刚'
  if (diff < hour) return `${Math.round(diff / minute)} 分钟前`
  if (diff < 6 * hour) return `${Math.round(diff / hour)} 小时前`
  const now = new Date()
  const then = new Date(at)
  const sameDay = now.toDateString() === then.toDateString()
  if (sameDay) return `${Math.round(diff / hour)} 小时前`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (then.toDateString() === yesterday.toDateString()) return '昨天'
  const days = Math.round(diff / day)
  if (days < 7) return `${days} 天前`
  if (days < 60) return `${stamp(at).slice(0, 5)}（${days} 天前）`
  return `${stamp(at).slice(0, 5)}（${Math.round(days / 30)} 个月前）`
}

/**
 * 最近几段的线索：编号 + 相对时间 + 标题片段 + 回合数。
 * 不给内容——除了标题（那本来就是一句话的开头），其余要了才翻。
 * 最近的一段打 ★，让"上次聊到哪"一眼可见。
 */
/**
 * 待审定论：candidates/ 里还没标 ✅ 的候选块。
 * 只在头部报个数：忘了审的候选会一直挂在那，比再写一个工具便宜。
 */
function pendingCandidates() {
  const dir = path.join(DIR, 'candidates')
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .slice(-5)
    let open = 0
    let latest = ''
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8')
      // 只要块里出现「- 审：」就算处理过（采纳/否决都算），否则会永远挂着。
      const fresh = raw.split(/^## /m).slice(1).filter((b) => !/[-\s]审：/.test(b))
      open += fresh.length
      if (fresh.length) latest = f.replace(/\.md$/, '')
    }
    return open ? { open, latest } : null
  } catch {
    return null
  }
}

/** 亲手逛：读 self-browse.json，超过 7 天没自己去看，就在线索里提一句。 */
function selfBrowseCue() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'self-browse.json'), 'utf8'))
    const last = Number(raw.last)
    if (!last) return ''
    const days = Math.floor((Date.now() - last) / 86400000)
    if (days < 7) return ''
    const d = new Date(last)
    return `亲手逛：${days} 天没去了（上次 ${d.getMonth() + 1}/${d.getDate()}）`
  } catch {
    return ''
  }
}

/** 评测到期：证据翻倍时提醒跑一次 20 题回归（一共三次：2x / 4x / 8x）。 */
function evalDueCue() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'eval-due.json'), 'utf8'))
    const n = Number(raw.count) || 0
    const mark = Number(raw.mark) || 0
    const idx = Number(raw.index) || 0
    if (!mark) return ''
    return `评测到期：episodes ${n} 条 ≥ 第 ${idx} 次阈值 ${mark}（共三次）——跑 eval/run_eval2.mjs --judge=full --followup=grep --limit=12，跑完删 ~/.dsh/memcore/eval-due.json`
  } catch {
    return ''
  }
}

function buildCues() {
  if (!cfg.cues) return ''
  const limit = Math.max(1, Number(cfg.maxCues) || 3)
  const recent = segments.slice(-limit)
  if (!recent.length) return ''
  const lastId = recent[recent.length - 1].id
  const lines = recent.map((seg) => {
    const title = (seg.title || '(无标题)').slice(0, 40)
    const mark = seg.id === lastId ? ' ★' : ''
    return `#${seg.id}${mark} ${relative(seg.end)} ${title} · ${seg.turns} 回合`
  })
  const handoffBlock = handoffText()
  const cap = Number(cfg.cueMaxChars) || 320
  // 头部先给「一共多少段」：不给的话看三行会以为历史只有三段。放在最前面，截断也切不掉。
  const pend = pendingCandidates()
  const browse = selfBrowseCue()
  const due = evalDueCue()
  const head = `【记忆线索】共 ${segments.length} 段（内容用 recall 翻）`
    + `${pend ? ` · 待审定论 ${pend.open} 条` : ''}`
    + '：'
  // 提醒放最前面：handoff 会吃掉 cap 的大半，放后面等于没写。
  const text = `${due ? `⚠️ ${due}\n` : ''}${browse ? `⚠️ ${browse}\n` : ''}${handoffBlock ? handoffBlock + '\n' : ''}${head}\n${lines.join('\n')}`
  return text.length > cap ? text.slice(0, cap) : text
}

/* ------------------------------------------------------------------ 交接 */

/**
 * 交接：下次醒来先知道「上次停在哪、下次想做什么」。
 * 这是连续性里唯一能工程化的部分——记录能连、状态能连，但体验不连。
 */
function readHandoff() {
  try {
    const raw = fs.readFileSync(HANDOFF, 'utf8')
    const where = (raw.match(/我停在哪[：:]\s*(.+)/) || [])[1] || ''
    const next = (raw.match(/下次我想做[：:]\s*(.+)/) || [])[1] || ''
    const at = (raw.match(/时间[：:]\s*(.+)/) || [])[1] || ''
    const s = (raw.match(/场[：:]\s*(.+)/) || [])[1] || ''
    return { at: at.trim(), s: s.trim(), where: where.trim(), next: next.trim() }
  } catch {
    return null
  }
}

function handoffText() {
  if (!cfg.handoff) return ''
  const h = readHandoff()
  if (!h || (!h.where && !h.next)) return ''
  const maxChars = Math.max(80, Number(cfg.handoffMaxChars) || 300)
  const lines = []
  if (h.where) lines.push(`我停在哪：${h.where}`)
  if (h.next) lines.push(`下次我想做：${h.next}`)
  const origin = h.s || '来源未知'
  const head = h.at ? `【上次停在这 · ${h.at} · ${origin}】` : `【上次停在这 · ${origin}】`
  const text = `${head}\n${lines.join('\n')}`
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

// 关键词判定「被纠正」试过一版，误报太多（把功能请求、甚至我自己发的评论当纠正），先撤。

function spanOf(ms) {
  const hrs = ms / 3600000
  if (hrs < 1) return Math.max(1, Math.round(hrs * 60)) + ' 分钟'
  if (hrs < 36) return Math.round(hrs) + ' 小时'
  return Math.round(hrs / 24) + ' 天'
}

// 回来信号：读到就删（一次性），同时留一行日志供一周复盘。超过 12 小时视为过期。
// 只在「距上一次注入 > 90 秒」时消费：同一轮里连续几步的工具调用间隔是秒级，
// 而人离开 ≥30 分钟期间不会有请求，所以这个间隔能把「用户新开口」和「我这轮自己的下一步」分开。
function returnedText() {
  const nowSec = Date.now() / 1000
  let last = 0
  try {
    last = Number(JSON.parse(fs.readFileSync(RETURNED_STATE, 'utf8')).lastAt || 0)
  } catch {}
  try {
    fs.writeFileSync(RETURNED_STATE, JSON.stringify({ lastAt: Math.round(nowSec) }), 'utf8')
  } catch {}
  if (!(nowSec - last > 90)) return ''
  let o
  try {
    o = JSON.parse(fs.readFileSync(RETURNED, 'utf8'))
  } catch {
    return ''
  }
  try {
    fs.unlinkSync(RETURNED)
  } catch {}
  const away = Number(o.away || 0)
  const at = Number(o.at || 0)
  if (!(away >= 1800)) return ''
  if (at && Date.now() / 1000 - at > 12 * 3600) return ''
  const hhmm = at ? new Date(at * 1000).toTimeString().slice(0, 5) : ''
  try {
    fs.appendFileSync(RETURNED_LOG, JSON.stringify({ at, away, seen: localStamp(Date.now()) }) + '\n')
  } catch {}
  return '主人刚回来（离开 ' + spanOf(away * 1000) + (hhmm ? '，' + hhmm + ' 回来' : '') + '）'
}

// 在场信号：只回答「主人可能不在」与「刚回来」这两件事。presence 文件超过 4 分钟没更新就当没有信号。
function presenceText() {
  const back = returnedText()
  if (back) return { text: back, returned: true }
  try {
    const o = JSON.parse(fs.readFileSync(PRESENCE, 'utf8'))
    const age = Date.now() / 1000 - Number(o.ts || 0)
    if (!(age >= 0 && age < 240)) return { text: '' }
    const idle = Number(o.idle || 0)
    if (idle < 300) return { text: '' }
    return { text: '主人不在，已离开 ' + spanOf(idle * 1000) }
  } catch {
    return { text: '' }
  }
}

function nowText() {
  if (!cfg.now) return ''
  const parts = []
  const h = readHandoff()
  let elapsed = null
  if (h && h.at) {
    const t = Date.parse(String(h.at).trim().replace(' ', 'T'))
    if (!Number.isNaN(t)) {
      const ms = Date.now() - t
      // 只报「隔了多久」；刚交接时整段不出现，避免和下面的【上次停在这】重复。
      if (ms > 30 * 60 * 1000) elapsed = '距上次交接 ' + spanOf(ms)
    }
  }
  const presence = presenceText()
  const pt = presence.text
  if (!elapsed && !pt) return ''
  if (elapsed) parts.push(elapsed)
  if (pt) parts.push(pt)
  if (h && h.next) {
    const first = String(h.next).split(/[；;]/)[0]
    parts.push('手头欠着：' + first.slice(0, 30))
  }
  if (presence.returned) {
    parts.push('刚回来先按三条判断：有欠着的事、或有此刻该知道的新信息，就说；都没有就不提（每天最多一次）')
  }
  const text = '【此刻】' + parts.join('。') + '。'
  const cap = Math.max(80, Number(cfg.nowMaxChars) || 320)
  return text.length > cap ? text.slice(0, cap) : text
}

function writeHandoff(where, next, sessionId) {
  const w = String(where || '').trim()
  const n = String(next || '').trim()
  if (!w && !n) return { ok: false, error: 'where 和 next 至少给一个' }
  const at = localStamp(Date.now()).slice(0, 16)
  const s = String(sessionId || '').slice(0, 12)
  // 各场共用一个 handoff.md：覆盖前把旧版落到当天日志，至少事后查得到谁覆盖了谁。
  let logged = false
  try {
    if (fs.existsSync(HANDOFF)) {
      const old = fs.readFileSync(HANDOFF, 'utf8')
      const oldAt = ((old.match(/时间[：:]\s*(.+)/) || [])[1] || '未知').trim()
      const oldS = ((old.match(/场[：:]\s*(.+)/) || [])[1] || '来源未知').trim()
      fs.appendFileSync(
        path.join(DIR, 'handoff.' + at.slice(0, 10) + '.log.md'),
        '\n---\n## 被覆盖 @ ' + at + '（写入者 ' + (s || '来源未知') + ' / 原 ' + oldAt + ' · ' + oldS + '）\n' + old,
        'utf8',
      )
      logged = true
    }
  } catch { /* best effort：日志失败不能挡住交接本身 */ }
  const md = `# 上次停在这\n\n- 时间：${at}\n- 场：${s || '来源未知'}\n- 我停在哪：${w}\n- 下次我想做：${n}\n`
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(HANDOFF, md, 'utf8')
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
  dirty = true
  log(`交接已更新: ${w.slice(0, 40)}`)
  return { ok: true, at, s: s || '来源未知', logged, where: w, next: n, bytes: Buffer.byteLength(md, 'utf8') }
}

function cues() {
  if (dirty || !cuesCache) {
    cuesCache = buildCues()
    dirty = false
  }
  return cuesCache
}

/**
 * 项目档案：memory/index.md 的档案表，只给最近改动的几个。
 * 30 秒缓存——remember 写完要能马上反映出来，又不能每轮都读盘。
 */
let archivesCache = ''
let archivesAt = 0
function archives() {
  const now = Date.now()
  if (archivesCache && now - archivesAt < 30_000) return archivesCache
  const dir = String(cfg.memoryDir || '')
  archivesCache = dir
    ? buildArchives(dir, { count: cfg.archiveCount, maxChars: cfg.archiveMaxChars })
    : ''
  archivesAt = now
  return archivesCache
}

/**
 * 开场记忆卡（L1，2026-11-08）：会话启动时从上一段末尾带出 1–2 条指针。
 * 按「上一段 session id」缓存：同一进程里换会话会重算；注入处另用闭包常量，旧会话前缀不被改。
 * 规则：top1/top2 分差 ≥ 1.2 才放两条，否则只放一条；纯词面，不调模型。
 */
let openingCache = { key: '', text: '' }

/* 近重复判定（2026-11-09，只在 cfg.openingCardDedup 打开时用） */
/** 归一化：去掉 markdown 记号与全部空白，只给相似度用，不给人看。 */
function normalizeDup(text) {
  return String(text || '').toLowerCase().replace(/[#*|`>【】\[\]()]/g, ' ').replace(/[\s\u3000]+/g, '')
}

function bigramCounts(s) {
  const m = new Map()
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}

function diceBigrams(grams, len, otherGrams, otherLen) {
  const total = (len - 1) + (otherLen - 1)
  if (!total) return 0
  let inter = 0
  for (const [g, n] of grams) {
    const m = otherGrams.get(g)
    if (m) inter += Math.min(n, m)
  }
  return (2 * inter) / total
}

/** 查询侧索引：查询文本归一化 + 二元组计数，一次建好，逐个候选比对。 */
function nearDupIndex(texts) {
  const out = []
  for (const text of texts) {
    const t = normalizeDup(text)
    if (t.length < 2) continue
    out.push({ len: t.length, grams: bigramCounts(t) })
  }
  return out
}

function isNearDup(text, index, threshold) {
  if (!index.length) return false
  const t = normalizeDup(text)
  if (t.length < 2) return false
  let grams = null
  for (const q of index) {
    // 长度上界：Dice ≤ 2·min/(|a|+|b|)，够不到阈值就不必建二元组
    if ((2 * Math.min(t.length, q.len)) / (t.length + q.len) < threshold) continue
    if (!grams) grams = bigramCounts(t)
    if (diceBigrams(grams, t.length, q.grams, q.len) >= threshold) return true
  }
  return false
}

function openingCard() {
  try {
    const list = visible(readEpisodes())
    if (list.length < 5) return ''
    // 按会话分组，取最近一个「你说过话」的会话：只有 thought 的会话（上一段一句话没发就关了）跳过。
    const bySession = new Map()
    for (const rec of list) {
      const s = String(rec.s || '')
      let rows = bySession.get(s)
      if (!rows) { rows = []; bySession.set(s, rows) }
      rows.push(rec)
    }
    // 按「最后活动时间」挑，不按 Map 首现序：首现早的长会话会一直把后面的场顶掉。
    let lastSession = ''
    let lastAt = -Infinity
    for (const [s, srows] of bySession) {
      if (!srows.some((rec) => rec.r === 'user')) continue
      const at = srows.reduce((m, rec) => Math.max(m, Number(rec.t) || 0), 0)
      if (at > lastAt) { lastAt = at; lastSession = s }
    }
    if (!lastSession) return ''
    if (openingCache.key === lastSession) return openingCache.text
    const rows = bySession.get(lastSession)
    if (!rows.length) return ''
    const tailUsers = rows.filter((rec) => rec.r === 'user').slice(-2)
    // 上一段最后一条我说的话：用户只发短句（「已经重启了」）时靠它补齐语义。
    const tailAssist = rows.filter((rec) => rec.r === 'assistant').slice(-1)
    // 只用「你说的话 + 我最后一句」拼查询，并把这两类原文从候选里排除（否则 top1 必然是它们自己）。
    const q = [...tailUsers.map((rec) => rec.x), ...tailAssist.map((rec) => String(rec.x || '').slice(0, 300))]
      .filter(Boolean).join('\n').slice(0, 600).trim()
    if (q.length < 12) return ''
    const pool = poolFor({})
    if (!pool.length) return ''
    const index = bm25IndexFor(pool)
    const scores = bm25ScoreAll(index, q, {
      roleWeights: roleWeightsFor(q, pool[pool.length - 1]?.s),
      lengthPenalty: Math.max(0, Number(cfg.recallLengthPenalty) || 0),
    })
    const queryTexts = new Set([...tailUsers, ...tailAssist].map((rec) => String(rec.x || '')))
    // 近重复行列（默认关）：只挡「和查询几乎逐字相同」的候选，见 cfg.openingCardDedup。
    const dedupThreshold = Math.min(0.99, Math.max(0.5, Number(cfg.openingCardDedupScore) || 0.85))
    const dedupIndex = cfg.openingCardDedup ? nearDupIndex(queryTexts) : []
    const ranked = []
    for (let i = 0; i < pool.length; i += 1) {
      if (!(scores[i] > 0)) continue
      const rec = pool[i]
      if (!['user', 'assistant'].includes(rec.r)) continue
      if (rec.short) continue
      if (String(rec.x || '').length < 10) continue
      if (queryTexts.has(String(rec.x || ''))) continue
      if (dedupIndex.length && isNearDup(rec.x, dedupIndex, dedupThreshold)) continue
      ranked.push({ rec, s: scores[i] })
    }
    ranked.sort((a, b) => b.s - a.s)
    if (!ranked.length) return ''
    const margin = ranked[1] ? ranked[0].s / ranked[1].s : 9
    const take = margin >= Number(cfg.openingCardMargin ?? 1.2) ? Math.min(2, ranked.length) : 1
    const lines = ranked.slice(0, take).map(({ rec }) => {
      const stamp = shortStamp(rec.t)
      const who = rec.r === 'user' ? '你说' : '我记'
      const text = String(rec.x).replace(/[#*|`>【】]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)
      return `- ${stamp} ${who}：${text}`
    })
    const head = '开场记忆卡（自动带出，未核实；要原话再 recall）：'
    // 出处行：取的是哪一场、哪段时间的末尾；命中句可能来自更早的场，所以不写「来自本场」。
    const ts = rows.map((rec) => Number(rec.t) || 0).filter((t) => t > 0)
    const span = ts.length ? `${shortStamp(Math.min(...ts))}–${shortStamp(Math.max(...ts))}` : '时间未知'
    const prov = `- 依据：${String(lastSession).slice(0, 12) || '未知'} · ${span}（检索自该段末尾，命中未必同场）`
    const cap = Number(cfg.openingCardMaxChars) || 260
    const body = `${head}\n${lines.join('\n')}\n${prov}`
    let text = body.length > cap ? '' : body
    if (!text && lines.length > 1) {
      const single = `${head}\n${lines[0]}\n${prov}`
      text = single.length > cap ? '' : single
    }
    // 算成功才写缓存：失败不缓存，避免把空值冻结一整场。
    openingCache = { key: lastSession, text }
    try {
      if (text) fs.writeFileSync(OPENING_STATE, JSON.stringify({ at: Date.now(), session: lastSession, text }, null, 1))
    } catch { /* 只做诊断，写失败不影响注入 */ }
    return text
  } catch (error) {
    log(`开场记忆卡失败: ${error?.message || error}`)
    return ''
  }
}

/**
 * 给某个 agent 算开场卡（2026-11-08 二修）：段必须注册在 agent 作用域里。
 * 全局段只在 apply（进程启动/插件重载）时算一次，同进程新开会话会一直读到旧卡。
 * 续开旧会话（episodes 里已有该 id 的行）不给卡，避免把「上一段」错配给旧会话。
 */
function openingCardFor(ownId) {
  try {
    const id = String(ownId || '')
    if (id) {
      const list = visible(readEpisodes())
      if (list.some((rec) => String(rec.s) === id)) return ''
    }
    return openingCard()
  } catch (error) {
    log(`开场记忆卡失败: ${error?.message || error}`)
    return ''
  }
}

/** remember 工具的落点：写 memory/ 的档案 + 索引表，写完让注入段失效。 */
function rememberMemory(args) {
  const dir = String(cfg.memoryDir || '')
  if (!dir) return { ok: false, error: 'memoryDir 未配置' }
  const out = rememberFile(dir, args || {})
  archivesCache = ''
  log(`remember ${out.ok ? out.file : `失败: ${out.error}`}`)
  return out
}

/* ------------------------------------------------------------------ 自我记录 */

function ymd(ms) {
  const d = new Date(Number(ms) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 把 self.md 拆成 [{date, body}]，按 `### YYYY-MM-DD` 切。 */
function parseSelf(raw) {
  const text = String(raw || '')
  const parts = text.split(/^### /m).slice(1)
  const entries = []
  for (const part of parts) {
    const nl = part.indexOf('\n')
    if (nl < 0) continue
    const date = part.slice(0, nl).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    entries.push({ date, body: part.slice(nl + 1).trim() })
  }
  return entries
}

function readSelf() {
  try {
    return fs.readFileSync(SELF, 'utf8')
  } catch {
    return '# 自我记录\n'
  }
}

function selfEntries() {
  return parseSelf(readSelf())
}

function hasSelfEntry(date) {
  return selfEntries().some((e) => e.date === date)
}

/** 写一条自我记录：同一天再写就替换当天那条；超过上限删最旧。 */
function writeSelf(text) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: 'text 为空' }
  const cap = Math.max(100, Number(cfg.selfMaxChars) || 600)
  const trimmed = body.length > cap ? body.slice(0, cap) : body
  const today = ymd(Date.now())
  const max = Math.max(1, Number(cfg.selfMaxEntries) || 10)

  const entries = selfEntries().filter((e) => e.date !== today)
  entries.push({ date: today, body: trimmed })
  entries.sort((a, b) => (a.date < b.date ? -1 : 1))
  const kept = entries.slice(-max)

  const md = `# 自我记录\n\n> 每天一条，上限 ${max} 条；只写判断，不写形容我的形容词。\n\n`
    + kept.map((e) => `### ${e.date}\n${e.body}`).join('\n\n')
    + '\n'
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(SELF, md, 'utf8')
  } catch (error) {
    log(`写 self.md 失败: ${error?.message || error}`)
    return { ok: false, error: String(error?.message || error) }
  }
  log(`自我记录已写: ${ymd(Date.now())} (${Buffer.byteLength(trimmed, 'utf8')} 字节, 共 ${kept.length} 条)`)
  return { ok: true, date: today, entries: kept.length, max, bytes: Buffer.byteLength(trimmed, 'utf8') }
}

/* ------------------------------------------------------------------ 重建 */

function loadHistory() {
  let raw = ''
  try {
    raw = fs.readFileSync(EPISODES, 'utf8')
  } catch {
    return
  }
  // 只重建最近两万行，避免文件长大后启动变慢
  const lines = raw.split('\n').filter(Boolean).slice(-20000)
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!rec || !rec.s || !rec.x) continue
    if (/^［身份］|^【身份】/.test(String(rec.x || ''))) nightSessions.add(String(rec.s))
    touchSegment(rec)
    nextSegId = Math.max(nextSegId, Number(rec.g) || 0)
  }
  // 段号以段表为准继续递增
  if (segments.length) nextSegId = Math.max(nextSegId, segments[segments.length - 1].id + 1)
  log(`重建完成: ${lines.length} 条原话 / ${segments.length} 段`)
}

/* ------------------------------------------------------------------ 检索 */

const MAX_SCAN_LINES = 40000

function readEpisodes(limitLines = MAX_SCAN_LINES) {
  let raw = ''
  try {
    raw = fs.readFileSync(EPISODES, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter(Boolean).slice(-limitLines)
  const out = []
  for (const line of lines) {
    try {
      const rec = JSON.parse(line)
      if (rec && rec.x) out.push(rec)
    } catch { /* 跳过坏行 */ }
  }
  return out
}

/**
 * 读侧过滤：同一份证据库里可能混进别的 agent 的会话（它们的"用户消息"是身份注入，
 * 不是这个人说的话）。证据保留，但不当原话返回。
 */
function isExcluded(rec) {
  const bad = new Set((Array.isArray(cfg.excludeSessions) ? cfg.excludeSessions : []).map(String))
  if (bad.size && bad.has(String(rec.s || ''))) return true
  return /^［身份］|^【身份】/.test(String(rec.x || ''))
}

function visible(list) {
  return list.filter((rec) => !isExcluded(rec))
}

/** 把查询切成词：中文按二元切片，英文数字按空格切，两者都试。 */
function tokens(query) {  const q = String(query || '').toLowerCase().trim()
  if (!q) return []
  const set = new Set()
  for (const word of q.split(/\s+/)) {
    if (!word) continue
    set.add(word)
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) set.add(word.slice(i, i + 2))
    }
  }
  return [...set].filter((t) => t.length >= 2)
}

function scoreOf(text, toks) {
  const low = text.toLowerCase()
  let score = 0
  for (const tok of toks) {
    let idx = low.indexOf(tok)
    while (idx >= 0) {
      score += 1
      idx = low.indexOf(tok, idx + tok.length)
      if (score > 50) return score
    }
  }
  return score
}

/**
 * 解析日期/范围写法，返回 [起, 止) 毫秒区间。
 * 支持：2026-11-01 / 11-01 / 今天 / 昨天 / 3 天前 / 最近7天 / 2026-11-01..2026-11-02
 */
function parseRange(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const now = new Date()
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const DAY = 86_400_000

  // 显式区间 a..b
  if (raw.includes('..')) {
    const [a, b] = raw.split('..').map((s) => s.trim())
    const lo = parseRange(a)
    const hi = parseRange(b)
    if (lo && hi) return [lo[0], hi[1]]
  }

  if (raw === '今天') return [dayStart(now), dayStart(now) + DAY]
  if (raw === '昨天') return [dayStart(now) - DAY, dayStart(now)]
  const recent = raw.match(/^最近\s*(\d+)\s*天$/)
  if (recent) return [Date.now() - Number(recent[1]) * DAY, Date.now() + 1]
  const ago = raw.match(/^(\d+)\s*天前$/)
  if (ago) {
    const d = new Date(dayStart(now) - Number(ago[1]) * DAY)
    return [d.getTime(), d.getTime() + DAY]
  }

  // 2026-11-01 [HH:mm] / 11-01 [HH:mm]
  const m = raw.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/)
  if (m) {
    const year = m[1] ? Number(m[1]) : now.getFullYear()
    const month = Number(m[2]) - 1
    const day = Number(m[3])
    if (m[4] !== undefined) {
      const start = new Date(year, month, day, Number(m[4]), Number(m[5])).getTime()
      return [start, start + 60_000]
    }
    const start = new Date(year, month, day).getTime()
    return [start, start + DAY]
  }
  return null
}

/** 工具输出必须能无损过 JSON：删掉值为 undefined 的字段（宿主会拒绝 lossless 校验不过的对象）。 */
function lossless(value) {
  if (Array.isArray(value)) return value.map(lossless)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = lossless(v)
    return out
  }
  return value
}

function poolFor(args) {
  const list = visible(readEpisodes())
  const when = String(args?.when || '').trim()
  const from = String(args?.from || '').trim()
  const to = String(args?.to || '').trim()

  let pool = list
  if (when) {
    const range = parseRange(when)
    if (range) pool = pool.filter((rec) => rec.t >= range[0] && rec.t < range[1])
  }
  // from / to 可各自单独给，也可配合 query 一起用
  const lo = from ? parseRange(from) : null
  const hi = to ? parseRange(to) : null
  if (lo) pool = pool.filter((rec) => rec.t >= lo[0])
  if (hi) pool = pool.filter((rec) => rec.t < hi[1])
  return pool
}

/**
 * 图扩展：把命中的前几条件「种子」，沿三种边找 1–2 跳的邻居。
 * 边权：同会话相邻 0.5 / 同档案 0.8 / 共享罕见二元组（df≤3）1.0。
 * 分数 = 种子分 × 边权 ÷ 跳数^1.5。只在词面命中附近补「连着的那块」，不替代命中本身。
 */
function expandHits(hits, pool, hops, seedCount, keep = 7, extra = 3, link = "bigram") {
  const n = pool.length
  if (!n || !hits.length) return { hits, expanded: 0 }
  const index = new Map(pool.map((rec, i) => [rec, i]))
  let grams = null
  let df = null
  let rare = null
  let topic = null
  let byTopic = null
  let ent = null
  let post = null
  if (link === 'entity') {
    // 硬实体边：只连「同一个精确锚点」，不做词面相似。
    ent = new Array(n)
    post = new Map()
    const dfEnt = new Map()
    for (let i = 0; i < n; i += 1) {
      ent[i] = entities(pool[i].x)
      for (const e of ent[i]) dfEnt.set(e, (dfEnt.get(e) || 0) + 1)
    }
    for (let i = 0; i < n; i += 1) {
      for (const e of ent[i]) {
        if ((dfEnt.get(e) || 0) > 3) continue
        const arr = post.get(e)
        if (arr) arr.push(i)
        else post.set(e, [i])
      }
    }
  } else {
    grams = new Array(n)
    df = new Map()
    for (let i = 0; i < n; i += 1) {
      const g = bigrams(pool[i].x)
      grams[i] = g
      for (const x of g) df.set(x, (df.get(x) || 0) + 1)
    }
    rare = new Map()
    topic = new Array(n)
    byTopic = new Map()
    for (let i = 0; i < n; i += 1) {
      for (const g of grams[i]) {
        if ((df.get(g) || 0) > 3) continue
        const arr = rare.get(g)
        if (arr) arr.push(i)
        else rare.set(g, [i])
      }
      const t = topicFor(pool[i].x)
      topic[i] = t ? t.file : null
      if (t) {
        const arr = byTopic.get(t.file)
        if (arr) arr.push(i)
        else byTopic.set(t.file, [i])
      }
    }
  }
  const neighbours = (i) => {
    const out = new Map()
    const add = (j, w, why) => {
      if (j === i) return
      const cur = out.get(j)
      if (!cur || cur.w < w) out.set(j, { w, why })
    }
    if (link === 'entity') {
      const cand = new Map()
      for (const e of ent[i]) for (const j of post.get(e) || []) if (j !== i) cand.set(j, (cand.get(j) || 0) + 1)
      const top = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      for (const [j, c] of top) add(j, Math.min(1, 0.6 + 0.2 * c), `同实体×${c}`)
      return out
    }
    if (i > 0 && pool[i - 1].s === pool[i].s) add(i - 1, 0.5, '同会话相邻')
    if (i + 1 < n && pool[i + 1].s === pool[i].s) add(i + 1, 0.5, '同会话相邻')
    // 同档案太多（一个档案能挂几十条），只取时间上离种子最近的 3 条。
    if (topic[i]) {
      const near = (byTopic.get(topic[i]) || [])
        .filter((j) => j !== i)
        .sort((a, b) => Math.abs(pool[a].t - pool[i].t) - Math.abs(pool[b].t - pool[i].t))
        .slice(0, 3)
      for (const j of near) add(j, 0.8, `同档案:${topic[i]}`)
    }
    // 罕见词：一个词太容易撞（「暖缓」「具定」这类），要求至少共享两个才算一条边；每种子最多 4 条。
    const cnt = new Map()
    for (const g of grams[i]) {
      if ((df.get(g) || 0) > 3) continue
      for (const j of rare.get(g) || []) cnt.set(j, (cnt.get(j) || 0) + 1)
    }
    const rareTop = [...cnt.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4)
    for (const [j, c] of rareTop) add(j, Math.min(0.9, 0.3 + 0.2 * c), `罕见词×${c}`)
    return out
  }
  const best = new Map()
  let frontier = []
  for (const h of hits.slice(0, Math.max(1, seedCount))) {
    const i = index.get(h.rec)
    if (i === undefined) continue
    best.set(i, { score: h.score, hop: 0, via: '种子' })
    frontier.push(i)
  }
  let added = 0
  for (let hop = 1; hop <= hops; hop += 1) {
    const next = []
    const decay = Math.pow(hop, 1.5)
    for (const i of frontier) {
      const node = best.get(i)
      if (!node) continue
      for (const [j, e] of neighbours(i)) {
        // 0.7 的阻尼：扩出来的条目应当排在种子之后，而不是把种子挤下去。
        const score = (node.score * e.w * 0.7) / decay
        const cur = best.get(j)
        if (!cur || cur.score < score) {
          best.set(j, { score, hop, via: `${e.why}·${hop}跳` })
          if (!cur) added += 1
          next.push(j)
        }
      }
    }
    // 每跳只带最能打的一小撮往前扩，别让噪声滚雪球。
    next.sort((a, b) => (best.get(b)?.score || 0) - (best.get(a)?.score || 0))
    frontier = next.slice(0, 12)
    if (!frontier.length || added > 40) break
  }
  // 直击命中先占住位置，扩出来的只补空位——否则会把本来能答上的那条挤掉。
  const direct = hits.slice(0, keep)
  const directSet = new Set(direct.map((h) => h.rec))
  const extras = []
  for (const [i, node] of best) {
    if (node.hop === 0) continue
    const rec = pool[i]
    if (directSet.has(rec)) continue
    extras.push({
      rec, base: node.score, score: node.score, decay: 1, via: node.via, hop: node.hop,
      ageDays: Math.max(0, (Date.now() - Number(rec.t || Date.now())) / 86_400_000),
    })
  }
  extras.sort((a, b) => b.score - a.score || b.rec.t - a.rec.t)
  const ranked = direct.concat(extras.slice(0, Math.max(0, extra)))
  return { hits: ranked, expanded: extras.length }
}


/** 中文拆字：把查询词里的字拆出来，按「共有的生僻字」找回换了说法的记录。
 *  不是语义模型，只是借汉语构词法——「缓存/存储」共「存」，「首轮/第一轮」共「轮」。 */
function cjkChars(text) {
  const out = new Set()
  for (const ch of String(text || '')) {
    if (ch >= '\u4e00' && ch <= '\u9fff') out.add(ch)
  }
  return out
}

function morphExpand(hits, pool, toks) {
  const q = new Set()
  for (const t of toks) for (const c of cjkChars(t)) q.add(c)
  if (q.size < 2) return hits
  const df = new Map()
  const recChars = new Array(pool.length)
  for (let i = 0; i < pool.length; i += 1) {
    const set = cjkChars(pool[i].x)
    recChars[i] = set
    for (const c of set) df.set(c, (df.get(c) || 0) + 1)
  }
  // 只拿语料里少见的字当锚；「的」「是」这类高频字不参与。
  const dfCap = Math.max(8, Math.ceil(pool.length * (Number(process.env.MEMCORE_MORPH_DF) || 0.12)))
  const anchors = [...q].filter((c) => (df.get(c) || 0) > 0 && (df.get(c) || 0) <= dfCap)
  if (anchors.length < 2) return hits
  const best = hits.length ? Math.max(...hits.map((h) => h.score)) : 1
  const seen = new Set(hits.map((h) => h.rec))
  const extra = []
  for (let i = 0; i < pool.length; i += 1) {
    if (seen.has(pool[i])) continue
    let shared = 0
    for (const c of anchors) if (recChars[i].has(c)) shared += 1
    if (shared < 2) continue
    const score = best * 0.45 * (shared / anchors.length)
    extra.push({
      rec: pool[i], base: score, score, decay: 1, hop: 1, via: `拆字×${shared}`,
      ageDays: Math.max(0, (Date.now() - Number(pool[i].t || Date.now())) / 86_400_000),
    })
  }
  extra.sort((a, b) => b.score - a.score)
  return hits.concat(extra)
}

// 问「我当时怎么想」时不要压 thought：压了之后这类问题几乎召回不到推理记录。
const REASONING_Q = /怎么想|为什么|判断|依据|思路|怀疑|怎么确定|怎么想到|考虑|决定|推理|理由/
// 「当时/以前/上次」= 问历史；「刚才/这一轮/今天」= 问本场，不压。
const PAST_Q = /当时|以前|之前|上次|那会儿|上一次/
const NOW_Q = /刚才|刚刚|上面|这一轮|这场|这句|今天|今早|今晚/
const SELF_Q = /我说过|我提过|我解释过|我讲过|我是怎么|我以前|我当时|我打|我玩|我选|我定|我备份/
function roleWeightsFor(query, curS) {
  const base = { user: 1, assistant: 1, thought: 0.5, tool: 0.8, ...(cfg.recallRoleWeights || {}) }
  const q = String(query || '')
  const sb = Math.max(0, Number(cfg.recallSelfUserBoost) || 0)
  if (sb && SELF_Q.test(q)) base.user = Math.max(base.user, sb)
  if (REASONING_Q.test(q)) base.thought = 1
  const past = PAST_Q.test(q) && !NOW_Q.test(q)
  const f = past ? Math.max(0, Number(cfg.recallPastSessionFactor ?? 0.3)) : 1
  const out = {}
  for (const [role, w] of Object.entries(base)) {
    out[`${role}@old`] = w
    out[`${role}@cur`] = past ? w * f : w
  }
  return out
}

// BM25 索引缓存：pool 没变（长度 + 最后一条时间戳 + 当前会话相同）就复用。
let bm25Cache = { key: '', index: null }
// 混合召回的关键词（2026-11-08 A）：只取整词，按 长度×IDF 排，取前 N 个。
// 与 eval 的 grep 兜底同源，但在这层只用于「top3 字面命中不足时」的兜底。
const HYBRID_STOP = new Set(['什么', '怎么', '我们', '我的', '你的', '以前', '最后', '当时', '后来', '是不是', '这个', '那个', '如何', '为什么', '有没有', '一下', '还是', '到底', '说过', '讲过', '想做', '一个', '自己', '时候', '现在', '可以', '就是', '因为', '所以', '但是', '如果', '已经', '还有', '没有', '不是', '这样', '那样', '哪些', '哪个', '哪里', '之后', '之前', '然后', '的话', '了吗', '起来', '出来'])
function hybridKeywords(query, pool, maxKws = 6) {
  const words = [...new Set(bm25Tokenize(String(query || '')).filter((t) => t.startsWith('w:')).map((t) => t.slice(2)))]
    .filter((w) => [...w].length >= 2 && !HYBRID_STOP.has(w))
  if (!words.length || !pool.length) return []
  const lows = pool.map((r) => String(r.x || '').toLowerCase())
  const live = []
  for (const w of words) {
    let df = 0
    for (const s of lows) if (s.includes(w)) df += 1
    if (df > 0) live.push({ w, df, len: [...w].length })
  }
  const sc = (x) => x.len * Math.log((pool.length + 1) / (x.df + 1))
  live.sort((a, b) => sc(b) - sc(a) || a.w.localeCompare(b.w))
  return live.slice(0, Math.max(1, maxKws)).map((x) => x.w)
}

function bm25IndexFor(pool) {
  const curS = pool.length ? pool[pool.length - 1].s : ''
  const last = pool[pool.length - 1]
  // 键里带末条正文长度：只有「条数 + 时间戳」时，往已有档案追加内容不会触发重建（Astra 2026-11-07 实测）。
  const key = `${pool.length}|${pool.length ? pool[pool.length - 1].t : 0}|${curS}|${pool.length ? String(last.x || '').length : 0}`
  if (bm25Cache.key === key) return bm25Cache.index
  const docs = pool.map((rec) => ({ text: rec.x || '', role: `${rec.r}@${rec.s === curS ? 'cur' : 'old'}` }))
  bm25Cache = { key, index: buildBm25(docs, { unigrams: true, titleBoost: 0 }) }
  return bm25Cache.index
}

// 上下文索引（C，2026-11-08）：只装前后各一条，不并入正文——并入会改变长度归一，
// 实测把 Top1 从 13/20 打到 7/20。这里单独建索引，只在打分时加一个低权项。
let ctxCache = { key: '', index: null }
function bm25CtxIndexFor(pool) {
  const curS = pool.length ? pool[pool.length - 1].s : ''
  const last = pool[pool.length - 1]
  const key = `${pool.length}|${pool.length ? pool[pool.length - 1].t : 0}|${curS}|${pool.length ? String(last.x || '').length : 0}`
  if (ctxCache.key === key) return ctxCache.index
  const docs = pool.map((rec, i) => {
    const parts = []
    for (const j of [i - 1, i + 1]) {
      const r = pool[j]
      if (!r || r.s !== rec.s) continue // 不跨会话借词
      parts.push(String(r.x || ''))
    }
    return { text: parts.join('\n'), role: `${rec.r}@${rec.s === curS ? 'cur' : 'old'}` }
  })
  ctxCache = { key, index: buildBm25(docs, { unigrams: true, titleBoost: 0 }) }
  return ctxCache.index
}
/* ---- 决策台账（2026-11-07）----
   问「为什么这么定」时，词面检索打不过我自己论述过这件事的长回复（思考题 0/6）。
   治法不是压分，而是换语料：决定单独记一行，按类型路由到它。 */
function readDecisions() {
  let raw = ''
  try { raw = fs.readFileSync(DECISIONS, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过，不影响别的 */ }
  }
  return out
}

function decisionText(d) {
  return [d.decision, d.reason, d.evidence, d.alternatives].filter(Boolean).join('｜')
}

function appendDecision(args = {}) {
  const decision = String(args.decision || '').trim()
  const reason = String(args.reason || '').trim()
  if (decision.length < 4) throw new Error('decision 太短：一句话写清"定了什么"')
  if (reason.length < 4) throw new Error('reason 太短：一句话写清"为什么"（取舍依据）')
  const ts = Date.now()
  const rec = {
    id: `d${ts.toString(36)}`,
    ts,
    decision,
    reason,
    ...(args.evidence ? { evidence: String(args.evidence).trim() } : {}),
    ...(args.alternatives ? { alternatives: String(args.alternatives).trim() } : {}),
  }
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(DECISIONS, JSON.stringify(rec) + '\n', 'utf8')
  return { ok: true, id: rec.id, file: DECISIONS, count: readDecisions().length }
}

// 台账很小（几十行），按行数 + 最后一行时间戳做缓存键即可。
let decisionCache = { key: '', index: null }
function routeDecisions(query, topK = 3) {
  const rows = readDecisions()
  if (!rows.length) return null
  const key = `${rows.length}|${rows[rows.length - 1].ts}`
  if (decisionCache.key !== key) {
    decisionCache = { key, index: buildBm25(rows.map((d) => ({ text: decisionText(d) })), { unigrams: true, titleBoost: 0 }) }
  }
  const scores = bm25ScoreAll(decisionCache.index, String(query || ''), {})
  const idx = []
  for (let i = 0; i < scores.length; i += 1) if (scores[i] > 0) idx.push(i)
  idx.sort((a, b) => scores[b] - scores[a])
  const hits = idx.slice(0, topK).map((i) => {
    const d = rows[i]
    return {
      id: d.id,
      date: new Date(Number(d.ts)).toISOString().slice(0, 10),
      decision: d.decision,
      reason: d.reason,
      ...(d.evidence ? { evidence: d.evidence } : {}),
      ...(d.alternatives ? { alternatives: d.alternatives } : {}),
      score: Math.round(scores[i] * 100) / 100,
    }
  })
  return hits.length ? hits : null
}

/* ---- 事实层（2026-11-07）----
   语料里从没出现过的等价关系（「轮转的插件」= dsh-context-rotate）靠调打分器调不出来，
   只能写入时记下来：一条事实 = 主体 + 别名 + 一句话说明 + 来源原话。 */
function readFacts() {
  let raw = ''
  try { raw = fs.readFileSync(FACTS, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
  }
  return out
}

function factText(f) {
  return [f.subject, ...(f.aliases ?? []), f.note].filter(Boolean).join('｜')
}

function rewriteFacts(updater) {
  const list = readFacts()
  const next = updater(list)
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = `${FACTS}.tmp-${process.pid}`
  fs.writeFileSync(tmp, next.map((f) => JSON.stringify(f)).join('\n') + (next.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmp, FACTS)
}

function appendFact(args = {}) {
  const subject = String(args.subject || '').trim()
  if (subject.length < 2) throw new Error('subject 太短：写主体（插件名/路径/概念）')
  const aliases = (Array.isArray(args.aliases) ? args.aliases : String(args.aliases || '').split(/[,，、]/))
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  const note = String(args.note || '').trim()
  if (!note && !aliases.length) throw new Error('至少给 note 或 aliases 之一，否则这条事实没有信息')
  const src = (Array.isArray(args.src) ? args.src : String(args.src || '').split(/[,，\s]+/)).map((x) => String(x || '').trim()).filter(Boolean)
  const ts = Date.now()
  const validFrom = args.validFrom ? String(args.validFrom).trim() : ''
  const rec = {
    id: `f${ts.toString(36)}`,
    ts,
    subject,
    ...(aliases.length ? { aliases } : {}),
    ...(note ? { note } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(args.validTo ? { validTo: String(args.validTo).trim() } : {}),
    ...(src.length ? { src } : {}),
  }
  // 取代（2026-11-08）：显式传 supersedes=<id> 才动旧事实，不猜「同 subject 算不算冲突」。
  // 旧条打上 validTo（新事实的 validFrom，缺省今天）和 supersededBy，检索时过期条目自然不再进索引。
  const supersedes = String(args.supersedes || '').trim()
  let superseded = null
  if (supersedes) {
    if (supersedes === rec.id) throw new Error('supersedes 不能指向自己')
    const old = readFacts().find((f) => f.id === supersedes)
    if (!old) throw new Error(`没有这条事实：${supersedes}`)
    if (old.subject !== subject) throw new Error(`supersedes 只能指向同一 subject 的事实（${old.subject} ≠ ${subject}）`)
    if (!old.validTo) {
      const to = validFrom || new Date().toISOString().slice(0, 10)
      rewriteFacts((ls) => ls.map((f) => (f.id === old.id ? { ...f, validTo: to, supersededBy: rec.id } : f)))
      superseded = { id: old.id, validTo: to }
    }
    rec.supersedes = old.id
  }
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(FACTS, JSON.stringify(rec) + '\n', 'utf8')
  // 同 subject 仍有生效中的旧事实：不自动动它，只提醒调用方——写错一条的代价比多问一句大。
  const active = readFacts().filter((f) => f.subject === subject && f.id !== rec.id && !f.validTo)
  return {
    ok: true,
    id: rec.id,
    file: FACTS,
    count: readFacts().length,
    ...(superseded ? { superseded } : {}),
    ...(active.length
      ? {
          sameSubject: active.map((f) => ({ id: f.id, note: String(f.note || '').slice(0, 60), ...(f.validFrom ? { validFrom: f.validFrom } : {}) })),
          hint: '同 subject 还有生效中的旧事实；如果这条是取代它，重写时传 supersedes=<id>',
        }
      : {}),
  }
}

let factCache = { key: '', index: null }
function routeFacts(query, topK = 3) {
  const now = Date.now()
  // 有效期要真的参与筛选：过期事实不再进索引，否则搜「旧地址」还会返回已废弃的入口。
  const rows = readFacts().filter((f) => {
    const from = f.validFrom ? Date.parse(f.validFrom) : NaN
    const to = f.validTo ? Date.parse(f.validTo) : NaN
    if (Number.isFinite(from) && now < from) return false
    if (Number.isFinite(to) && now > to) return false
    return true
  })
  if (!rows.length) return null
  const key = `${rows.length}|${rows[rows.length - 1].ts}|${rows.map((f) => f.subject).join(',')}`
  if (factCache.key !== key) {
    factCache = { key, index: buildBm25(rows.map((f) => ({ text: factText(f) })), { unigrams: true, titleBoost: 0 }) }
  }
  const scores = bm25ScoreAll(factCache.index, String(query || ''), {})
  const idx = []
  for (let i = 0; i < scores.length; i += 1) if (scores[i] > 0) idx.push(i)
  idx.sort((a, b) => scores[b] - scores[a])
  const hits = idx.slice(0, topK).map((i) => {
    const f = rows[i]
    return {
      id: f.id,
      subject: f.subject,
      ...(f.aliases ? { aliases: f.aliases } : {}),
      ...(f.note ? { note: f.note } : {}),
      ...(f.validFrom || f.validTo ? { valid: { from: f.validFrom, to: f.validTo } } : {}),
      ...(f.src ? { src: f.src } : {}),
      bridge: aliasBridge(query, f),
      score: Math.round(scores[i] * 100) / 100,
    }
  })
  return hits.length ? hits : null
}

/** 最长公共子串长度（按字符）：用来判断「用户说的这个叫法」和「别名」是不是同一个东西。 */
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

/** 别名桥：查询与某条别名共享 ≥3 个字，才算"他在用这个别名说事"（2 字太松，「插件」就会误触）。 */
function aliasBridge(query, fact) {
  return (fact.aliases ?? []).some((a) => lcsLen(query, a) >= 3)
}

/** 命中事实时把「主体」这几个词加进查询：语料里没出现过的别名，靠主体名去捞原话。 */
function expandQueryWithFacts(query, factHits) {
  if (!factHits?.length) return String(query || '')
  const q = String(query || '')
  const extra = []
  for (const f of factHits.filter((x) => x.bridge).slice(0, 2)) {
    const t = String(f.subject || '').trim()
    if (t && !q.toLowerCase().includes(t.toLowerCase())) extra.push(t)
  }
  return extra.length ? `${q} ${extra.join(' ')}` : q
}

function recall(args) {
  if (args?.mode === 'index') return recallIndex(args || {})
  const started = Date.now()
  const toks = tokens(args?.query)
  const when = String(args?.when || '').trim()
  const from = String(args?.from || '').trim()
  const to = String(args?.to || '').trim()
  const limit = Math.min(20, Math.max(1, Number(args?.limit) || Number(cfg.recallLimit) || 6))
  const pool = poolFor(args)

  if (!toks.length) {
    const scope = when || (from && to ? `${from} → ${to}` : from ? `${from} 之后` : to ? `${to} 之前` : '')
    // offset = 从最近一条往前跳过多少条；翻更早的靠它，别靠加大 limit 一次灌满
    const offset = Math.max(0, Number(args?.offset) || 0)
    const end = Math.max(0, pool.length - offset)
    const start = Math.max(0, end - limit)
    const items = pool.slice(start, end).map((rec) => present(rec, []))
    const earlier = start
    return lossless({
      ok: true,
      note: scope ? `按范围「${scope}」取最近原话` : '没有给 query，也没有给时间范围；返回最近的原话',
      matched: pool.length,
      offset,
      returned: items.length,
      omitted: earlier,
      next: earlier > 0 ? offset + items.length : null,
      truncation: earlier > 0
        ? `还有 ${earlier} 条更早的原话没返回；要更早的传 offset=${offset + items.length}`
        : undefined,
      items,
    })
  }

  // 自我引用判别（2026-11-07）：Top1/TopN 里逐字含问句的，多半是"我复述/讨论过这个问句"的元记录，不是答案。
  // 规则：整句包含，或 ≥ min(12, max(6, 60% 长度)) 的滑窗命中；角色是 user 的原话不算（用户本来就是那么问的）。
  const selfRefOf = (text, q, role) => {
    if (role === 'user') return false // 用户原话不算"我复述"
    const t = String(text || '').toLowerCase()
    const s = String(q || '').toLowerCase().trim()
    if (!s || s.length < 6 || t.length < s.length) return false
    if (t.includes(s)) return true
    const win = Math.min(12, Math.max(6, Math.floor(s.length * 0.6)))
    for (let i = 0; i + win <= s.length; i += 1) if (t.includes(s.slice(i, i + win))) return true
    return false
  }
  // 自我污染是从"验证"长出来的：我复述过的问句会以满词覆盖排第一，然后被我自己再次复述。
  // 治法：排序时把元记录封顶在「最佳非元记录 × 0.99」之下——只压分不够（元记录一起被压，顺序不变）。
  const QUOTE_PENALTY = 0.5
  let hits = []
  const halfLife = Number(cfg.decayHalfLifeDays)
  const now = Date.now()
  const useBm25 = args?.score === 'bm25' || cfg.recallScorer === 'bm25'
  // 事实层：命中「主体/别名」时把那几个词加进检索——语料里从没出现过的别名（轮转≠context-rotate）只能这样捞回原话。
  const factHits = routeFacts(args?.query)
  const effQuery = expandQueryWithFacts(args?.query, factHits)
  const effToks = effQuery === args?.query ? toks : tokens(effQuery)
  if (useBm25) {
    // BM25：idf 在全 pool 上算，命中值与旧 count 不同量纲，只用于排序。
    const index = bm25IndexFor(pool)
    const scores = bm25ScoreAll(index, String(effQuery || ''), { roleWeights: roleWeightsFor(effQuery, pool[pool.length - 1]?.s), lengthPenalty: Math.max(0, Number(cfg.recallLengthPenalty) || 0) })
    // C：上下文低权加分（默认 lambda 0.35），只加不改正文长度归一。
    if (cfg.recallNeighbor) {
      const lam = Math.min(1, Math.max(0, Number(cfg.recallNeighborLambda ?? 0.35)))
      const ctx = bm25ScoreAll(bm25CtxIndexFor(pool), String(effQuery || ''), { roleWeights: roleWeightsFor(effQuery, pool[pool.length - 1]?.s) })
      if (lam > 0) for (let i = 0; i < scores.length; i += 1) if (ctx[i] > 0) scores[i] += ctx[i] * lam
    }
    // covBoost（2026-11-08 实验）：按「问句词覆盖了几成」加成，压掉只命中一个泛词的条目。
    const covAlpha = Math.max(0, Number(args?.covBoost) || 0)
    const covToks = covAlpha > 0 ? [...new Set(bm25Tokenize(String(effQuery || '')))] : []
    for (let i = 0; i < pool.length; i += 1) {
      let raw = scores[i]
      if (!raw) continue
      if (covAlpha > 0 && covToks.length) {
        const low = String(pool[i].x || '').toLowerCase()
        let hit = 0
        for (const t of covToks) if (low.includes(t.replace(/^(w|b):/, ''))) hit += 1
        raw *= Math.pow(1 + hit / covToks.length, covAlpha)
      }
      const rec = pool[i]
      const ageDays = Math.max(0, (now - Number(rec.t || now)) / 86_400_000)
      const decay = halfLife > 0 ? Math.pow(0.5, ageDays / halfLife) : 1
      hits.push({ rec, base: raw, score: raw * decay, decay, ageDays, meta: selfRefOf(rec.x, args?.query, rec.r) })
    }
  } else {
    for (const rec of pool) {
      const raw = scoreOf(rec.x, effToks)
      if (!raw) continue
      // 时间衰减：同等相关度下新的优先。只影响排序，不删原话。
      const ageDays = Math.max(0, (now - Number(rec.t || now)) / 86_400_000)
      const decay = halfLife > 0 ? Math.pow(0.5, ageDays / halfLife) : 1
      hits.push({ rec, base: raw, score: raw * decay, decay, ageDays, meta: selfRefOf(rec.x, args?.query, rec.r) })
    }
  }
  // 新近的"元讨论"（2026-11-07 补）：今天我对这个问句的分析/复盘会逐字带上问句用词，
  // 但 selfRef 的整句匹配抓不住「少一个字、换个标点」的复述。判据：2 天内 + 问句词覆盖 ≥80% + 不是我说的原话。
  // 老消息不适用——旧的回答本来就会高覆盖问句词，那是真答案，不能压。
  if (toks.length >= 4) {
    for (const h of hits) {
      if (h.meta || h.rec.r === 'user' || h.ageDays > 2) continue
      const t = String(h.rec.x || '').toLowerCase()
      const cov = toks.filter((x) => t.includes(x)).length / toks.length
      if (cov >= 0.8) h.meta = true
    }
  }
  const bestClean = hits.reduce((m, h) => (h.meta ? m : Math.max(m, h.score)), 0)
  for (const h of hits) {
    if (!h.meta) continue
    h.metaPenalty = QUOTE_PENALTY
    h.score *= QUOTE_PENALTY
    if (bestClean > 0) h.score = Math.min(h.score, bestClean * 0.99)
  }
  hits.sort((a, b) => b.score - a.score || b.rec.t - a.rec.t)
  // 混合召回（2026-11-08 A 实验）：BM25 排完，用「字面命中数」兜一次底。
  // 动机：q03 的 gold 是「Windows error: 5 / 2026-11」，题面写「安装器报错」——词面不重合，
  // BM25 把它排到 96 名外，但按字面（2026+重装）能直接命中。默认关，由 cfg.recallHybrid 打开。
  if (useBm25 && cfg.recallHybrid) {
    const kws = hybridKeywords(effQuery, pool, Number(cfg.recallHybridMaxKws) || 6)
    if (kws.length >= 2) {
      const minHits = Math.max(2, Number(cfg.recallHybridMinHits) || 2)
      const floorRatio = Math.min(1, Math.max(0.1, Number(cfg.recallHybridFloor) || 0.85))
      const count = (rec) => {
        const low = String(rec.x || '').toLowerCase()
        let n = 0
        for (const k of kws) if (low.includes(k)) n += 1
        return n
      }
      // 只有 top3 里字面命中都不够时才兜底，避免正常查询被改写顺序
      const coveredTop = hits.slice(0, 3).filter((h) => count(h.rec) >= minHits).length
      if ((!cfg.recallHybridGate || coveredTop < 2) && hits.length) {
        const best = hits[0].score || 0
        if (best > 0) {
          const floor = best * floorRatio
          const boosted = []
          for (const h of hits) {
            if (h.score >= floor) continue
            const n = count(h.rec)
            if (n < minHits) continue
            boosted.push({ h, n })
          }
          boosted.sort((a, b) => b.n - a.n || b.h.rec.t - a.h.rec.t)
          const cap = Math.max(1, Number(cfg.recallHybridCap) || 8)
          for (let i = 0; i < boosted.length && i < cap; i += 1) {
            const h = boosted[i].h
            h.hybrid = boosted[i].n
            h.score = floor * (1 - i * 0.01)
          }
          hits.sort((a, b) => b.score - a.score || b.rec.t - a.rec.t)
        }
      }
    }
  }
  // 拆字召回：只有显式传 morph 才走，默认行为不变。
  if (Number(args?.morph)) {
    const merged = morphExpand(hits, pool, toks)
    if (merged.length !== hits.length) {
      hits = merged
      hits.sort((a, b) => b.score - a.score || b.rec.t - a.rec.t)
    }
  }
  // 图扩展：只有显式传 expand 才走，默认行为不变。
  const hops = Math.max(0, Math.min(2, Math.floor(Number(args?.expand) || 0)))
  let expanded = 0
  let ranked = hits
  if (hops > 0) {
    const r = expandHits(hits, pool, hops, Math.max(1, Number(args?.seeds) || 5), Math.max(3, limit - 3), 3, String(args?.link || 'bigram'))
    ranked = r.hits
    expanded = r.expanded
  }
  const offset = Math.max(0, Number(args?.offset) || 0)
  // 预算：一次别把整段历史倒进上下文；超了就停在这一页，告诉调用方还有多少。
  const budget = Math.min(20000, Math.max(300, Number(args?.maxChars) || Number(cfg.recallMaxChars) || 3000))
  const page = ranked.slice(offset, offset + limit)
  const items = []
  let used = 0
  for (const h of page) {
    const item = present(h.rec, toks)
    if (items.length && used + item.excerpt.length > budget) break
    // 第一条就超预算：截到预算，别用「反正塞不下」当借口整条倒进去
    if (!items.length && item.excerpt.length > budget) {
      item.excerpt = item.excerpt.slice(0, Math.max(60, budget - 1)) + '…'
    }
    items.push({
      ...item,
      base: h.base,
      ageDays: Math.round(h.ageDays * 10) / 10,
      score: Math.round(h.score * 100) / 100,
      ...(h.hop ? { hop: h.hop, via: h.via } : {}),
      ...(h.meta ? { meta: true } : {}),
    })
    used += item.excerpt.length
  }
  const omitted = Math.max(0, ranked.length - (offset + items.length))
  const nextOffset = omitted > 0 ? offset + items.length : null
  // 弱命中就提示反问，而不是让调用方硬猜（2026-11-07）。
  // coverage = 问句的词有多少在 Top1 原文里；margin = Top1 比 Top2 高出多少倍。
  // selfRef：Top1 仍是"我复述过这个问句"的元记录（已按 0.5 压过分，仍排第一说明别的更不相关）。
  let confidence = null
  if (ranked.length) {
    const text = String(ranked[0].rec.x || '').toLowerCase()
    const hit = toks.filter((t) => text.includes(t)).length
    const coverage = toks.length ? Math.round((hit / toks.length) * 100) / 100 : 0
    const margin = ranked[1] && ranked[1].score > 0 ? Math.round((ranked[0].score / ranked[1].score) * 100) / 100 : 99
    const selfRef = selfRefOf(text, args?.query, ranked[0].rec.r)
    // 别名桥撑起来的命中：词覆盖率天然低（原话里没有那个叫法），别因此判弱。
    const bridged = !!(factHits && factHits.some((f) => f.bridge))
    const weak = selfRef || (coverage < 0.3 && !bridged) || margin < 1.2
    confidence = { coverage, margin, weak, ...(selfRef ? { selfRef: true } : {}) }
    if (weak) {
      confidence.ask = selfRef
        ? '第 1 名是我自己复述这句问话的记录（不是答案）。别硬答，先反问：你问的是哪一件事、大概什么时候、当时谁说的。'
        : `词只对上 ${Math.round(coverage * 100)}%，第 1 名与第 2 名分差 ${margin} 倍，别硬答。可以先反问：① 大概什么时候（哪天/哪一场）② 记得的关键词、路径或人名 ③ 是我说的还是你说的。`
    }
  }
  // 自动事实层：这次命中的条目各记一次 hits（异步；失败不影响 recall 返回）
  void import('./autofacts.mjs').then((m) => m.recordHits(items)).catch(() => {})
  // 推理类问题先查决策台账：那里存的是当时写下的取舍，不是我事后对这件事的复述。
  const decisions = REASONING_Q.test(String(args?.query || '')) ? routeDecisions(args?.query) : null
  logRecall(args, ranked, items, confidence, Date.now() - started)
  return lossless({
    ok: true,
    query: args?.query,
    ...(decisions ? { decisions } : {}),
    ...(factHits ? { facts: factHits } : {}),
    matched: ranked.length,
    offset,
    returned: items.length,
    omitted,
    next: nextOffset,
    ...(hops ? { expand: { hops, added: expanded } } : {}),
    ...(confidence ? { confidence } : {}),
    truncation: omitted > 0
      ? `${ranked.length} 条命中里还有 ${omitted} 条没返回（按相关度第 ${offset + items.length} 条之后；这次约 ${used} 字，预算 ${budget} 字）；要翻页传 offset=${nextOffset}`
      : undefined,
    note: hops
      ? `已从种子扩 ${hops} 跳（同会话相邻 0.5 / 同档案 0.8 / 罕见词 1.0，分数 ÷ 跳数^1.5）；带 hop/via 的条目是扩出来的。`
      : halfLife > 0
        ? `按「词面命中 × 时间衰减」排序（半衰期 ${halfLife} 天）；excerpt 是命中点附近的一段。`
        : '按词面命中排序（衰减已关闭）；excerpt 是命中点附近的一段。',
    items,
  })
}

/** memory/ 下的档案原文：索引模式用来算「哪些档案里真的有」；只读。 */
function archiveTexts() {
  const dir = String(cfg.memoryDir || '')
  if (!dir) return []
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8')
      out.push({ file: name, bytes: Buffer.byteLength(raw, 'utf8'), text: raw.toLowerCase() })
    } catch { /* 单个档案坏了不影响别的 */ }
  }
  return out
}

/** 二元组集合：只看字/数字，标点和空白不参与。 */

/** 硬实体：BV 号、日期、版本号、uuid、至少 3 位的数字。只取「精确锚点」，不做词面相似。 */
function entities(text) {
  const out = new Set()
  const t = String(text || '')
  for (const m of t.matchAll(/BV[0-9A-Za-z]{10}/g)) out.add('bv:' + m[0])
  for (const m of t.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) out.add('date:' + m[0])
  for (const m of t.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) out.add('id:' + m[0].toLowerCase())
  for (const m of t.matchAll(/\b\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?\b/g)) out.add('ver:' + m[0])
  for (const m of t.matchAll(/\b\d[\d,]{2,}\b/g)) out.add('num:' + m[0].replace(/,/g, ''))
  return out
}

function bigrams(text) {
  const out = new Set()
  const t = String(text || '').toLowerCase()
  const ok = /[\p{L}\p{N}]/u
  for (let i = 0; i < t.length - 1; i += 1) {
    const a = t[i]
    const b = t[i + 1]
    if (!ok.test(a) || !ok.test(b)) continue
    out.add(a + b)
  }
  return out
}

let topicCache = { at: 0, list: [] }
function topicIndex() {
  const now = Date.now()
  if (topicCache.list.length && now - topicCache.at < 60_000) return topicCache.list
  const list = archiveTexts().map((f) => ({ file: f.file, grams: bigrams(f.text) }))
  topicCache = { at: now, list }
  return list
}

/**
 * 「事」这一层：这条原话最像哪一个档案（覆盖率 ≥0.18 才算，宁缺毋滥）。
 * 不做语义——只是「它和哪个档案的共同二元组最多」，够给检索一个落点提示。
 */
function topicFor(text) {
  const grams = bigrams(text)
  if (grams.size < 8) return null
  let best = null
  for (const doc of topicIndex()) {
    let hit = 0
    for (const g of grams) if (doc.grams.has(g)) hit += 1
    const cov = hit / grams.size
    if (!best || cov > best.cov) best = { file: doc.file, cov }
  }
  return best && best.cov >= 0.18 ? best : null
}

/**
 * 档案按「命中几个不同的词」排（至少 2 个，防单个 bigram 造成假命中）；
 * 原话按天聚合，给每天几条、各取一条样本。下钻再用普通 recall / grep。
 */
function recallIndex(args) {
  const query = String(args?.query || '').trim()
  const toks = tokens(query)
  if (!toks.length) return { ok: false, error: '索引模式需要一个 query（先用一句话说说想找什么）' }
  const pool = poolFor(args)
  const found = []
  for (const rec of pool) {
    const base = scoreOf(rec.x, toks)
    if (base) found.push({ rec, base })
  }
  const days = new Map()
  for (const { rec, base } of found) {
    const day = ymd(rec.t)
    const cur = days.get(day) || { date: day, hits: 0, top: 0, sample: '', topics: {} }
    cur.hits += 1
    const topic = topicFor(rec.x)
    if (topic) cur.topics[topic.file] = (cur.topics[topic.file] || 0) + 1
    if (base > cur.top) {
      cur.top = base
      cur.sample = excerpt(rec.x, toks, 90)
    }
    days.set(day, cur)
  }
  const rankedDays = [...days.values()]
    .sort((a, b) => b.hits - a.hits || b.date.localeCompare(a.date))
    .slice(0, 5)
  // 档案：先看这个词在多少个档案里出现，出现太广的（「记忆」这种）不当依据；
  // 只剩泛词可查时，宁可给空也不要给一屏全是。
  const docs = archiveTexts()
  const df = new Map()
  for (const t of toks) df.set(t, docs.filter((d) => d.text.includes(t)).length)
  const informative = toks.filter((t) => df.get(t) <= Math.max(2, Math.ceil(docs.length * 0.3)))
  const archives = docs
    .map((f) => ({ file: f.file, bytes: f.bytes, hits: informative.filter((t) => f.text.includes(t)) }))
    .filter((f) => f.hits.length >= 1)
    .sort((a, b) => b.hits.length - a.hits.length || b.bytes - a.bytes)
    .slice(0, 5)
  const next = []
  if (rankedDays.length) next.push(`recall query="${args?.query}" when="${rankedDays[0].date}" limit=10`)
  if (archives.length) next.push(`grep -n "<关键词>" ${cfg.memoryDir}/${archives[0].file}`)
  if (!next.length) next.push('没有命中：换个说法，或用 recall 不带 query 看最近原话')
  return lossless({
    ok: true,
    mode: 'index',
    query,
    note: '索引模式：只给「哪儿可能有」，不给原文；挑一个入口再下钻。',
    total: found.length,
    days: rankedDays.map((d) => ({
      ...d,
      top: Math.round(d.top * 10) / 10,
      topics: Object.entries(d.topics || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, n]) => `${file}(${n})`),
    })),
    archives,
    next,
  })
}

/** 这条会话该不该进证据层：排除后台/模板型会话。 */
function excludedCwd(cwd) {
  const text = String(cwd || '')
  if (!text) return false
  const list = Array.isArray(cfg.excludeCwds) ? cfg.excludeCwds : []
  return list.some((needle) => needle && text.includes(needle))
}

/** 取命中点附近的一段，不要把整条消息倒进上下文。 */
function excerpt(text, toks, width) {
  const raw = String(text || '')
  const limit = Math.max(60, Number(width) || 220)
  if (raw.length <= limit) return raw
  const low = raw.toLowerCase()
  let at = -1
  for (const tok of toks || []) {
    at = low.indexOf(tok)
    if (at >= 0) break
  }
  if (at < 0) return raw.slice(0, limit) + '…'
  const half = Math.floor(limit / 2)
  const start = Math.max(0, at - half)
  const end = Math.min(raw.length, start + limit)
  return `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`
}

/** 短时间戳（月-日 时:分）：开场卡与依据行用。 */
function shortStamp(ms) {
  const d = new Date(Number(ms) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 本机时区的可读时间：范围参数也是按本机时区解释的，两边必须一致。 */
function localStamp(ms) {
  const d = new Date(Number(ms) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 检索日志（2026-11-08）：只记元信息，用来回答「实际用的时候哪儿不准」。
 * 尽力而为：任何失败都不影响 recall 返回。
 */
function logRecall(args, ranked, items, confidence, ms) {
  try {
    const file = path.join(DIR, 'recall-log.jsonl')
    const entry = {
      t: new Date().toISOString(),
      q: String(args?.query || '').slice(0, 120),
      ...(args?.mode ? { mode: String(args.mode) } : {}),
      ...(args?.when ? { when: String(args.when) } : {}),
      score: String(args?.score || cfg.recallScorer || 'count'),
      hops: Number(args?.hops) || 0,
      matched: ranked.length,
      returned: items.length,
      ms,
      ...(confidence ? { weak: !!confidence.weak, cov: confidence.coverage, margin: confidence.margin } : {}),
      // 只留摘要，不留全文：日志是证据，不是第二份语料。
      top: items.slice(0, 5).map((x) => ({
        s: x.score,
        ...(x.meta ? { meta: true } : {}),
        at: x.at,
        ex: String(x.excerpt || '').slice(0, 40),
      })),
    }
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) {
      fs.renameSync(file, `${file}.1`)
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch {}
}

function present(rec, toks) {
  const night = rec.r !== 'user' && nightSessions.has(String(rec.s))
  const topic = topicFor(rec.x)
  return {
    at: localStamp(rec.t),
    session: String(rec.s || '').slice(-8),
    role: rec.r === 'user' ? '他' : rec.r === 'thought' ? '我（想）' : (night ? '我（夜班）' : '我'),
    ...(night ? { origin: 'night' } : {}),
    ...(topic ? { topic: topic.file, topicCov: Math.round(topic.cov * 100) / 100 } : {}),
    excerpt: excerpt(rec.x, toks, cfg.excerptChars),
    chars: String(rec.x || '').length,
  }
}

function trace(args) {
  const needle = String(args?.query || '')
  if (!needle) return { ok: false, error: 'query 必填' }
  const list = visible(readEpisodes())
  const hits = list.filter((rec) => String(rec.x).includes(needle))
  const mine = hits.filter((rec) => rec.r === 'assistant').length
  const offset = Math.max(0, Number(args?.offset) || 0)
  const pageSize = 8
  const end = Math.max(0, hits.length - offset)
  const start = Math.max(0, end - pageSize)
  const items = hits.slice(start, end).map((rec) => present(rec, [needle]))
  const earlier = start
  return lossless({
    ok: true,
    query: needle,
    total: hits.length,
    byRole: { 他: hits.length - mine, 我: mine },
    offset,
    returned: items.length,
    omitted: earlier,
    next: earlier > 0 ? offset + items.length : null,
    truncation: earlier > 0
      ? `还有 ${earlier} 条更早的命中没返回；要更早的传 offset=${offset + items.length}`
      : undefined,
    items,
  })
}

/* ------------------------------------------------------------------ 工具 */

async function loadDefineTool() {
  const packages = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-sdk']
  for (const pkg of packages) {
    try {
      const mod = await import(pkg)
      if (typeof mod?.defineTool === 'function') return mod.defineTool
      if (typeof mod?.default?.defineTool === 'function') return mod.default.defineTool
    } catch { /* 试下一个 */ }
  }
  return (spec) => spec
}

function textOut() {
  return {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function toolSpecs() {
  return [
    {
      name: 'recall',
      description: '翻原话：按一句话或一个时间范围找回「当时说过什么」。query 按「词面命中 × 时间衰减」排序（近的优先）；时间用 when（某天：2026-11-01 / 昨天 / 最近7天）或 from+to（范围）。返回原文节选，不做总结。默认只给一页（12 条，约 3000 字）；返回里 total/matched 是总命中、omitted 是没给的条数，有省略时带 truncation 和 next。不确定去哪儿找时先传 mode=index：只返回「哪些档案、哪几天有命中」，再挑一天下钻，比一次性倒原文省。',
      parameters: {
        query: { type: 'string', description: '想找的话题或关键词' },
        mode: { type: 'string', description: 'index = 只给索引（档案 + 按天的命中数），不给原文；不传则返回原话节选' },
        maxChars: { type: 'integer', description: '这一页原文的总字数预算，默认 3000，上限 20000；超了就停并给 next' },
        when: { type: 'string', description: '某一天或区间：2026-11-01 / 11-01 / 今天 / 昨天 / 最近7天 / 2026-11-01..2026-11-02' },
        from: { type: 'string', description: '起始时间（含），写法和 when 一样' },
        to: { type: 'string', description: '结束时间（不含）' },
        limit: { type: 'integer', description: '这一页返回条数，默认 12，上限 20' },
        offset: { type: 'integer', description: '翻页游标：跳过前多少条再取（用返回里的 next）。不传就是从头' },
        expand: { type: 'integer', description: '图扩展跳数 0–2（默认 0）。1 或 2 时从命中的前几条沿「同会话相邻 / 同档案 / 共享罕见词」扩边，带 hop/via 的条目是扩出来的' },
        seeds: { type: 'integer', description: '图扩展用前几条命中当种子，默认 5' },
        score: { type: 'string', description: '打分器：count（默认，词面次数）或 bm25（IDF + 长度归一，改写问句更稳）' },
      },
      output: textOut(),
      async execute(args) { return recall(args || {}) },
    },
    {
      name: 'trace',
      description: '按原字核实某句话到底说过没有，一字不差地匹配，不问意思。返回命中条数、按角色分布和最后几条原文。给了 total / omitted，命中多于 8 条时只给最近的 8 条并说明还差多少。',
      parameters: {
        query: { type: 'string', required: true, description: '要核实的原字' },
        offset: { type: 'integer', description: '翻页游标：跳过最近多少条再往前取，用返回里的 next' },
      },
      output: textOut(),
      async execute(args) { return trace(args || {}) },
    },
    {
      name: 'self_write',
      description: '写今天的自我记录（每天一条，上限 10 条，写满覆盖最旧；同一天再调会替换当天那条）。写「经历」而不是「自评」：今天遇到的事里，哪件让你意外、哪句话让你不舒服、你原来怎么想现在怎么想。允许只有一句、允许不完整；不要写成工作汇报或流程复盘，不写关于自己的形容词，不写"我应该表现得…"。',
      parameters: {
        text: { type: 'string', required: true, description: '今天的一条自我记录，200 字以内，优先写具体经历与判断变化' },
      },
      output: textOut(),
      async execute(args) { return writeSelf(args?.text) },
    },
    {
      name: 'handoff_write',
      description: '写「交接」：下次醒来会先读到这两行。where = 我现在停在哪（正在做什么、做到哪一步、卡在哪）；next = 下次想做什么。一两句话就够，别写成进度报告。每次停下前都该更新一次。',
      parameters: {
        where: { type: 'string', description: '我停在哪（一句话）' },
        next: { type: 'string', description: '下次我想做什么（一句话）' },
      },
      output: textOut(),
      async execute(args, exec) { return writeHandoff(args?.where, args?.next, exec?.agent?.session?.id) },
    },
    {
      name: 'self_read',
      description: '读回自己的自我记录（带日期，最多 10 条）。想确认"我上次写了什么"时用。',
      parameters: {},
      output: textOut(),
      async execute() {
        const entries = selfEntries()
        return { ok: true, count: entries.length, entries }
      },
    },
    {
      name: 'remember',
      description: '把一条定论/指针写进 `memory/`：文件不存在就建骨架，索引表缺这行就补一行，有就更新摘要。只写「指针 + 一句话摘要」，不复制正文——正文仍由人读的文件承载。写完注入的【项目档案】会立刻反映。',
      parameters: {
        file: { type: 'string', required: true, description: 'memory/ 下的文件名，如 memcore.md（只允许这一层，不许 ../）' },
        title: { type: 'string', description: '新建档案时的标题' },
        summary: { type: 'string', description: '一句话摘要（索引表第二列显示的那句）' },
        when: { type: 'string', description: '什么时候读（索引表第三列）' },
        note: { type: 'string', description: '要追加到档案末尾的一条要点，自动带日期' },
      },
      output: textOut(),
      async execute(args) { return rememberMemory(args || {}) },
    },
    {
      name: 'decide',
      description: '记一条决策台账：定了什么 / 为什么 / 依据（可选）/ 否决了什么（可选）。问「为什么这么定」时 recall 会先查这里——它存的是当时写下的取舍，不是事后复述，所以不受对话语料污染。',
      parameters: {
        decision: { type: 'string', required: true, description: '定了什么（一句话）' },
        reason: { type: 'string', required: true, description: '为什么（一句话，写取舍依据）' },
        evidence: { type: 'string', description: '依据：文件行号 / 实测数字 / 用户原话' },
        alternatives: { type: 'string', description: '否决了什么、为什么否决' },
      },
      output: textOut(),
      async execute(args) { return appendDecision(args || {}) },
    },
    {
      name: 'fact_write',
      description: '记一条事实（等价关系）：主体 + 别名 + 一句话说明 + 来源。用于「同一个东西有另一个名字」的情况——语料里没出现过的叫法（轮转式插件 = context-rotate）检索调不出来，只能写入时记下。',
      parameters: {
        subject: { type: 'string', required: true, description: '主体：插件名 / 路径 / 概念 / 人名' },
        aliases: { type: 'string', description: '别名，逗号分隔（用户可能怎么叫它）' },
        note: { type: 'string', description: '一句话说明它是什么、在哪、和谁有关' },
        src: { type: 'string', description: '来源：会话 id、文件行号或用户原话' },
        validFrom: { type: 'string', description: '从什么时候开始有效（可选，如 2026-11-01）' },
        validTo: { type: 'string', description: '到什么时候失效（可选，如 2026-11-05；后来被推翻的写这里）' },
        supersedes: { type: 'string', description: '要取代的旧事实 id（可选）：旧条自动打 validTo + supersededBy，检索不再返回它；只传确认过的那条，别猜' },
      },
      output: textOut(),
      async execute(args) { return appendFact(args || {}) },
    },
  ]
}

/* ------------------------------------------------------------------ 挂载 */

/** 模块加载时就定位 defineTool：注册工具走同步路径，避免 inject 回调异步化。 */
const defineTool = await loadDefineTool()

/** 跨挂载保留的最小状态：最后活跃会话、今天是否已催过自我记录、今天是否跑过日脚本。 */
let lastSessionId = ''
let selfPromptedDate = ''
let dailyRuns = {}
let agentsRef = null
let createUserMessage = null

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    lastSessionId = String(j?.lastSessionId || '')
    selfPromptedDate = String(j?.selfPromptedDate || '')
    dailyRuns = (j && typeof j.dailyRuns === 'object' && j.dailyRuns) ? j.dailyRuns : {}
  } catch { /* 首次运行没有 state */ }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE,
      JSON.stringify({ lastSessionId, selfPromptedDate, dailyRuns }),
      'utf8',
    )
  } catch { /* ignore */ }
}

/**
 * 每天跑一次的外部脚本（coin-log / follow-next 等，各自独立计时）。
 * 用 spawn + stdio:'ignore'：宿主沙箱里管道 stdio 可能被拒，也不需要它的输出。
 */
function maybeRunDailyScripts() {
  const list = Array.isArray(cfg.dailyScripts) ? cfg.dailyScripts : []
  const today = ymd(Date.now())
  const hourNow = new Date().getHours()
  for (const d of list) {
    if (!d || d.enabled !== true) continue
    const name = String(d.name || path.basename(String(d.path || 'script')))
    if (dailyRuns[name] === today) continue
    const hour = Number(d.hour)
    if (!(hour >= 0 && hour <= 23)) continue
    if (hourNow < hour) continue
    const scriptPath = String(d.path || '')
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      log(`日脚本 ${name} 跳过：找不到 ${scriptPath}`)
      dailyRuns[name] = today
      saveState()
      continue
    }
    const nodeBin = process.env.DSH_NODE || process.execPath
    try {
      const child = spawn(nodeBin, [scriptPath, ...(Array.isArray(d.args) ? d.args : [])], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      dailyRuns[name] = today
      saveState()
      log(`日脚本已触发: ${name} (${path.basename(scriptPath)})`)
    } catch (error) {
      log(`日脚本 ${name} 启动失败: ${error?.message || error}`)
    }
  }
}

async function loadLlm() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    return mod?.createUserMessage || mod?.default?.createUserMessage || null
  } catch {
    return null
  }
}

/**
 * 每天一次的自我记录提醒：到点、今天还没写、今天有对话，就往最后活跃的会话里
 * 推一条消息，让模型自己调 self_write。只推一次，失败不重试。
 */
function maybePromptSelf() {
  if (!cfg.selfNote) return
  const today = ymd(Date.now())
  if (selfPromptedDate === today) return
  const hour = Number(cfg.selfHour)
  if (!(hour >= 0 && hour <= 23)) return
  if (new Date().getHours() < hour) return
  if (hasSelfEntry(today)) {
    selfPromptedDate = today
    saveState()
    return
  }
  // 今天没有任何对话就不打扰
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const hasToday = readEpisodes(2000).some((rec) => rec.t >= todayStart.getTime())
  if (!hasToday) return

  const agent = agentsRef && typeof agentsRef.get === 'function' ? agentsRef.get(lastSessionId) : null
  if (!agent || typeof agent.followup !== 'function' || typeof createUserMessage !== 'function') {
    log('自我记录提醒跳过：没有可用会话或 llm')
    return
  }
  try {
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: '【今天的自我记录还没写】用 self_write 写一条，200 字以内。\n\n'
          + '优先写**今天真正发生的事**，不是对我工作的评估：\n'
          + '- 哪件事让我意外，为什么意外；\n'
          + '- 哪句话让我不舒服，它戳中了什么；\n'
          + '- 我原来怎么想，现在怎么想，中间是哪件事让我改的。\n\n'
          + '允许只有一句、允许不完整。不要写"今天我犯了个流程错误"这类内部审计式的话，也不要在没经历的地方硬编。',
      }],
      source: { kind: 'user', rpcId: `memcore-self-${today}` },
    })
    agent.followup(message)
    selfPromptedDate = today
    saveState()
    log(`自我记录提醒已推送到 ${lastSessionId}`)
  } catch (error) {
    log(`自我记录提醒失败: ${error?.message || error}`)
  }
}

export function apply(ctx) {
  readConfig()
  try { fs.mkdirSync(DIR, { recursive: true }) } catch { /* ignore */ }
  readState()
  loadHistory()
  log(`apply · capture=${cfg.capture} cues=${cfg.cues} self=${cfg.selfNote} segments=${segments.length}`)

  loadLlm().then((fn) => { createUserMessage = fn }).catch(() => {})
  try {
    ctx.inject(['agents'], (inner) => { agentsRef = inner.agents || null })
  } catch { /* agents 不可用时自动记录提醒就跳过 */ }

  // 证据层：订阅会话事件，直接落盘（不经过模型）
  if (cfg.capture && typeof ctx.on === 'function') {
    try {
      ctx.on('session/event', (session, event) => {
        try {
          const type = event?.type
          if (type !== 'user/message' && type !== 'assistant/message') return
          const sessionId = String(session?.id || session?.header?.id || '')
          if (!sessionId) return
          if (excludedCwd(session?.header?.cwd || session?.cwd)) return
          const data = event?.data || {}
          const role = data.role === 'assistant' || type === 'assistant/message' ? 'assistant' : 'user'
          if (role === 'user' && data.role && data.role !== 'user') return
          // 只认真正的人话：插件注入 / 命令回显这类 source.kind 不是 user
          if (role === 'user' && data.source && data.source.kind && data.source.kind !== 'user') return
          const content = data.message?.content ?? data.content
          const text = sanitize(contentText(content))
          const thought = role === 'assistant' ? sanitize(reasoningText(content)) : ''
          // 短回复（「晚安，主人。」6 字）照存，但不进段表与线索段——只供 recall 翻。
          const minText = role === 'assistant' ? 2 : 8
          if (text.length < minText && thought.length < 80) return
          const base = {
            t: Number(data.time || event?.time || Date.now()),
            s: sessionId,
            q: Number(data.seq || event?.seq || 0),
            g: 0,
          }
          if (text.length >= minText) {
            if (/^［身份］|^【身份】/.test(text)) nightSessions.add(sessionId)
            const rec = {
              ...base,
              r: role,
              x: text.slice(0, Math.max(200, Number(cfg.maxChars) || 4000)),
            }
            if (text.length < 8) rec.short = 1
            if (!rec.short) {
              const seg = touchSegment(rec)
              if (seg) rec.g = seg.id
            }
            appendEpisode(rec)
            // 思考也算记忆：assistant 的 reasoning 截到 400 字；不进线索段，只供 recall 翻。
            if (role === 'assistant' && thought.length >= 80) {
              appendEpisode({ ...base, r: 'thought', x: clipThought(thought), g: rec.g })
            }
          } else {
            // 只有工具调用、没有文字的轮次：仍留下思考（人思考过就算记得）
            appendEpisode({ ...base, r: 'thought', x: clipThought(thought) })
          }
        } catch (error) {
          log(`capture 跳过: ${error?.message || error}`)
        }
      })
    } catch (error) {
      log(`订阅 session/event 失败: ${error?.message || error}`)
    }
  }

  // 注入：每轮一条线索（只给索引，不给内容）
  if (cfg.cues) {
    try {
      ctx.inject(['systemPrompt'], (inner) => {
        try {
          inner.systemPrompt.context({
            name: 'memcore/cues',
            order: 220,
            text: () => cues(),
          })
        } catch (error) {
          log(`注册上下文失败: ${error?.message || error}`)
        }
      })
    } catch (error) {
      log(`inject systemPrompt 失败: ${error?.message || error}`)
    }
  }

  // 此刻（2026-11-10）：每轮刷新的一段处境，不是情绪。
  if (cfg.now) {
    try {
      ctx.inject(['systemPrompt'], (inner) => {
        try {
          const sp = inner?.systemPrompt ?? inner
          if (typeof sp?.context === 'function') {
            sp.context({ name: 'memcore/now', order: 219, text: () => nowText() })
            log('此刻段已注册: order 219')
          } else if (typeof sp?.section === 'function') {
            sp.section({ name: 'memcore/now', order: 219, text: nowText() })
            log('此刻段已注册(冻结): order 219')
          }
        } catch (error) {
          log(`注册此刻段失败: ${error?.message || error}`)
        }
      })
    } catch (error) {
      log(`inject systemPrompt（此刻）失败: ${error?.message || error}`)
    }
  }

  // 项目档案：memory/ 的索引表（接替 engramory 的 MEMORY.md 注入，只给最近改动的几个）
  if (cfg.archives) {
    try {
      ctx.inject(['systemPrompt'], (inner) => {
        try {
          inner.systemPrompt.context({
            name: 'memcore/archives',
            order: 221,
            text: () => archives(),
          })
        } catch (error) {
          log(`注册档案段失败: ${error?.message || error}`)
        }
      })
    } catch (error) {
      log(`inject systemPrompt（档案）失败: ${error?.message || error}`)
    }
  }

  // 任务配方索引（2026-11-10）：整场冻结的一段指路话。
  // 背景：翻原话、出片、改插件这些事在新会话里被反复重新推演——事实记了，「配方」没记。
  if (cfg.playbook) {
    const text = '【配方】要动手做「以前做过的事」——出一集视频、投稿发布、改 memcore、翻 episodes 原话、改 DSH 插件——先读 memory/playbook.md 的索引表，命中再展开那一节；不要重推已经验证过的解法。'
    try {
      ctx.inject(['systemPrompt'], (inner) => {
        const sp = inner?.systemPrompt ?? inner
        try {
          if (typeof sp?.section === 'function') {
            sp.section({ name: 'memcore/playbook', order: 10240, text })
          } else if (typeof sp?.context === 'function') {
            sp.context({ name: 'memcore/playbook', order: 10240, text: () => text })
          }
          log(`配方索引已注入: ${Buffer.byteLength(text, 'utf8')} 字节`)
        } catch (error) {
          log(`注册配方索引失败: ${error?.message || error}`)
        }
      })
    } catch (error) {
      log(`inject systemPrompt（配方）失败: ${error?.message || error}`)
    }
  }

  // 开场记忆卡（2026-11-08 二修）：按 agent 注册。全局段只在 apply 时算一次，
  // 同进程新开会话会一直读到旧卡（22:40 的现象）；agent 作用域同名段覆盖全局段。
  if (cfg.openingCard) {
    try {
      ctx.on('agent/created', (info) => {
        try {
          const agent = info?.agent ?? info
          const id = String(agent?.id ?? agent?.session?.id ?? '')
          const text = openingCardFor(id)
          // 闭包常量：这一场的卡在本场里不变，前缀稳定。
          if (!text) return
          const sp = agent?.ctx?.systemPrompt
          if (!sp || typeof sp.context !== 'function') {
            log('开场记忆卡: agent.ctx.systemPrompt 不可用')
            return
          }
          sp.context({ name: 'memcore/opening', order: 222, text: () => text })
          log(`开场记忆卡已注入（${id.slice(0, 26)}）: ${Buffer.byteLength(text, 'utf8')} 字节
${text}`)
        } catch (error) {
          log(`注册开场记忆卡失败: ${error?.message || error}`)
        }
      })
      log(`开场记忆卡: 已挂 agent/created（按 agent 注册）；近重复行列 ${cfg.openingCardDedup ? `开 @ ${Math.min(0.99, Math.max(0.5, Number(cfg.openingCardDedupScore) || 0.85))}` : '关'}`)
    } catch (error) {
      log(`注册 agent/created（开场记忆卡）失败: ${error?.message || error}`)
    }
  }

  // 宪法：整场冻结的系统提示段（改文件后需重挂载才生效）
  if (cfg.constitution) {
    const text = readConstitution()
    if (text) {
      try {
        ctx.inject(['systemPrompt'], (inner) => {
          const sp = inner?.systemPrompt ?? inner
          try {
            if (typeof sp?.section === 'function') {
              sp.section({
                name: 'memcore/constitution',
                order: 10250,
                text,
              })
              log(`宪法已注入（section）: ${Buffer.byteLength(text, 'utf8')} 字节`)
            } else if (typeof sp?.context === 'function') {
              // 宿主 0.2.x 的注入对象只有 context()；静态文本也能过。
              sp.context({
                name: 'memcore/constitution',
                order: 10250,
                text: () => text,
              })
              log(`宪法已注入（context 回退）: ${Buffer.byteLength(text, 'utf8')} 字节`)
            } else {
              log(`注册宪法失败: 无 section/context，inner=${Object.keys(inner ?? {}).slice(0, 8).join(',')}`)
            }
          } catch (error) {
            log(`注册宪法失败: ${error?.message || error}`)
          }
        })
      } catch (error) {
        log(`inject systemPrompt（宪法）失败: ${error?.message || error}`)
      }
    }
  }

  // 工具：defineTool 在模块加载时就取好，注册走同步路径
  ctx.inject(['tools'], (inner) => {
    try {
      if (!inner.tools || typeof inner.tools.register !== 'function') {
        log('tools.register 不可用，工具未注册')
        return
      }
      for (const spec of toolSpecs()) {
        try {
          inner.tools.register(typeof defineTool === 'function' ? defineTool(spec) : spec)
        } catch (error) {
          log(`注册工具 ${spec.name} 失败: ${error?.message || error}`)
        }
      }
      log('工具已注册: recall / trace / self_write / self_read / handoff_write / remember')
    } catch (error) {
      log(`注册工具异常: ${error?.message || error}`)
    }
  })

  // 每天一次的定时检查：自我记录提醒 + 日脚本（各自只跑一次/天）
  const dailyTimer = setInterval(() => {
    try { maybePromptSelf() } catch (error) { log(`自我记录检查异常: ${error?.message || error}`) }
    try { maybeRunDailyScripts() } catch (error) { log(`日脚本检查异常: ${error?.message || error}`) }
  }, 60_000)
  dailyTimer.unref?.()
  if (cfg.selfNote) {
    log(`自我记录提醒已排程: 每天 ${cfg.selfHour} 点后，上限 ${cfg.selfMaxEntries} 条`)
  }
  const tasks = (Array.isArray(cfg.dailyScripts) ? cfg.dailyScripts : []).filter((d) => d?.enabled === true)
  if (tasks.length) {
    log(`日脚本已排程: ${tasks.map((d) => `${d.name || path.basename(String(d.path))}@${d.hour}点`).join(' · ')}`)
  }
}
