#!/usr/bin/env node
// MCP stdio 服务：任何支持 Model Context Protocol 的客户端（Claude Desktop、Cursor、Windsurf…）
// 在配置里写 { "command": "node", "args": ["<绝对路径>/mcp.mjs"] } 即可用上记忆检索。
import { createCore } from './lib/core.mjs'

const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const core = createCore({ memoryDir: argOf('--dir'), docsDir: argOf('--docs') })

const TOOLS = [
  {
    name: 'recall',
    description: '在自己的长期记忆里检索原话。返回条目带时间、会话、角色、分数与置信度；置信度 weak=true 时不要硬答，先向用户反问。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的事情（用户原话或关键词）' },
        limit: { type: 'number', description: '返回条数，默认 6' },
        from: { type: 'string', description: '起始日期，如 2026-11-01（可选）' },
        to: { type: 'string', description: '结束日期（可选）' },
        maxChars: { type: 'number', description: '每条摘录上限，默认 600' },
      },
      required: ['query'],
    },
  },
  {
    name: 'trace',
    description: '按原字精确查找：某个词/句子到底在哪条消息、哪个档案里出现过。用于核实"我说过没有"。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'remember',
    description: '把一条结论写进记忆档案（追加到 memory/<file>.md）。只写指针 + 一句话，不复制正文。',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'fact_write',
    description: '记一条等价关系：主体 + 别名 + 说明。用于"同一个东西有另一个叫法"，检索时靠它把别名桥回原话。',
    inputSchema: { type: 'object', properties: { subject: { type: 'string' }, aliases: { type: 'string' }, note: { type: 'string' }, validFrom: { type: 'string' }, validTo: { type: 'string' } }, required: ['subject'] },
  },
  {
    name: 'decide',
    description: '记一条决策：定了什么 / 为什么 / 依据。问「当时为什么这么定」时会先查这里。',
    inputSchema: { type: 'object', properties: { decision: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' }, alternatives: { type: 'string' } }, required: ['decision', 'reason'] },
  },
  {
    name: 'stats',
    description: '记忆库概况：条数、档案数、最后更新时间。',
    inputSchema: { type: 'object', properties: {} },
  },
]

function call(name, args) {
  switch (name) {
    case 'recall': return core.recall(args)
    case 'trace': return core.trace(args)
    case 'remember': return core.remember(args)
    case 'fact_write': return core.factWrite(args)
    case 'decide': return core.decide(args)
    case 'stats': return core.stats()
    default: throw new Error(`unknown tool: ${name}`)
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl = buf.indexOf('\n')
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    nl = buf.indexOf('\n')
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const { id, method, params } = msg
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'memcore', version: '0.1.0' },
      })
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // 通知不需要回复
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS })
    } else if (method === 'tools/call') {
      try {
        const out = call(params?.name, params?.arguments || {})
        reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: `错误：${e.message}` }], isError: true })
      }
    } else if (method === 'ping') {
      reply(id, {})
    } else if (id !== undefined) {
      fail(id, -32601, `method not found: ${method}`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
