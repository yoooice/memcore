/**
 * 「项目档案」层：memory/ 的索引表 → 一段注入文本，外加一个写入口。
 *
 * 为什么要有这一层：engramory 的机制价值只有一条——每轮把索引塞进上下文。
 * 那条能力 memcore 自己能做（它已经在注入 cues），所以索引由 memcore 注入，
 * 策展内容仍然是人可读的 md 文件，不搬进数据库、不复制副本。
 *
 * 纯文件操作，不碰宿主 API；可以单独 node 跑，方便验证。
 */
import fs from 'node:fs'
import path from 'node:path'

const TABLE_ROW = /^\|\s*`([^`]+\.md)`\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/
const HEADER = '| 文件 | 内容 | 什么时候读 |\n|---|---|---|'

/** 去掉 markdown 强调符号，注入里不想要装饰。 */
function plain(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function statMtime(dir, file) {
  try {
    return fs.statSync(path.join(dir, file)).mtimeMs
  } catch {
    return 0
  }
}

/** 读 index.md 的档案表。返回 { exists, raw, rows }。 */
export function readIndex(dir) {
  const file = path.join(dir, 'index.md')
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { exists: false, raw: '', rows: [] }
  }
  const rows = []
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(TABLE_ROW)
    if (!m) continue
    const name = m[1].trim()
    if (!name || name === 'index.md') continue
    rows.push({ file: name, summary: plain(m[2]), when: plain(m[3]), line })
  }
  return { exists: true, raw, rows }
}

/**
 * 注入文本：只有「最近改动的 N 个档案 + 一句话摘要」。
 * 给全部档案没有意义——索引越长，每轮付的税越多。
 */
export function buildArchives(dir, opts = {}) {
  const count = Math.max(1, Number(opts.count) || 3)
  const maxChars = Math.max(120, Number(opts.maxChars) || 420)
  const { rows } = readIndex(dir)
  if (!rows.length) return ''
  const sorted = rows
    .map((row) => ({ ...row, mtime: statMtime(dir, row.file) }))
    .sort((a, b) => b.mtime - a.mtime)
  const lines = sorted.slice(0, count).map((row) => `· ${row.file} — ${row.summary || '(无摘要)'}`)
  const text = [
    `【项目档案】memory/ 共 ${rows.length} 个档案（按最近改动；只有索引，内容要了再读）：`,
    ...lines,
    '要细节读 memory/<文件>，别在对话里复述全文。',
  ].join('\n')
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** 拒绝 `../` 和绝对路径：这个工具只写 memory/ 下面的 md。 */
function safeName(file) {
  const name = String(file || '').trim().replace(/\\/g, '/')
  if (!name) return null
  if (name.includes('..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  if (!name.endsWith('.md')) return name + '.md'
  return name
}

/**
 * 写入口：一个地方管「档案文件 + 索引表行」。
 * - 文件不存在且给了 title → 建一个只有标题和一句话的骨架
 * - 索引里有这行 → 更新摘要/阅读时机
 * - 没有这行 → 补到表尾
 * - 给了 note → 追加一条带日期的要点
 */
export function remember(dir, args = {}) {
  const name = safeName(args.file || args.slug || '')
  if (!name) return { ok: false, error: 'file 必填，且只能是 memory/ 下的 .md 文件名' }
  const summary = plain(args.summary)
  const when = plain(args.when)
  const note = String(args.note || '').trim()
  const abs = path.join(dir, name)

  let created = false
  if (!fs.existsSync(abs)) {
    if (!summary && !args.title) return { ok: false, error: `档案 ${name} 不存在；新建要给 title 或 summary` }
    const head = `# ${String(args.title || name.replace(/\.md$/, '')).trim()}\n\n> ${summary || '(待补)'}\n`
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, head, 'utf8')
    created = true
  }

  if (note) {
    const stamp = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(abs, `\n- ${stamp} ${note}\n`, 'utf8')
  }

  const idxFile = path.join(dir, 'index.md')
  const { exists, raw, rows } = readIndex(dir)
  let next = raw
  if (!exists) {
    next = `# 记忆索引\n\n${HEADER}\n| \`${name}\` | ${summary || '(待补)'} | ${when || '相关时'} |\n`
  } else if (rows.some((row) => row.file === name)) {
    next = raw.split(/\r?\n/).map((line) => {
      const m = line.match(TABLE_ROW)
      if (!m || m[1].trim() !== name) return line
      const nextSummary = summary || plain(m[2])
      const nextWhen = when || plain(m[3])
      return `| \`${name}\` | ${nextSummary} | ${nextWhen} |`
    }).join('\n')
  } else {
    const newRow = `| \`${name}\` | ${summary || '(待补)'} | ${when || '相关时'} |`
    const lines = raw.split(/\r?\n/)
    let lastRow = -1
    for (let i = 0; i < lines.length; i += 1) {
      if (TABLE_ROW.test(lines[i])) lastRow = i
    }
    if (lastRow >= 0) lines.splice(lastRow + 1, 0, newRow)
    else lines.push('', HEADER, newRow)
    next = lines.join('\n')
  }

  if (next !== raw) fs.writeFileSync(idxFile, next, 'utf8')
  // 只回有值的字段：undefined 会让工具返回值不再是「无损 JSON」，宿主直接报错
  const out = { ok: true, file: name, created, indexUpdated: next !== raw }
  if (summary) out.summary = summary
  if (when) out.when = when
  if (note) out.note = note
  return out
}
