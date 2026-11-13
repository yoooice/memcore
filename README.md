# memcore

**本地长期记忆层，给任何模型接一层「会检索、会反问、会自我纠错」的记忆。**
零依赖、零服务端、数据只在本机。中文优先。

```bash
node examples/demo.mjs      # 30 秒看它怎么工作，不写你的任何数据
```

```
问：窗口老是闪是什么原因
  [7.26] 用户  2026-11-04 02:54:11  现在窗口每个一段时间自动闪烁一次是什么问题？…

问：上次那个部署脚本为什么改绝对路径
  [7.33] 用户  2026-11-06 02:54:11  帮我把部署脚本改成用绝对路径，不要再依赖 PATH 里的 powershell。…
  [5.23] 档案  2026-11-07 02:54:11  # 部署
                                  计划任务里的脚本一律写绝对路径：C:/Windows/System32/WindowsPowerShell/…
```

---

## 先选一块，不用全装

这个仓库是一套生态，不是一个大包。**装你用的那块就行**，四块互相独立。

| 你想干什么 | 装这个 | 得到什么 | 不需要什么 |
|---|---|---|---|
| 给自己的 Agent 接记忆（任意语言/模型） | [`packages/core`](packages/core) | recall / trace / remember / fact / decide / stats，MCP / HTTP / CLI 三种接法 | DSH、面板、策展 |
| 在 DSH 里每轮自动注入 + 工具 | [`packages/dsh-plugin`](packages/dsh-plugin) | 每轮线索、档案索引、开场卡，8 个工具 | 面板、策展 |
| 只要侧栏看记忆 | [`packages/dsh-panel`](packages/dsh-panel) | 检索 / 事实层 / 决策台账 / 档案四页 | 自动注入 |
| 每天自动提炼候选 | [`packages/pipeline`](packages/pipeline) | candidates + 自动初审 + 评测提醒 | 其他全部 |

只想最快跑起来：

```bash
node packages/core/cli.mjs stats
node packages/core/cli.mjs recall "上次那个部署脚本"
```

---

## 它解决什么

大多数「AI 记忆」要么把一切塞进上下文（贵、越来越慢），要么上向量库（100+ MB、冷启动、中文短句分不开）。
memcore 走第三条路：**分词 + 打分 + 写入侧结构化**，把力气花在「让答案进得了语料」而不是「把分数调好看」。

| 能力 | 说明 |
| --- | --- |
| 原话检索 | 谁在什么时候说了什么，BM25 + 中文整词/二元组切词，14 天半衰 |
| 事实层 | `facts.jsonl` 记「正名 → 别名」，解决「换个说法搜不到」（「轮转的插件」→ `context-rotate`） |
| 决策台账 | `decisions.jsonl` 记决定 + 理由 + 证据；问「为什么这么定」直接命中，不靠翻聊天记录 |
| 档案 | `memory/*.md` 人可读，同时参与检索（「宪法六条底线」能直接命中文档） |
| 会反问 | 返回 `confidence`（覆盖率/分差）；命中不牢时给 `weak: true` + 三个反问方向，不硬猜 |
| 自我纠错 | 「我自己复述这个问题」的记录会被识别并封顶，排在真正写了答案的记录之后 |
| 可自证 | 评测脚手架 + 数字 + 已知短板清单，不是"感觉变好了" |

---

## 三种接法（都不需要 DSH）

要求 **Node ≥ 20**，无第三方依赖（`package.json` 里 `dependencies` 是空的，全部用 Node 内置模块）。

数据目录默认 `~/.memcore`，可用 `--dir` 或环境变量 `MEMCORE_DIR` 指定；档案目录用 `--docs` / `MEMCORE_DOCS`（默认 `<dir>/memory`）。

### 1. CLI

```bash
node packages/core/cli.mjs recall "上次那个 zstd 的事"
node packages/core/cli.mjs trace "压缩包"
node packages/core/cli.mjs fact --subject dsh-workbench --aliases "工作台" --note "客户端看板插件"
node packages/core/cli.mjs decide --decision "检索不到先反问" --reason "硬猜一次比问一句贵"
node packages/core/cli.mjs doctor
node packages/core/cli.mjs serve
```

### 2. MCP（Claude Desktop / Cursor / Windsurf / 任何 MCP 客户端）

```json
{
  "mcpServers": {
    "memcore": {
      "command": "node",
      "args": ["D:/path/to/memcore/packages/core/mcp.mjs"],
      "env": { "MEMCORE_DIR": "C:/Users/you/.memcore", "MEMCORE_DOCS": "C:/Users/you/notes" }
    }
  }
}
```

工具：`recall`、`trace`、`remember`、`fact_write`、`decide`、`stats`。完整样例见 `examples/mcp-config.json`。

