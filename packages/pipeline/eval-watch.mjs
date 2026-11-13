#!/usr/bin/env node
// eval-watch.mjs — 评测回归提醒：episodes 每翻一倍（2x / 4x / 8x）写一次 eval-due.json，
// cues 首行就会提醒「评测到期」。一共三次。
// 用法：node eval-watch.mjs            # 平时由 dailyScripts 9 点拉起
//       node eval-watch.mjs --reset    # 以当前条数为新基准（会清掉已触发记录）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(HOME, 'memcore')
const EPISODES = process.env.MEMCORE_EPISODES || path.join(DIR, 'episodes.jsonl')
const STATE = path.join(DIR, 'eval-watch.json')
const DUE = path.join(DIR, 'eval-due.json')

const BASE = 428 // 2026-11-05 定基线时的条数
const MARKS = [BASE * 2, BASE * 4, BASE * 8]

const args = process.argv.slice(2)
const reset = args.includes('--reset')

function countEpisodes() {
  try {
    return fs.readFileSync(EPISODES, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

const n = countEpisodes()
if (reset) {
  fs.writeFileSync(STATE, JSON.stringify({ base: n, fired: [] }, null, 2))
  try { fs.unlinkSync(DUE) } catch { /* 没有就算了 */ }
  console.log(`基准重置：${n} 条；下次阈值 ${n * 2}`)
  process.exit(0)
}

let state = { base: BASE, fired: [] }
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) } } catch { /* 首次 */ }
state.base = Number(state.base) || BASE
state.fired = Array.isArray(state.fired) ? state.fired : []
const marks = MARKS.map((m, i) => (state.base === BASE ? m : state.base * 2 ** (i + 1)))

const next = marks.findIndex((m, i) => !state.fired.includes(i + 1) && n >= m)
if (next < 0) {
  console.log(`episodes ${n} 条；未到下一次阈值（${marks.find((m, i) => !state.fired.includes(i + 1)) ?? '三次已跑完'}）`)
  process.exit(0)
}
state.fired.push(next + 1)
fs.writeFileSync(STATE, JSON.stringify(state, null, 2))
fs.writeFileSync(DUE, JSON.stringify({ count: n, mark: marks[next], index: next + 1, at: Date.now() }, null, 2))
console.log(`评测到期：${n} 条 ≥ 第 ${next + 1} 次阈值 ${marks[next]}`)
