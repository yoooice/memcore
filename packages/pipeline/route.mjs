// route.mjs — 回忆先路由：把查询词映射到 memory/ 档案，不读正文。
// 用法：node cli.mjs route 夜班沙箱
import fs from 'node:fs'
import path from 'node:path'

const MEMORY = process.env.MEMCORE_MEMORY || 'D:/Deepseek-Core/Work/memory'
const TABLE = path.join(MEMORY, 'route.json')

function load() {
  const raw = JSON.parse(fs.readFileSync(TABLE, 'utf8'))
  return Array.isArray(raw?.archives) ? raw.archives : []
}

/** 词长权重：2 字=1、3 字=1.5、4 字=2、5 字以上=2.5。 */
function weight(word) {
  const n = [...word].length
  if (n <= 2) return 1
  if (n === 3) return 1.5
  if (n === 4) return 2
  return 2.5
}

export function route(query) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: '空查询：给一个词，例如 route 夜班沙箱' }

  const archives = load()
  const ranked = []
  for (const a of archives) {
    const hits = []
    let total = 0
    for (const kw of a.keywords || []) {
      // 同一个词最多按两次算（「记忆 记忆」不翻倍）
      let count = 0
      let from = 0
      while (count < 2) {
        const i = q.toLowerCase().indexOf(kw.toLowerCase(), from)
        if (i < 0) break
        count += 1
        from = i + kw.length
      }
      if (!count) continue
      hits.push(kw)
      total += weight(kw) * count
    }
    if (!total) continue
    const file = path.join(MEMORY, a.file)
    let bytes = 0
    try { bytes = fs.statSync(file).size } catch { bytes = 0 }
    if (!bytes) continue // 表里有但文件不在（重建/删档）就不推
    ranked.push({ file: a.file, summary: a.summary || '', bytes, hits, total })
  }
  ranked.sort((x, y) => y.total - x.total || y.hits.length - x.hits.length)
  return { ok: true, ranked: ranked.slice(0, 3) }
}