### 3. HTTP（任何语言、任何模型、任何 Agent）

```bash
node packages/core/server.mjs --port 7474
```

```bash
curl "http://127.0.0.1:7474/api/recall?q=窗口闪烁&limit=5"
curl -X POST http://127.0.0.1:7474/api/fact -H 'content-type: application/json' \
  -d '{"subject":"dsh-context-rotate","aliases":["轮转式插件"],"note":"上下文轮转插件"}'
```

浏览器打开 `http://127.0.0.1:7474/` 就是 UI：检索、置信度横幅、事实 chips、决策台账、档案浏览。

要把 memcore 塞进自己的模型调用，推荐直接把 `recall` 的返回拼进 system prompt：

```js
const mem = await (await fetch('http://127.0.0.1:7474/api/recall?q=' + encodeURIComponent(question))).json()
if (mem.confidence?.weak) return askBack(mem.confidence.ask)   // 先反问，别硬答
const context = mem.items.map((it) => `[${it.at}] ${it.role}: ${it.text}`).join('\n')
```

---

## 可选的另外三块

### DSH 插件（`packages/dsh-plugin`）

在 DeepSeek Harness 里，把记忆做成「每轮自动注入 + 工具」：线索、档案索引、开场卡、8 个工具。
它依赖 `index.js` 的 DSH 插件接口（`sp.context` / `sp.section` / `inject`），**只在 DSH 里有意义**。
安装见 `packages/dsh-plugin/README.md`。

### DSH 面板（`packages/dsh-panel`）

侧栏一级入口，四页：检索 / 事实层 / 决策台账 / 档案。同进程读同一份数据，不另起端口。
面板只是外壳，删掉不影响其他三种接法。

### 策展流水线（`packages/pipeline`）

`consolidate` 扫新增证据挑候选 → `review` 自动初审 → `autofacts` 管事实层权重 →
`route` 把查询映射到档案 → `eval-watch` 提醒跑评测。
不装也能用内核；装了才有「每天自动整理」。

---

## 搭配上下文压缩（可选，但长会话推荐）

memcore 解决「记得住」，不解决「装得下」。单会话越跑越长时，先撞墙的是上下文窗口和账单——那是另一件事，交给上下文压缩插件，比如 [billion-context](https://github.com/ranxianglei/billion-context)（MIT）。两者分工不重叠：

| | 管什么 | 数据在哪 |
|---|---|---|
| memcore | 历史上说过什么（原话 / 事实 / 决策 / 档案） | 本机 `episodes.jsonl`、`memory/*.md` |
| billion-context | 这一轮模型能看见多少（折叠旧上下文） | 只改发给模型的请求，不碰记忆文件 |

作者在 DSH 上的实测（单机、单会话，样本数 1，别当通用结论）：一场 288 次请求的会话累计输入 21.2M token，缓存命中 97.1%，11 次折叠净省 30.4M；被折叠掉的段落，原文仍能用 `recall` 按原句召回——**压缩的是上下文，不是档案**。

### 什么时候不需要

- 一次性短任务、单会话不到 100K token：别装。多一个插件、多一层补丁，换不来收益。
- 多日会话、单场几十万 token 以上、经常撞上下文上限：这时值得。

---

## 结构

```
packages/
  core/           内核 + CLI + MCP + HTTP + 网页 UI
    lib/bm25.mjs    切词与打分（可单独用）
    lib/core.mjs    内核：recall / trace / remember / factWrite / decide / stats / listMemory
    lib/doctor.mjs  只读体检
    cli.mjs         命令行
    mcp.mjs         MCP stdio 服务（6 个工具）
    server.mjs      HTTP 服务 + 静态 UI
    ui/             网页（顶部标签版 / 侧栏版）
  dsh-plugin/     DSH 插件壳（自动注入 + 8 个工具）
  dsh-panel/      DSH 侧栏面板（可选）
  pipeline/       策展流水线（可选）
eval/             评测脚手架（开发用）
examples/         demo / MCP 配置 / curl
tests/            单元测试（node --test，无依赖）
```

数据（都在 `--dir` 下）：

```
episodes.jsonl  原话（t 时间 / r 角色 / x 正文 / s 会话）
facts.jsonl     事实层（subject + aliases + note + 可选有效期）
decisions.jsonl 决策台账（decision + reason + evidence）
memory/*.md     人可读档案，同时参与检索
```

---

## 已知限制

- DSH 插件壳与 DSH 版本强绑定（`sp.context` / `sp.section` / `inject`），升级后先怀疑它和上下文压缩插件的补丁层。
- 检索是词面 + 中文分词，不是语义；同义改写要靠事实层（`fact_write`）补。
- 评测数字是在作者自己的语料上跑的，样本小，别当通用结论。

## 许可证

MIT
