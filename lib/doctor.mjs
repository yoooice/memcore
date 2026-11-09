// memcore doctor —— 只读体检。
//
// 回答的是「装上了，但为什么没生效」：
//   · memcore 的数据目录接对了没有（MCP/HTTP/CLI 三种接法都可能接错）
//   · 在 DSH 里用时，插件有没有真正进 dsh.profile.bundles（装载器只看那里）
//   · 搭配的 billion-context 在不在、版本是不是测过的组合
//   · 开场记忆卡最近有没有真的注入
//
// 一个文件都不写；失败只给一条能直接复制的修复命令。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 与 README「已知限制」里的测试矩阵保持一致；改这里要同时改 README。
export const TESTED_BILLION_CONTEXT = ['0.1.212', '0.1.213']
export const MIN_NODE = 20

const mk = (status, label, detail, fix) => ({ status, label, detail, fix })

function exists(p) {
  try { fs.accessSync(p); return true } catch { return false }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
function readText(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}
function readJson(p) {
  const t = readText(p)
  if (t == null) return null
  try { return JSON.parse(t) } catch { return null }
}
function countJsonl(p) {
  const t = readText(p)
  if (!t) return 0
  return t.split('\n').filter((l) => l.trim()).length
}
function lastJsonl(p) {
  const t = readText(p)
  if (!t) return null
  const lines = t.split('\n').filter((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { /* 跳过坏行 */ }
  }
  return null
}
function countMd(dir) {
  if (!isDir(dir)) return 0
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length
  } catch { return 0 }
}
function daysAgo(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(t)) return null
  return Math.round((Date.now() - t) / 86400000)
}

