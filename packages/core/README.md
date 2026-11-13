# memcore-memory（core）

memcore 的内核包：检索、事实层、决策台账、档案，三种接法（CLI / MCP / HTTP），零依赖。

**你不需要**：DSH、侧栏面板、策展流水线。这个包单独就能用。

## 快速开始

```bash
node cli.mjs stats
node cli.mjs recall "上次那个部署脚本"
node cli.mjs doctor
node cli.mjs serve          # 起 HTTP + 网页 UI，默认 7474
node mcp.mjs                # 给 MCP 客户端的 stdio 入口
```

数据目录默认 `~/.memcore`，用 `--dir` 或 `MEMCORE_DIR` 指定；档案目录用 `--docs` / `MEMCORE_DOCS`。

## 它提供什么

| 文件 | 作用 |
|---|---|
| `lib/bm25.mjs` | 中文整词 + 二元组切词，BM25 打分，可单独引用 |
| `lib/core.mjs` | `createCore()`：recall / trace / remember / factWrite / decide / stats / listMemory |
| `lib/doctor.mjs` | 只读体检：数据目录接对没、插件进 bundles 没、版本在不在矩阵 |
| `cli.mjs` | 命令行 |
| `mcp.mjs` | MCP stdio 服务（6 个工具） |
| `server.mjs` | HTTP JSON API + 静态 UI |
| `ui/` | 网页（顶部标签版 / 侧栏版） |

## 数据格式

```
episodes.jsonl  原话（t / r / x / s）
facts.jsonl     事实层（subject + aliases + note）
decisions.jsonl 决策台账（decision + reason + evidence）
memory/*.md     人可读档案，同时参与检索
```

与 DSH 插件版共用同一套格式，所以两边可以接同一个数据目录。
