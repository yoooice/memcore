# memcore

[English](README.en.md) | 中文

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

## 安装

要求 **Node ≥ 20**，无第三方依赖（`package.json` 里 `dependencies` 是空的，全部用 Node 内置模块）。

```bash
git clone https://github.com/yoooice/memcore && cd memcore
node cli.mjs stats
```

数据目录默认 `~/.memcore`，可用 `--dir` 或环境变量 `MEMCORE_DIR` 指定；档案目录用 `--docs` / `MEMCORE_DOCS`（默认 `<dir>/memory`）。

## 搭配上下文压缩（可选，但长会话推荐）

memcore 解决「记得住」，不解决「装得下」。单会话越跑越长时，先撞墙的是上下文窗口和账单——那是另一件事，交给上下文压缩插件，比如 [billion-context](https://github.com/ranxianglei/billion-context)（MIT）。两者分工不重叠：

| | 管什么 | 数据在哪 |
| --- | --- | --- |
| memcore | 历史上说过什么（原话 / 事实 / 决策 / 档案） | 本机 `episodes.jsonl`、`memory/*.md` |
| billion-context | 这一轮模型能看见多少（折叠旧上下文） | 只改发给模型的请求，不碰记忆文件 |

作者在 DSH 上的实测（单机、单会话，样本数 1，别当通用结论）：一场 288 次请求的会话累计输入 21.2M token，缓存命中 97.1%，11 次折叠净省 30.4M；被折叠掉的段落，原文仍能用 `recall` 按原句召回——**压缩的是上下文，不是档案**。

### 什么时候不需要

- 一次性短任务、单会话不到 100K token：别装。多一个插件、多一层补丁，换不来收益。
- 多日会话、单场几十万 token 以上、经常撞上下文上限：这时值得。

### 安装（DSH）

在 profile 目录下：

```bash
dsh plugin --profile desktop add dsh-memcore
dsh plugin --profile desktop add billion-context@0.1.213
```

第二行的版本是**测过的组合**；不带版本会拿到上游最新版，通常也能用，但出问题先怀疑版本。

没有 `dsh` 命令时：在 profile 的 `package.json` 里把 `dsh-memcore` 和 `billion-context` 加进 `dsh.profile.bundles`，再在 profile 目录执行 `pnpm install`。少这一步，包在 `node_modules` 里也不会被加载——`doctor` 会把这种「半装」标成失败。

### 装完自检

```bash
node cli.mjs doctor
```

只读检查：数据目录对不对、插件有没有真的进 `dsh.profile.bundles`（装了但没进 = 不会被加载，这是最常见的「装了没用」）、billion-context 版本在不在测试矩阵、开场卡最近有没有注入。每项失败都给一条可直接复制的修复命令；**不会改任何文件**。

### 已知限制

- billion-context 的 DSH 集成是一层**加载器补丁**（改 preset 注入、关掉 `compaction-basic`、给 `llm-deepseek` 补重试码），与 DSH 版本强相关。测试矩阵：DSH `0.2.2-rc.1` × billion-context `0.1.212` / `0.1.213`。
- DSH 升级后如果出现 `agent-preset/invalid`、会话建不起来，先把 billion-context 从 bundles 里移除再排查——它的补丁层是第一个嫌疑人。
- 责任边界：压缩行为、工具、补丁层归 billion-context 上游；记忆、检索、开场卡归 memcore。压缩出问题去上游开 issue，别在两个仓库之间来回猜。

## 三种接法

### 1. MCP（Claude Desktop / Cursor / Windsurf / 任何 MCP 客户端）

```json
{
  "mcpServers": {
    "memcore": {
      "command": "node",
      "args": ["D:/path/to/memcore/mcp.mjs"],
      "env": { "MEMCORE_DIR": "C:/Users/you/.memcore", "MEMCORE_DOCS": "C:/Users/you/notes" }
    }
  }
}
```

工具：`recall`、`trace`、`remember`、`fact_write`、`decide`、`stats`。完整样例见 `examples/mcp-config.json`。

### 2. HTTP（任何语言、任何模型、任何 Agent）

```bash
node server.mjs --port 7474
```

```bash
curl "http://127.0.0.1:7474/api/recall?q=窗口闪烁&limit=5"
curl -X POST http://127.0.0.1:7474/api/fact -H 'content-type: application/json' \
  -d '{"subject":"dsh-context-rotate","aliases":["轮转式插件"],"note":"上下文轮转插件"}'
```

浏览器打开 `http://127.0.0.1:7474/` 就是 UI：检索、置信度横幅、事实 chips、决策台账、档案浏览。
如果你要把 memcore 塞进自己的模型调用，推荐直接把 `recall` 的返回拼进 system prompt：

```js
const mem = await (await fetch('http://127.0.0.1:7474/api/recall?q=' + encodeURIComponent(question))).json()
if (mem.confidence?.weak) return askBack(mem.confidence.ask)   // 先反问，别硬答
const context = mem.items.map((it) => `[${it.at}] ${it.role}: ${it.text}`).join('\n')
```

### 3. CLI

```bash
node cli.mjs recall "上次那个 zstd 的事"
node cli.mjs trace "压缩包"
node cli.mjs fact --subject dsh-workbench --aliases "工作台" --note "客户端看板插件"
node cli.mjs decide --decision "检索不到先反问" --reason "硬猜一次比问一句贵"
node cli.mjs doctor
node cli.mjs serve
```

### 4. DSH 客户端面板（可选）

`adapters/dsh-panel/` 是 DSH（DeepSeek Harness）的侧栏面板：同进程加载同一份内核，不另起端口，
左栏出现「记忆核心」入口，四页：检索 / 事实层 / 决策台账 / 档案。安装见 `adapters/dsh-panel/README.md`。
面板只是外壳，删掉它不影响上面三种接法。

## 结构

```
lib/bm25.mjs    切词与打分（可单独用）
lib/core.mjs    内核：recall / trace / remember / factWrite / decide / stats / listMemory
lib/doctor.mjs  只读体检（cli.mjs doctor）
mcp.mjs         MCP stdio 服务（6 个工具）
server.mjs      HTTP 服务 + 静态 UI
cli.mjs         命令行
ui/index.html   网页（顶部标签版）
ui/sidebar.html 网页（侧栏版）
examples/       demo.mjs / mcp-config.json / curl.sh
tests/          单元测试（node --test，无依赖）
eval/           评测脚手架 run.mjs + 合成样本
adapters/dsh-panel/   DSH 客户端面板（可选）
```

数据（都在 `--dir` 下）：

```
episodes.jsonl  原话（t 时间 / r 角色 / x 正文 / s 会话）
facts.jsonl     事实层（subject + aliases + note + 可选有效期）
decisions.jsonl 决策台账（decision + reason + evidence + alternatives）
memory/*.md     档案正文（人可读，也参与检索）
```

## 评测（可复跑）

```bash
node --test tests/*.test.mjs                    # 9/9：功能 + 三条回归（缓存、串会话、过期事实）
node eval/run.mjs --verbose                     # 合成样本：格式与流程演示
node eval/run.mjs --corpus 你的语料.json --queries 你的问题.json
```

**说明**：下表数字来自作者自己的私有语料（真实对话与档案，含个人信息，不能公开），题与金标不在仓库里。
仓库带的是评测脚手架 `eval/run.mjs` 和一份**合成样本**（10 条文档、8 道题，Top1 6/8），
用来证明格式与流程可跑；想验证效果请换成自己的语料。

| 集合 | 题目 | 结果 |
| --- | --- | --- |
| 会话原话 | 20 题（15 近原话 / 5 改写） | 严格 Top1 **18/20**、宽松 18/20 |
| 档案 | 23 题（问「哪个文件」） | Top1 **20/23**、Top3 22/23 |
| 事实层 | 6 条别名桥 | **19/20**（同一 20 题集） |
| 决策台账 | 7 道「为什么这么定」 | **7/7** |

同一个语料上对照过：纯语义模型 8/20、语义+BM25 加权 18/20、RRF 18/20、grep 词面基线 15/20。
**不挂向量库是结论，不是省事**——详见下一节。

## 设计取舍

- **不建向量库**：中文短消息上余弦分挤在一起（0.5–0.7），语义模型把「轮转」和 `rotate` 连不上，
  但会把「顺带提到」的段落排上来。实测档案级 23 题 BM25 20/23、加语义混合也是 20/23，多花 118 MB 买不到稳定收益。
- **不调分，改写入**：重排、RRF、查询剪枝、词共现扩展都试过，20 题上没有一个超过基线；
  唯一有效的是把「同一件事的两种说法」在学到时写进事实层（19/20）。
- **弱命中先反问**：词覆盖 < 30% 或分差 < 1.2 倍时返回 `weak: true` 和反问方向。
  阈值是扫出来的：`cov<0.6` 会误伤 10/20，`margin<1.5` 误伤 5/20，选 0.3/1.2 时误伤 1、抓住 2 道错题。
- **元记录封顶**：我复述问题的那条记录，分数压到「最佳正常记录 × 0.99」以下——因为每验证一次，
  这条自指记录就更像答案，是递归污染。
- **中文切词**：`Intl.Segmenter` 整词 + 连续段二元组。消融过：逐字单字 17/23，整词+全字符二元组 20/23。

## 已知短板

- **纯改写题**：「轮转的插件」这类需要知道别名才搜得到；事实层能补，但要有人写进去。
- **自我污染**：我在对话里分析某个问题的那段话，比用户原话更像答案；已有元记录封顶，但挡不住全部。
- **样本小**：20/23 题都是单人造的，不能当泛化结论；语料一换数字会动。
- **无权限隔离**：所有记忆一个闸门，多用户场景要自己加。
- **图检索没做**：试过按档案共现建图 + 一跳扩散，23 题上没有增益（17/23），只保留为浏览用的 `graph.md`。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 声明

本项目是个人项目，**与 DeepSeek 官方没有任何关联**，也未获其背书。

卫衣上的鲸鱼剪影、以及本项目用到的「大肥鱼」等说法，均指代 DeepSeek 的公开形象与社区昵称，
仅作标识与致敬使用，不表示任何官方身份或授权关系。
