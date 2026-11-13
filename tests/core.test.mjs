import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCore } from '../packages/core/lib/core.mjs'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-'))
  const docs = path.join(dir, 'memory')
  fs.mkdirSync(docs)
  fs.writeFileSync(path.join(docs, 'demo.md'), '# demo\n\n窗口每十秒自动闪烁一次，日志在 workbench.log。\n')
  fs.writeFileSync(path.join(dir, 'episodes.jsonl'), [
    { t: Date.now() - 86_400_000, r: 'user', x: '现在窗口每个一段时间自动闪烁一次是什么问题？', s: 's1' },
    { t: Date.now() - 86_000_000, r: 'assistant', x: '那是渲染层在重绘，先看 workbench.log 里有没有反复的 apply。', s: 's1' },
    { t: Date.now(), r: 'user', x: '完全无关的一句：今天午饭吃了面。', s: 's2' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { dir, docs }
}

test('检索命中原话并给置信度', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  const out = core.recall({ query: '窗口自动闪烁' })
  assert.equal(out.ok, true)
  assert.ok(out.matched >= 1)
  assert.match(out.items[0].text, /闪烁/)
  assert.equal(typeof out.confidence.coverage, 'number')
  assert.equal(typeof out.confidence.weak, 'boolean')
})

test('无关问题弱命中或反问', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  const out = core.recall({ query: '量子纠缠的退相干时间怎么算' })
  if (out.matched) assert.equal(out.confidence.weak, true)
})

test('别名桥：换说法也能找到', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  core.factWrite({ subject: '窗口闪烁', aliases: '屏幕跳一下,闪屏', note: '渲染层周期性重绘' })
  const out = core.recall({ query: '屏幕跳一下是怎么回事' })
  assert.ok(out.facts.length >= 1)
  assert.ok(out.facts[0].bridge)
})

test('决策台账：问为什么命中理由', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  core.decide({ decision: '不接语义模型', reason: '评测上没有稳定收益，且多 100MB 常驻' })
  const out = core.recall({ query: '为什么没有接语义模型' })
  assert.ok(out.decisions.length >= 1)
  assert.match(out.decisions[0].decision, /语义/)
})

test('档案列表与读取', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  const files = core.listMemory()
  assert.ok(files.length >= 1)
  const doc = core.readMemory(files[0].id)
  assert.equal(doc.ok, true)
  assert.match(doc.text, /workbench/)
})

test('临时记忆目录不污染真实数据', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  core.remember({ file: 'note.md', title: '测试', note: '一条测试记录' })
  assert.ok(fs.existsSync(path.join(docs, 'note.md')))
  assert.ok(!fs.existsSync(path.join(os.homedir(), '.dsh', 'memcore', 'note.md')))
})

test('回归：向已有档案追加内容，同一实例也能搜到', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  assert.equal(core.recall({ query: '电源适配器' }).matched, 0)
  fs.appendFileSync(path.join(docs, 'demo.md'), '\n## 新增\n\n灯光闪烁与电源适配器有关。\n', 'utf8')
  const out = core.recall({ query: '电源适配器' })
  assert.ok(out.matched >= 1)
  assert.match(out.items[0].text, /电源适配器/)
})

test('回归：两个会话条数与末条时间相同，不串缓存', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-'))
  const docs = path.join(dir, 'memory')
  fs.mkdirSync(docs)
  const t = Date.now()
  const rows = [
    { t: t - 1000, r: 'user', x: '把主题改成蓝色', s: 's1' },
    { t, r: 'assistant', x: '蓝色主题已经生效', s: 's1' },
    { t: t - 1000, r: 'user', x: '把主题改成绿色', s: 's2' },
    { t, r: 'assistant', x: '绿色主题已经生效', s: 's2' },
  ]
  fs.writeFileSync(path.join(dir, 'episodes.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const core = createCore({ memoryDir: dir, docsDir: docs })
  const a = core.recall({ query: '主题改成蓝色还是绿色', session: 's1' })
  const b = core.recall({ query: '主题改成蓝色还是绿色', session: 's2' })
  assert.ok(a.items.every((i) => !/绿色/.test(i.text)))
  assert.ok(b.items.every((i) => !/蓝色/.test(i.text)))
  assert.match(b.items[0].text, /绿色/)
})

test('回归：过期事实不参与检索，有效事实仍然参与', () => {
  const { dir, docs } = fixture()
  const core = createCore({ memoryDir: dir, docsDir: docs })
  core.factWrite({ subject: '旧入口', aliases: '老地址', note: '已废弃', validTo: '2020-01-01' })
  core.factWrite({ subject: '新入口', aliases: '新地址', note: '现在用这个' })
  const out = core.recall({ query: '老地址 新地址' })
  const subjects = (out.facts || []).map((f) => f.subject)
  assert.ok(!subjects.includes('旧入口'))
  assert.ok(subjects.includes('新入口'))
})
