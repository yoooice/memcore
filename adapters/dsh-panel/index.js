/**
 * dsh-memcore-panel — 宿主半。
 *
 * 把「记忆核心」的内核直接挂进 DSH 的 HTTP 面：同进程读 ~/.dsh/memcore，
 * 不额外起端口，客户端面板用相对路径 api/memcore/* 调它。
 *
 * 数据结构（episodes / facts / decisions / 档案）与独立包同一份，见 lib/core.mjs。
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCore } from './lib/core.mjs'

export const name = 'dsh-memcore-panel'
export const inject = []

const LOG = process.env.DSH_MEMCORE_PANEL_LOG || ''
function log(line) {
  if (!LOG) return
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch { /* logging must never break the panel */ }
}

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
let core = null
function getCore() {
  if (core) return core
  core = createCore({
    memoryDir: process.env.MEMCORE_DIR || path.join(HOME, 'memcore'),
    docsDir: process.env.MEMCORE_DOCS || 'D:/Deepseek-Core/Work/memory',
  })
  log(`core: dir=${core.dir}`)
  return core
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

async function readJson(request) {
  try { return await request.json() } catch { return {} }
}

function routes() {
  const c = () => getCore()
  return [
    {
      path: '/api/memcore/stats',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => json(200, c().stats()),
    },
    {
      path: '/api/memcore/recall',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        const url = new URL(request.url)
        const q = url.searchParams.get('q') || ''
        if (!q) return json(400, { ok: false, error: '缺少 q' })
        return json(200, c().recall({
          query: q,
          limit: Number(url.searchParams.get('limit')) || undefined,
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
        }))
      },
    },
    {
      path: '/api/memcore/facts',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => json(200, { ok: true, facts: c().listFacts() }),
    },
    {
      path: '/api/memcore/decisions',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => json(200, { ok: true, decisions: c().listDecisions() }),
    },
    {
      path: '/api/memcore/memory',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => json(200, { ok: true, files: c().listMemory() }),
    },
    {
      path: '/api/memcore/doc',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        const id = new URL(request.url).searchParams.get('id') || ''
        if (!id) return json(400, { ok: false, error: '缺少 id' })
        const out = c().readMemory(id)
        return json(out.ok ? 200 : 404, out)
      },
    },
    {
      path: '/api/memcore/fact',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => json(200, c().factWrite(await readJson(request))),
    },
    {
      path: '/api/memcore/decide',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => json(200, c().decide(await readJson(request))),
    },
  ]
}

export function apply(ctx) {
  log('apply: start')
  ctx.inject(['connection'], (inner) => {
    if (typeof inner.connection?.fetch?.register !== 'function') {
      log('apply: connection.fetch.register unavailable')
      return
    }
    for (const route of routes()) {
      inner.effect(() => {
        try {
          return inner.connection.fetch.register(route)
        } catch (error) {
          log(`route ${route.path} failed: ${error?.message || error}`)
          return () => {}
        }
      })
    }
    log(`apply: ${routes().length} routes registered`)
  })
}
