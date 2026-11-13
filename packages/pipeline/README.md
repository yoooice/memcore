# memcore-pipeline（策展流水线）

memcore 的可选整理层：候选提炼、自动初审、事实层权重、查询路由、评测提醒。

**你不需要**：如果只用「检索原话」，不装这个也完全够用。

## 五个脚本

| 脚本 | 干什么 | 输出 |
|---|---|---|
| `consolidate.mjs` | 扫新增证据，挑「可能值得进 memory/」的候选 | `candidates/YYYY-MM-DD.md` |
| `review.mjs` | 对候选做机械初审，能判的直接判，留真正需要人的 | 同上文件的状态标记 |
| `autofacts.mjs` | 事实层原型 + 遗忘曲线权重 | `auto-facts.jsonl` |
| `route.mjs` | 查询词 → `memory/` 档案，不读正文 | stdout |
| `eval-watch.mjs` | episodes 翻倍时写 `eval-due.json` 提醒跑评测 | `~/.dsh/memcore/eval-due.json` |

## 用法

```bash
node consolidate.mjs
node review.mjs
node autofacts.mjs tick
node route.mjs 夜班沙箱
node eval-watch.mjs
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMCORE_DIR` | `~/.dsh/memcore` | 证据/候选/状态文件目录 |
| `MEMCORE_MEMORY` | `D:/Deepseek-Core/Work/memory`（脚本内默认，建议覆盖） | 档案目录 |
| `MEMCORE_WORK` | 空 | 若设置，`consolidate` 用它拼 `memcore/` 路径 |

## 挂到 DSH 插件

在 `packages/dsh-plugin` 的 `DEFAULTS.dailyScripts` 里把对应项 `enabled` 改成 `true`，并把 `path` 指到本目录。
公共版默认全部关闭，避免陌生人装完就被写一堆文件。
