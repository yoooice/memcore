import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectChecks } from '../packages/core/lib/doctor.mjs'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memcore-doctor-'))
}
function writeEpisode(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'episodes.jsonl'), JSON.stringify({ t: Date.now(), r: 'user', x: 'hello', s: 's1' }) + '\n')
}
function writeProfile(root, { bundles = [], bili = null, memcore = null } = {}) {
  const profile = path.join(root, 'profile')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
  for (const [name, version] of [['billion-context', bili], ['dsh-memcore', memcore]]) {
    if (!version) continue
    const d = path.join(profile, 'node_modules', name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version }))
  }
  return profile
}

test('空数据目录：只警告，不失败', () => {
  const root = tmp()
  const r = collectChecks({ dir: path.join(root, 'mem'), profile: path.join(root, 'no-profile') })
  assert.equal(r.fail, 0)
  assert.ok(r.checks.some((c) => c.label === '记忆目录' && c.status === 'warn'))
  assert.ok(r.checks.some((c) => c.label === 'DSH 搭配' && c.status === 'skip'))
})

test('半装：billion-context 在 node_modules 但不在 bundles → 失败且给命令', () => {
  const root = tmp()
  const memDir = path.join(root, 'mem')
  writeEpisode(memDir)
  const profile = writeProfile(root, { bundles: ['dsh-memcore'], bili: '0.1.212', memcore: '0.1.0' })
  const r = collectChecks({ dir: memDir, profile })
  const c = r.checks.find((x) => x.label === '上下文压缩')
  assert.equal(c.status, 'fail')
  assert.match(c.fix, /dsh plugin/)
})

test('测过的版本：报 ok 并带版本号', () => {
  const root = tmp()
  const memDir = path.join(root, 'mem')
  writeEpisode(memDir)
  const profile = writeProfile(root, { bundles: ['dsh-memcore', 'billion-context'], bili: '0.1.213', memcore: '0.1.0' })
  const r = collectChecks({ dir: memDir, profile })
  const c = r.checks.find((x) => x.label === '上下文压缩')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /0\.1\.213/)
})

test('未测版本：只警告，不失败', () => {
  const root = tmp()
  const memDir = path.join(root, 'mem')
  writeEpisode(memDir)
  const profile = writeProfile(root, { bundles: ['dsh-memcore', 'billion-context'], bili: '0.9.9', memcore: '0.1.0' })
  const r = collectChecks({ dir: memDir, profile })
  const c = r.checks.find((x) => x.label === '上下文压缩')
  assert.equal(c.status, 'warn')
  assert.equal(r.fail, 0)
})

test('profile package.json 带 BOM：判失败，并直接点名 BOM', () => {
  const root = tmp()
  const memDir = path.join(root, 'mem')
  writeEpisode(memDir)
  const profile = writeProfile(root, { bundles: [] })
  fs.writeFileSync(path.join(profile, 'package.json'), '\uFEFF' + JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  const r = collectChecks({ dir: memDir, profile })
  const c = r.checks.find((x) => x.label === 'DSH profile')
  assert.equal(c.status, 'fail')
  assert.match(c.detail, /BOM/)
  assert.match(c.fix, /EF BB BF/)
})
