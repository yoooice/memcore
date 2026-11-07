#!/usr/bin/env node
// 命令行入口：不接任何模型也能用。
//   node cli.mjs recall "以前说过什么"
//   node cli.mjs trace "原字"
//   node cli.mjs stats
//   node cli.mjs serve --port 7474
import { createCore } from './lib/core.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const rest = (skip = 1) => argv.slice(skip).filter((x) => !x.startsWith('--') && x !== argOf('--dir') && x !== argOf('--docs')).join(' ').trim()
const core = createCore({ memoryDir: argOf('--dir'), docsDir: argOf('--docs') })

async function main() {
  if (cmd === 'serve') { await import('./server.mjs'); return }
  if (cmd === 'recall') {
    const out = core.recall({ query: rest(), limit: Number(argOf('--limit')) || 6 })
    if (!out.matched) return console.log('没有命中')
    if (out.confidence?.weak) console.log(`⚠ 弱命中（覆盖率 ${out.confidence.coverage} / 分差 ${out.confidence.margin}×）：${out.confidence.ask || '先反问，别硬答'}`)
    for (const it of out.items) console.log(`\n[${it.at}] ${it.session} ${it.role}  ${it.score}${it.meta ? ' (元记录)' : ''}\n${it.text}`)
    if (out.facts?.length) console.log('\n事实：' + out.facts.map((f) => `${f.subject}(${f.bridge ? '桥' : '-'})`).join(' · '))
    if (out.decisions?.length) console.log('决策：' + out.decisions.map((d) => d.decision).join(' | '))
    return
  }
  if (cmd === 'trace') {
    const out = core.trace({ query: rest() })
    console.log(`命中 ${out.total} 处`)
    for (const h of out.hits) console.log(`- ${h.file || `${h.at} ${h.session} ${h.role}`}: …${h.excerpt.replace(/\s+/g, ' ')}…`)
    return
  }
  if (cmd === 'stats') { console.log(core.stats()); return }
  if (cmd === 'fact') {
    const out = core.factWrite({ subject: argOf('--subject'), aliases: argOf('--aliases'), note: argOf('--note'), validFrom: argOf('--from'), validTo: argOf('--to') })
    console.log(out); return
  }
  if (cmd === 'decide') {
    const out = core.decide({ decision: argOf('--decision'), reason: argOf('--reason'), evidence: argOf('--evidence'), alternatives: argOf('--alternatives') })
    console.log(out); return
  }
  console.log(`memcore
  recall "<查询>" [--limit 6] [--from 2026-11-01] [--to ...]
  trace  "<原字>"
  stats
  fact   --subject X [--aliases "a,b"] [--note "..."]
  decide --decision "..." --reason "..."
  serve  [--port 7474]
全局：--dir <记忆目录>  --docs <档案目录>`)
}
main()
