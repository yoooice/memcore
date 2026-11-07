#!/usr/bin/env node
// memcore 本地服务：HTTP JSON API + 网页 UI。
// 跨模型用法：任何能发 HTTP 的客户端（OpenAI function calling、LangChain、自写脚本、其他 Agent）
// 都直接 POST /api/recall。MCP 客户端走 mcp.mjs。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore } from './lib/core.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const core = createCore({ memoryDir: argOf('--dir'), docsDir: argOf('--docs') })
const PORT = Number(argOf('--port') || process.env.MEMCORE_PORT || 7474)
const HOST = argOf('--host') || '127.0.0.1'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }

function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
  res.end(s)
}

function body(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' })
      return res.end()
    }
    if (p === '/api/stats') return json(res, 200, core.stats())
    if (p === '/api/recall') {
      const q = url.searchParams.get('q') || url.searchParams.get('query') || ''
      if (!q) return json(res, 400, { ok: false, error: '缺少 q 参数' })
      return json(res, 200, core.recall({
        query: q,
        limit: Number(url.searchParams.get('limit')) || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        maxChars: Number(url.searchParams.get('maxChars')) || undefined,
      }))
    }
    if (p === '/api/trace') {
      const q = url.searchParams.get('q') || ''
      if (!q) return json(res, 400, { ok: false, error: '缺少 q 参数' })
      return json(res, 200, core.trace({ query: q, limit: Number(url.searchParams.get('limit')) || 20 }))
    }
    if (p === '/api/memory') return json(res, 200, { ok: true, files: core.listMemory() })
    if (p === '/api/facts') return json(res, 200, { ok: true, facts: core.listFacts() })
    if (p === '/api/decisions') return json(res, 200, { ok: true, decisions: core.listDecisions() })
    if (p.startsWith('/api/memory/')) {
      const id = decodeURIComponent(p.slice('/api/memory/'.length))
      const out = core.readMemory(id)
      return json(res, out.ok ? 200 : 404, out)
    }
    if (p === '/api/fact' && req.method === 'POST') return json(res, 200, core.factWrite(await body(req)))
    if (p === '/api/decide' && req.method === 'POST') return json(res, 200, core.decide(await body(req)))
    if (p === '/api/remember' && req.method === 'POST') return json(res, 200, core.remember(await body(req)))

    // 静态文件
    const rel = p === '/' ? 'ui/index.html' : p.replace(/^\/+/, '')
    const file = path.join(HERE, rel)
    if (!file.startsWith(HERE)) return json(res, 403, { ok: false, error: 'forbidden' })
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      return res.end(fs.readFileSync(file))
    }
    json(res, 404, { ok: false, error: 'not found', path: p })
  } catch (e) {
    json(res, 500, { ok: false, error: e.message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`memcore 记忆库: ${core.dir}`)
  console.log(`UI  : http://${HOST}:${PORT}/`)
  console.log(`API : http://${HOST}:${PORT}/api/recall?q=...`)
})
