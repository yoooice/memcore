#!/usr/bin/env node
// 评测脚手架：在自己的语料上复跑检索指标。
//   node eval/run.mjs --corpus eval/fixture.json --queries eval/fixture.json
// 也接受 JSONL：一行一个对象。
// 语料格式：[{ id, text, role? }]  或 [{ id, title, text }]
// 问题格式：[{ q, gold: [id, ...] }]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIndex, scoreAll } from '../lib/bm25.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

function load(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const s = raw.trim()
  if (s.startsWith('[')) return JSON.parse(s)
  return s.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const here = path.dirname(fileURLToPath(import.meta.url))
const corpusFile = arg('corpus', path.join(here, 'fixture-corpus.json'))
const queriesFile = arg('queries', path.join(here, 'fixture-queries.json'))
const topK = Number(arg('topk', 3))

const corpus = load(corpusFile)
const queries = load(queriesFile).filter((x) => x.q && Array.isArray(x.gold))

const index = buildIndex(
  corpus.map((d) => ({ text: `${d.title ? d.title + '｜' : ''}${d.text}`, role: d.role })),
  { unigrams: true, titleBoost: 2 },
)

let top1 = 0
let top3 = 0
let mrr = 0
const rows = []
for (const item of queries) {
  const scores = Array.from(scoreAll(index, item.q, {}))
  const ranked = scores
    .map((v, i) => [v, i])
    .filter(([v]) => v > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, topK)
    .map(([, i]) => corpus[i].id)
  const rank = ranked.findIndex((id) => item.gold.includes(id))
  const hit1 = rank === 0
  const hit3 = rank >= 0
  if (hit1) top1 += 1
  if (hit3) top3 += 1
  if (hit3) mrr += 1 / (rank + 1)
  rows.push({ q: item.q, gold: item.gold.join(','), got: ranked.join(','), rank: hit3 ? rank + 1 : null })
}

const n = queries.length
const pct = (x) => `${x}/${n} (${((x / n) * 100).toFixed(1)}%)`
console.log(`语料 ${corpus.length} 条 · 问题 ${n} 道 · topK=${topK}`)
console.log(`Top1 ${pct(top1)} · Top${topK} ${pct(top3)} · MRR@${topK} ${(mrr / n).toFixed(3)}`)
if (process.argv.includes('--verbose')) {
  for (const r of rows) console.log(`${r.rank ? '✓' : '✗'} [${r.rank || '-'}] ${r.q}\n    gold=${r.gold}\n    got =${r.got}`)
}
