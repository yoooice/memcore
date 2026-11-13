// 30 秒体验：造一份临时数据，跑两条查询（一条命中原话，一条命中档案）。
// 用法：node examples/demo.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCore } from '../packages/core/lib/core.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-demo-'))
const docs = path.join(dir, 'memory')
fs.mkdirSync(docs)

const now = Date.now()
const day = 86_400_000
const episodes = [
  { t: now - 3 * day, r: 'user', x: '现在窗口每个一段时间自动闪烁一次是什么问题？', s: 'demo-1' },
  { t: now - 3 * day + 60_000, r: 'assistant', x: '那是渲染层在反复重绘，先看 workbench.log 里有没有连续的 apply 记录。', s: 'demo-1' },
  { t: now - day, r: 'user', x: '帮我把部署脚本改成用绝对路径，不要再依赖 PATH 里的 powershell。', s: 'demo-2' },
]
fs.writeFileSync(path.join(dir, 'episodes.jsonl'), episodes.map((r) => JSON.stringify(r)).join('\n') + '\n')
fs.writeFileSync(path.join(docs, 'deploy.md'), '# 部署\n\n计划任务里的脚本一律写绝对路径：C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe。\n')
fs.writeFileSync(path.join(dir, 'facts.jsonl'), [
  { id: 'f1', ts: now, subject: 'dsh-workbench', aliases: ['工作台'], note: '客户端里的看板插件，日志在 workbench.log' },
].map((r) => JSON.stringify(r)).join('\n') + '\n')

const core = createCore({ memoryDir: dir, docsDir: docs })

for (const q of ['窗口老是闪是什么原因', '上次那个部署脚本为什么改绝对路径']) {
  const r = core.recall({ query: q, limit: 3 })
  console.log(`\n问：${q}`)
  for (const it of r.items) console.log(`  [${it.score}] ${it.role} ${it.at}  ${String(it.text).slice(0, 60)}…`)
  if (r.confidence?.weak) console.log(`  弱命中 → ${r.confidence.ask}`)
}

console.log(`\n数据目录（看完可删）：${dir}`)