/** 收集检查项，不打印。测试直接调这个。 */
export function collectChecks(opts = {}) {
  const checks = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push(nodeMajor >= MIN_NODE
    ? mk('ok', 'Node 版本', `${process.versions.node}（要求 ≥ ${MIN_NODE}）`)
    : mk('fail', 'Node 版本', `${process.versions.node}，低于要求 ${MIN_NODE}`, '把 Node 升到 20 或更高'))

  // ---- 记忆目录 ----
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dirArg = opts.dir || process.env.MEMCORE_DIR
  let memDir = dirArg ? path.resolve(dirArg) : path.join(os.homedir(), '.memcore')
  let fallbackNote = ''
  if (!dirArg && !isDir(memDir)) {
    // 本机 DSH 插件把数据放在 <DSH_HOME>/memcore；通用接法的默认是 ~/.memcore。
    const dshMem = path.join(dshHome, 'memcore')
    if (isDir(dshMem)) { memDir = dshMem; fallbackNote = '（未设 MEMCORE_DIR，自动用了 DSH 插件的数据目录）' }
  }
  if (!isDir(memDir)) {
    checks.push(mk('warn', '记忆目录', `${memDir} 不存在${fallbackNote}`, '还没有数据：先用 MCP / HTTP / CLI 写几条，或检查 --dir'))
  } else {
    const eps = countJsonl(path.join(memDir, 'episodes.jsonl'))
    const facts = countJsonl(path.join(memDir, 'facts.jsonl'))
    const decs = countJsonl(path.join(memDir, 'decisions.jsonl'))
    const docsDir = opts.docs || process.env.MEMCORE_DOCS || path.join(memDir, 'memory')
    const docs = countMd(docsDir)
    const last = lastJsonl(path.join(memDir, 'episodes.jsonl'))
    const when = last?.t ? new Date(last.t).toLocaleString() : '无'
    const docsNote = docs === 0
      ? `；档案目录 ${docsDir} ${isDir(docsDir) ? '是空的' : '不存在'}（没有档案时正常，--docs 可指向你的笔记目录）`
      : ''
    checks.push(eps > 0
      ? mk('ok', '记忆目录', `${memDir}：${eps} 条原话 / ${facts} 条事实 / ${decs} 条决策 / ${docs} 份档案；最近一条 ${when}${docsNote}${fallbackNote}`)
      : mk('warn', '记忆目录', `${memDir} 存在但没有原话（episodes.jsonl 是空的）${fallbackNote}`, '检查是不是接错了目录；MCP 配置里的 MEMCORE_DIR 要指向有数据的那份'))
    try {
      fs.accessSync(memDir, fs.constants.W_OK)
    } catch {
      checks.push(mk('fail', '目录权限', `${memDir} 存在但不可写`, '检查文件权限、磁盘是否只读，或沙箱是否拦了这个目录'))
    }
  }

  // ---- DSH 插件层（只在这台机器装了 DSH profile 时检查）----
  const profileEnv = process.env.DSH_PROFILE
  const profileDir = opts.profile || process.env.DSH_PROFILE_DIR
    || (profileEnv && profileEnv.includes(path.sep) ? profileEnv : path.join(dshHome, 'profiles', profileEnv || 'desktop'))
  if (!isDir(profileDir)) {
    checks.push(mk('skip', 'DSH 搭配', '没检测到 DSH profile，跳过插件层检查（只用 MCP / HTTP / CLI 的话正常）'))
    return finalize(checks)
  }

  const pkgPath = path.join(profileDir, 'package.json')
  let pkgBuf = null
  try { pkgBuf = fs.readFileSync(pkgPath) } catch { /* 交给下面的分支报 */ }
  const hasBom = !!pkgBuf && pkgBuf.length >= 3 && pkgBuf[0] === 0xEF && pkgBuf[1] === 0xBB && pkgBuf[2] === 0xBF
  const profilePkg = readJson(pkgPath)
  if (!profilePkg) {
    checks.push(mk('fail', 'DSH profile',
      hasBom
        ? `${pkgPath} 开头有 UTF-8 BOM——Node 的 JSON.parse 不剥 BOM，客户端会报 Unexpected token 起不来`
        : `${pkgPath} 读不出来（不是合法 JSON）`,
      hasBom
        ? '去掉文件开头的 3 个字节（EF BB BF）再重启客户端；写文件的工具/编辑器要设成「无 BOM」'
        : '修好 JSON 语法（注意尾逗号、BOM）；pnpm / 编辑器都可能顺手改坏这个文件'))
    return finalize(checks)
  }
  const bundles = profilePkg?.dsh?.profile?.bundles || []
  const nm = path.join(profileDir, 'node_modules')

  const memPkg = readJson(path.join(nm, 'dsh-memcore', 'package.json'))
  if (memPkg && bundles.includes('dsh-memcore')) {
    checks.push(mk('ok', '记忆插件', `dsh-memcore ${memPkg.version} 已装，且在 dsh.profile.bundles 里（装载器会挂上它）`))
  } else if (memPkg) {
    checks.push(mk('fail', '记忆插件', `dsh-memcore ${memPkg.version} 装了，但不在 dsh.profile.bundles —— 装载器根本不会加载它`,
      '在 profile 目录执行：dsh plugin --profile desktop add dsh-memcore'))
  } else {
    checks.push(mk('skip', '记忆插件', '没装 dsh-memcore（只用 MCP / HTTP / CLI 的话正常）'))
  }

  const biliDir = path.join(nm, 'billion-context')
  const biliInstalled = isDir(biliDir)
  const biliInBundles = bundles.includes('billion-context')
  const biliPkg = biliInstalled ? readJson(path.join(biliDir, 'package.json')) : null
  if (!biliInstalled && !biliInBundles) {
    checks.push(mk('skip', '上下文压缩', '没装 billion-context（一次性短任务不需要；多日长会话看 README 的「搭配」一节）'))
  } else if (biliInstalled && !biliInBundles) {
    checks.push(mk('fail', '上下文压缩', `billion-context ${biliPkg?.version || '?'} 在 node_modules 里，但不在 dsh.profile.bundles —— 它的加载器补丁不会生效`,
      '在 profile 目录执行：dsh plugin --profile desktop add billion-context'))
  } else if (!biliInstalled) {
    checks.push(mk('fail', '上下文压缩', 'billion-context 在 bundles 里，但 node_modules 里没有这个包',
      '在 profile 目录执行：pnpm install（或 dsh plugin --profile desktop add billion-context）'))
  } else {
    const v = biliPkg?.version || '?'
    checks.push(TESTED_BILLION_CONTEXT.includes(v)
      ? mk('ok', '上下文压缩', `billion-context ${v}（在测试矩阵 ${TESTED_BILLION_CONTEXT.join(' / ')} 内）`)
      : mk('warn', '上下文压缩', `billion-context ${v} 不在测试矩阵（测过的是 ${TESTED_BILLION_CONTEXT.join(' / ')}）；它通常能用，但坏了先怀疑版本`,
        `要回到测过的组合：pnpm add billion-context@${TESTED_BILLION_CONTEXT[TESTED_BILLION_CONTEXT.length - 1]}`))
  }

  // ---- 运行时痕迹：证明「真的挂上了」----
  const rt = path.join(dshHome, 'memcore')
  const cfg = readJson(path.join(rt, 'config.json'))
  if (cfg) {
    const missing = ['recallScorer', 'openingCardDedup'].filter((k) => cfg[k] === undefined)
    checks.push(missing.length
      ? mk('warn', 'memcore 配置', `${path.join(rt, 'config.json')} 缺 ${missing.join(' / ')}，会走默认值`, '要钉子：补上这两个键（recallScorer: "bm25"，openingCardDedup: true）')
      : mk('ok', 'memcore 配置', `recallScorer=${cfg.recallScorer} / openingCardDedup=${cfg.openingCardDedup}`))
  }

  const opening = readJson(path.join(rt, 'opening-last.json'))
  if (opening?.at) {
    const d = daysAgo(opening.at)
    checks.push(d != null && d <= 7
      ? mk('ok', '开场记忆卡', `最近一次注入 ${new Date(opening.at).toLocaleString()}，${String(opening.text || '').length} 字符`)
      : mk('warn', '开场记忆卡', `最近一次注入在 ${d ?? '?'} 天前——可能是最近没开新会话，也可能注入失败了`, '开一个新会话再看；还不行就查 memcore.log 里的「开场记忆卡已注入」'))
  } else {
    checks.push(mk('skip', '开场记忆卡', '还没有 opening-last.json（刚装、还没开过新会话时会这样）'))
  }

  const log = readText(path.join(rt, 'memcore.log'))
  if (log) {
    const tail = log.split('\n').filter(Boolean).slice(-200).join('\n')
    const mounted = /已挂 agent\/created|工具已注册/.test(tail)
    checks.push(mounted
      ? mk('ok', '挂载日志', 'memcore.log 里能看到挂载 / 工具注册记录')
      : mk('warn', '挂载日志', 'memcore.log 最近 200 行里没有挂载记录', '重启客户端后立刻看 memcore.log；没有记录说明插件没被加载'))
  }

  return finalize(checks)
}

function finalize(checks) {
  const count = (s) => checks.filter((c) => c.status === s).length
  return { checks, ok: count('ok'), warn: count('warn'), fail: count('fail'), skip: count('skip'), hasFail: count('fail') > 0 }
}

const MARK = { ok: '[OK]  ', warn: '[WARN]', fail: '[FAIL]', skip: '[SKIP]' }

export function renderText(result) {
  const lines = ['memcore doctor —— 只读体检（不会改任何文件）', '']
  for (const ch of result.checks) {
    lines.push(`${MARK[ch.status]} ${ch.label}：${ch.detail}`)
    if (ch.fix) lines.push(`        → ${ch.fix}`)
  }
  lines.push('', `结果：${result.ok} 通过 / ${result.warn} 警告 / ${result.fail} 失败 / ${result.skip} 跳过`)
  if (result.fail) lines.push('先修失败项（那是「装了但没生效」），再重跑 doctor。')
  return lines.join('\n')
}

/** 打印并返回退出码：有失败项 → 1。 */
export function runDoctor(opts = {}) {
  const result = collectChecks(opts)
  if (opts.json) console.log(JSON.stringify(result, null, 2))
  else console.log(renderText(result))
  return result.hasFail ? 1 : 0
}
